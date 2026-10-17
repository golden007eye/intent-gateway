// The fake Intent Cloud: an HTTP server on 127.0.0.1 that plays both the edge (body cap, request limit, appendix-C
// signature check, receipts on every response) and the platform behind it (catalog, carts, approvals, proofs).
// It follows contract/gateway-api.v1.yaml and appendices A–G, and the real platform's observable behaviour where the
// contract leaves room (error codes and messages, 404/405, quotas per address key, idempotency, proof issue time),
// so the fake, demo mode and staging answer alike. The confirm page is driven through `approveWithPasskey` and `reject`.
//
// Versions (contract 1.6.0 §V1): a request with `Intent-Contract-Version: 1.6.0` is answered as 1.6.0 (v2 snapshots,
// the completer key, outcomes, outcome reports); one without the header as 1.5.0, byte for byte, with the 1.5.0 sums.
// `versions: ["1.5.0"]` makes a host that predates 1.6.0 and ignores the header.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AnySnapshot,
  type ApprovalCreated,
  type ApprovalProof,
  type ApprovalState,
  type ApprovalStatus,
  type Cart,
  CartHandle,
  type CompletionMode,
  type CredentialPublicKey,
  ApprovalHandle,
  CartRequest,
  checkoutRefHash,
  CONTRACT_VERSION,
  type KeyStatement,
  type Offer,
  type Outcome as CloudOutcome,
  OutcomeReport,
  type OutcomeState,
  type ReceiptRequest as ReceiptRequestType,
  ReceiptRequest,
  SearchRequest,
  type ShipTo,
  type Snapshot,
  type SnapshotV2,
  type WebAuthnAssertion,
} from "../contract/index.ts";
import { canonicalize, nonIntegerToken, sha256Hex } from "../jcs/index.ts";
import { contentDigest, createNonceCache, verifyRequest } from "../signing/index.ts";
import { type CatalogItem, DEFAULT_CATALOG, searchCatalog } from "./catalog.ts";
import {
  APPROVAL_PREFIX,
  CONFIRM_ORIGIN,
  loadKeys,
  makeStatement,
  randomKey,
  RECEIPT_PREFIX,
  RP_ID,
  timestamp,
} from "./keys.ts";
import { type Action, type AssertOptions, assertionProblem, challengeFor, SoftPasskey } from "./passkey.ts";

/** The edge's body cap (spec `info.description`). */
export const MAX_BODY_BYTES = 16 * 1024;
const OFFER_TTL = 30 * 60;
const CART_TTL = 15 * 60;
const APPROVAL_TTL = 15 * 60;
const REPLAY_WINDOW = 10 * 60;
const PASSKEY_TIER_WINDOW = 86_400;
const RULE_VERSION = "recheck-v1";
/** Completer-signed reads end this long after the later of `expires_at` and a terminal outcome (Appendix G R7). */
const COMPLETER_WINDOW = 48 * 3600;

/** The versions a host can serve; the vendored copy is CONTRACT_VERSION (1.6.0). */
export type ServedVersion = "1.5.0" | "1.6.0";
/** The released 1.5.0 `SHA256SUMS` sha256 (contract/SOURCE.md), which a header-less request is answered with. */
export const SUMS_1_5_0 = "c6fc6ffea8b7cb9053a74e0a3aa340d73d1c2800fcc4c47669707400d06410d2";
const TERMINAL: ReadonlySet<OutcomeState> = new Set(["ordered", "mismatch", "failed", "checkout_expired"]);
/** What an `ordered` or `mismatch` report must carry (Appendix G), and what R5 keeps of it under `reported`. */
const ORDER_KEYS = ["order_ref", "final_total", "binding"] as const;
const REPORTED_KEYS = ["state", "source", ...ORDER_KEYS] as const;

/** `ApprovalStatus.state` for an outcome (Appendix G, vector o3): 1.6.0 and the 1.5.0 downgrade (null: not served). */
export function statusState(outcome: OutcomeState, mode: CompletionMode): { "1.6.0": ApprovalState; "1.5.0": ApprovalState | null } {
  if (outcome === "ordered") return { "1.6.0": "ordered", "1.5.0": mode === "handoff" ? "ordered" : null };
  return mode === "handoff" ? { "1.6.0": "handed_off", "1.5.0": "handed_off" } : { "1.6.0": "approved", "1.5.0": null };
}

export interface Quotas {
  /** Edge requests per minute per address key (any endpoint). */
  requests_per_minute: number;
  /** New carts per hour per address key (IPv4 address or IPv6 /64). */
  carts_per_hour: number;
  /** New carts per hour per address key when a cart from that key got a passkey-approved approval in the last 24 h. */
  carts_per_hour_passkey: number;
  /** New approvals per day per address key. */
  approvals_per_day: number;
}

export const DEFAULT_QUOTAS: Quotas = Object.freeze({
  requests_per_minute: 120,
  carts_per_hour: 10,
  carts_per_hour_passkey: 50,
  approvals_per_day: 20,
});

export interface FakeCloudOptions {
  /** Default 0 (any free port). */
  port?: number;
  /** The fake's clock in milliseconds, like Date.now (the default). */
  now?: () => number;
  catalog?: readonly CatalogItem[];
  /**
   * Categories whose items search never returns, as Intent Cloud never returns excluded ones (demo mode passes the
   * excluded categories). Default none, so tests can show the gateway's own baseline refusing such an item too.
   */
  excludedCategories?: readonly string[];
  quotas?: Partial<Quotas>;
  /** The contract versions served. Default both; `["1.5.0"]` is a host from before 1.6.0 that ignores the header. */
  versions?: readonly ServedVersion[];
  /** Whether `shop_agent` carts are enabled (Intent Cloud's ONE_TAP_GATEWAY_ENABLED). Default false. */
  oneTap?: boolean;
}

/** What a confirm-page or merchant action did. `status` is what the confirm page or merchant would answer. */
export interface Outcome {
  status: 200 | 400 | 404 | 409 | 410;
  state?: ApprovalState;
  reason?: string;
  /** handoff: the merchant checkout the confirm page redirects to. */
  continueUrl?: string;
  /** order: the merchant's order number. */
  orderNumber?: string;
}

export interface ApprovalRecordView {
  state: ApprovalState;
  /** The `sub` of the passkey account that made the first decision. */
  claimed_by?: string;
  ledger?: { seq: number; entry_hash: string };
  snapshot: AnySnapshot;
  snapshot_hash: string;
  /** The key statement's confirm_origin + approval_link_path. */
  approval_link: string;
  /** 1.6.0: the outcome once the approval is past `approved`. */
  outcome?: CloudOutcome;
  /** 1.6.0: the bodies of the outcome reports accepted (or replayed), in order. */
  reports: OutcomeReport[];
}

/** Faults for attack tests. Each stays on until `reset`; an optional path limits a receipt fault to that path. */
export interface Tamper {
  /** Receipts carry a well-formed signature over other bytes. */
  receiptSignature(path?: string): void;
  /** Receipts are correctly signed but name another body's content digest. */
  receiptDigest(path?: string): void;
  /** 2xx responses keep `Intent-Contract-Version` but carry no receipt. */
  dropReceipt(path?: string): void;
  /** Proofs are correctly cloud-signed but their `snapshot_hash` is not the snapshot's hash. */
  proofHash(): void;
  /** Proofs are signed by a key the statement does not list (`cloud-approval-209912`). */
  proofUnknownKid(): void;
  /** The served statement is signed by a key that is not the root (under the root's kid). */
  statementNonRoot(): void;
  /** The served statement is root-signed but expired 30 days ago. */
  statementExpired(): void;
  /** Approves the approval with a fresh passkey (a second credential) and returns it. */
  secondCredential(handle: string, sub?: string): { outcome: Outcome; passkey: SoftPasskey };
  /** 1.6.0 carts carry these values instead of their own (completion_mode, variant_ref, merchant_origin, …). */
  cart(patch: Partial<Cart>): void;
  /** 1.6.0 snapshots carry these values instead of their own, with snapshot_hash and check_code computed over them. */
  snapshot(patch: Partial<SnapshotV2>): void;
  /** 1.6.0 proofs carry a snapshot with these values, correctly hashed and cloud-signed. */
  proofSnapshot(patch: Partial<SnapshotV2>): void;
  /** Outcome reports get this status (and no outcome) instead of being handled; null turns it off. */
  reportStatus(status: number | null): void;
  reset(): void;
}

export interface FakeCloud {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  url: string;
  keys: {
    rootKid: string;
    /** The s1 root public key as a JWK, for pinning. */
    rootPublicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
    /** The pin in `PINNED_HOSTS` form. */
    rootPin: { kid: string; jwk: { kty: "OKP"; crv: "Ed25519"; x: string } };
    receiptKid: string;
    receiptPublicKey: string;
    approvalKid: string;
    approvalPublicKey: string;
  };
  /** The statement served at `GET /v1/key-statement` (untampered). */
  statement: KeyStatement;
  approveWithPasskey(handle: string, passkey: SoftPasskey, override?: Partial<AssertOptions>): Outcome;
  reject(handle: string, passkey: SoftPasskey, override?: Partial<AssertOptions>): Outcome;
  /** The confirm page's hand-off to the merchant: approved → handed_off. */
  handoff(handle: string): Outcome;
  /** The merchant reports the order: handed_off → ordered (1.6.0: a verified `ordered` outcome, binding ok). */
  order(handle: string): Outcome;
  /**
   * 1.6.0: Intent Cloud records this outcome for a hand-off approval that is approved or handed off (a merchant
   * webhook, a checkout read), observed now; `state` then follows Appendix G's table.
   */
  setOutcome(handle: string, outcome: Omit<CloudOutcome, "observed_at">): Outcome;
  inspect(handle: string): ApprovalRecordView | undefined;
  /** The approval handle whose `approval_link_path` is `linkPath` (`/c/…`), for a confirm page; undefined if none. */
  approvalForLink(linkPath: string): string | undefined;
  /** Answer every request with this 52x status and no receipt or version header, as the network in front of the
   * edge would; null turns it off. */
  simulateCloudflareError(status: number | null): void;
  tamper: Tamper;
  close(): Promise<void>;
}

interface OfferRecord {
  item: CatalogItem;
  expiresAt: number | null;
}

interface CartRecord {
  handle: string;
  owner: string;
  version: ServedVersion;
  /** 1.6.0: the completer keyid of the cart request. */
  completer?: string;
  /** The address key the cart was created from: its approval by passkey raises that key's cart tier. */
  addressKey: string;
  offerHandle: string;
  item: CatalogItem;
  quantity: number;
  shipTo: ShipTo;
  createdAt: number;
  expiresAt: number;
  body: Cart;
  latest?: ApprovalRecord;
  lastNewApprovalAt?: number;
}

interface ApprovalRecord {
  handle: string;
  owner: string;
  cart: CartRecord;
  snapshot: AnySnapshot;
  snapshotHash: string;
  continueUrl: string;
  linkPath: string;
  expiresAt: number;
  state: ApprovalState;
  created: ApprovalCreated;
  claimedBy?: string;
  ledger?: { seq: number; entry_hash: string };
  /** The approving passkey's assertion and key; the proof is signed from them at each read. */
  approvedBy?: { assertion: WebAuthnAssertion; credentialPublicKey: CredentialPublicKey };
  orderNumber?: string;
  /** 1.6.0: the outcome, and when it became terminal (seconds). */
  outcome?: CloudOutcome;
  terminalAt?: number;
  /** 1.6.0: accepted outcome reports by report_id: the body's hash and the first answer, which a retry replays. */
  reports: Map<string, { hash: string; body: OutcomeReport; reply: Reply }>;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type ReceiptFault = "receiptSignature" | "receiptDigest" | "dropReceipt";
type Fault = ReceiptFault | "proofHash" | "proofUnknownKid" | "statementNonRoot" | "statementExpired";

// The gateway profile's Signature-Input (appendix C), from which the receipt takes keyid, nonce and created.
const PROFILE_INPUT =
  /^sig1=\("@method" "@path" "content-digest"\);created=(\d+);nonce="([^"]*)";keyid="([^"]*)";alg="ed25519";tag="intent-gateway-v1"$/;

const handle = (prefix: string): string => `${prefix}_${randomBytes(12).toString("base64url")}`;
const fail = (status: number, error: string, message: string): Reply => ({ status, body: { error, message } });

// The platform's error replies. Every signature failure looks the same, so a caller learns nothing about which
// check failed; an unknown handle and another session's handle look the same, so handles cannot be probed.
const UNAUTHORIZED = (): Reply => fail(401, "unauthorized", "authentication failed");
const DIGEST_MISMATCH = (): Reply => fail(400, "digest_mismatch", "content digest mismatch");
const UNKNOWN_HANDLE = (): Reply => fail(404, "not_found", "unknown handle");

/**
 * The key a client address is counted under: an IPv4 address (also when IPv4-mapped) as is, an IPv6 address as its
 * /64 prefix, so one host cannot escape a quota by rotating addresses inside its own /64.
 */
export function addressKey(address: string): string {
  const bare = address.replace(/%.*$/, "").toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!bare.includes(":")) return bare;
  const [head = "", tail] = bare.split("::");
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  const full = tail === undefined ? left : [...left, ...zeros, ...right];
  const prefix = full.slice(0, 4).map((g) => (Number.parseInt(g, 16) || 0).toString(16));
  return `${prefix.join(":")}::/64`;
}

function parseJson(body: Buffer): unknown {
  const text = body.toString("utf8");
  // Amendment item 9: a non-integer number token is refused, as JSON.parse would read 1.0 as 1.
  if (nonIntegerToken(text) !== null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The item's merchant variant reference: its own, or a stable Shopify-style one derived from it. */
export function variantRef(item: CatalogItem): string {
  if (item.variant_ref !== undefined) return item.variant_ref;
  const digest = createHash("sha256").update(`${item.merchant.domain}\n${item.title}\n${item.variant}`).digest();
  return `gid://shopify/ProductVariant/${String(digest.readUInt32BE(0))}`;
}

function toOffer(offerHandle: string, item: CatalogItem, version: ServedVersion): Offer {
  const offer: Offer = {
    offer_handle: offerHandle,
    merchant: item.merchant,
    title: item.title,
    variant: item.variant,
    price: item.price,
    shipping: item.shipping,
    total_kind: item.total_kind,
    availability: item.availability,
  };
  if (item.image_url !== undefined) offer.image_url = item.image_url;
  if (item.delivery !== undefined) offer.delivery = item.delivery;
  if (item.rating !== undefined) offer.rating = item.rating;
  if (item.returns !== undefined) offer.returns = item.returns;
  if (version === "1.6.0") offer.variant_ref = variantRef(item);
  return offer;
}

/** Starts the fake on 127.0.0.1. */
export async function startFakeCloud(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  const clockMs = options.now ?? Date.now;
  const now = (): number => Math.floor(clockMs() / 1000);
  const quotas: Quotas = { ...DEFAULT_QUOTAS, ...options.quotas };
  const keys = loadKeys();
  const versions: ReadonlySet<ServedVersion> = new Set(options.versions ?? ["1.5.0", "1.6.0"]);
  const oneTap = options.oneTap ?? false;
  // The vendored copy is 1.6.0 (CONTRACT_VERSION); 1.5.0 is answered with its released sums.
  const sums: Record<ServedVersion, string> = {
    "1.5.0": SUMS_1_5_0,
    "1.6.0": sha256Hex(readFileSync(new URL("../../contract/SHA256SUMS", import.meta.url))),
  };
  const statement = makeStatement(keys, now());
  const seenNonce = createNonceCache();

  const offers = new Map<string, OfferRecord>();
  const carts = new Map<string, CartRecord>();
  const approvals = new Map<string, ApprovalRecord>();
  const buckets = new Map<string, number[]>();
  /** Address key → when a cart created from it last got a passkey-approved approval. */
  const passkeyApprovedAt = new Map<string, number>();
  const faults = new Map<Fault, string | undefined>();
  const ledger: { seq: number; entry_hash: string }[] = [];
  let orders = 0;
  let cloudflareStatus: number | null = null;
  let cartPatch: Partial<Cart> | null = null;
  let snapshotPatch: Partial<SnapshotV2> | null = null;
  let proofSnapshotPatch: Partial<SnapshotV2> | null = null;
  let reportFault: number | null = null;

  const catalog = options.catalog ?? DEFAULT_CATALOG;
  const excluded = options.excludedCategories ?? [];
  for (const item of catalog) if (item.offer_handle !== undefined) offers.set(item.offer_handle, { item, expiresAt: null });

  const faultOn = (fault: Fault, path?: string): boolean => {
    if (!faults.has(fault)) return false;
    const only = faults.get(fault);
    return only === undefined || only === path;
  };

  /** Records one event in a window; returns Retry-After seconds when the limit is used up. */
  function take(bucket: string, limit: number, window: number, at: number): number | null {
    const recent = (buckets.get(bucket) ?? []).filter((t) => at - t < window);
    buckets.set(bucket, recent);
    if (recent.length >= limit) return Math.max(1, (recent[0] ?? at) + window - at);
    recent.push(at);
    return null;
  }

  // Retry-After is when the oldest counted item leaves the window, at least 1 s.
  const limited = (limit: string, retry: number): Reply => ({
    status: 429,
    body: { error: "rate_limited", message: `the ${limit} limit is used up; retry later`, limit, retry_after_seconds: retry },
    headers: { "retry-after": String(retry) },
  });

  function refresh(a: ApprovalRecord, at: number): void {
    if (a.state === "pending" && at >= a.expiresAt) a.state = "expired";
  }

  function servedStatement(at: number): KeyStatement {
    if (faults.has("statementNonRoot")) return makeStatement(keys, at, randomKey(keys.root.kid));
    if (faults.has("statementExpired")) return makeStatement(keys, at, keys.root, 120);
    return statement;
  }

  /** The proof as a read at `at` serves it: issued at the read, naming the ledger's `approved` entry. */
  function servedProof(a: ApprovalRecord, approvedBy: NonNullable<ApprovalRecord["approvedBy"]>, at: number): ApprovalProof {
    const ref = a.ledger;
    if (ref === undefined) throw new Error("an approved approval without a ledger entry");
    const unsigned: Omit<ApprovalProof, "cloud_signature"> = {
      v: 1,
      approval_handle: a.handle,
      snapshot: a.snapshot,
      snapshot_hash: a.snapshotHash,
      assertion: approvedBy.assertion,
      credential_public_key: approvedBy.credentialPublicKey,
      ledger: ref,
      issued_at: timestamp(at),
      kid: keys.approval.kid,
    };
    if (faults.has("proofHash")) {
      const changed = { ...unsigned, snapshot_hash: sha256Hex("not the snapshot") };
      return { ...changed, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(changed)) };
    }
    if (faults.has("proofUnknownKid")) {
      const changed = { ...unsigned, kid: "cloud-approval-209912" };
      return { ...changed, cloud_signature: randomKey(changed.kid).sign(APPROVAL_PREFIX + canonicalize(changed)) };
    }
    if (proofSnapshotPatch !== null && a.snapshot.v === 2) {
      const snapshot = { ...a.snapshot, ...proofSnapshotPatch };
      const changed = { ...unsigned, snapshot, snapshot_hash: sha256Hex(canonicalize(snapshot)) };
      return { ...changed, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(changed)) };
    }
    return { ...unsigned, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(unsigned)) };
  }

  // ---- Platform handlers (behind the edge) -------------------------------------------------------------------

  function search(body: Buffer, version: ServedVersion, at: number): Reply {
    const parsed = SearchRequest.safeParse(parseJson(body));
    if (!parsed.success) return fail(400, "bad_request", "body does not match SearchRequest");
    const found = searchCatalog(catalog, parsed.data, excluded).slice(0, 20);
    return {
      status: 200,
      body: {
        offers: found.map((item) => {
          const offerHandle = item.offer_handle ?? handle("of");
          if (item.offer_handle === undefined) offers.set(offerHandle, { item, expiresAt: at + OFFER_TTL });
          return toOffer(offerHandle, item, version);
        }),
      },
    };
  }

  /** Mode choice (contract 1.6.0 §3): the item's first mode that the caller accepts and the environment enables. */
  function chooseMode(item: CatalogItem, accepts: readonly CompletionMode[]): CompletionMode | null {
    for (const mode of item.completion ?? ["handoff"]) {
      if (accepts.includes(mode) && (mode !== "shop_agent" || oneTap)) return mode;
    }
    return null;
  }

  function createCart(body: Buffer, keyid: string, ipKey: string, version: ServedVersion, at: number): Reply {
    const json = parseJson(body);
    const parsed = CartRequest.safeParse(json);
    if (!parsed.success) return fail(400, "bad_request", "body does not match CartRequest");
    const request = parsed.data;
    const v16 = version === "1.6.0";
    // 1.5.0 has neither field, and its schema refuses unknown ones; 1.6.0 requires the completer key.
    if (!v16 && (request.completer_keyid !== undefined || request.completion_accepts !== undefined)) {
      return fail(400, "bad_request", "body does not match CartRequest");
    }
    if (v16 && request.completer_keyid === undefined) return fail(400, "bad_request", "completer_keyid is required");
    if (v16 && request.completer_keyid === keyid) return fail(400, "bad_request", "completer_keyid must not be the session key");
    const offer = offers.get(request.offer_handle);
    if (offer === undefined) return UNKNOWN_HANDLE();
    if (offer.expiresAt !== null && at >= offer.expiresAt) return fail(410, "gone", "offer expired");
    for (const cart of carts.values()) {
      const same =
        cart.owner === keyid &&
        cart.version === version &&
        cart.completer === request.completer_keyid &&
        cart.offerHandle === request.offer_handle &&
        cart.quantity === request.quantity &&
        (v16 ? cart.shipTo.postal_code === request.ship_to.postal_code : cart.shipTo.postal_code.slice(0, 3) === request.ship_to.postal_code.slice(0, 3));
      const live = at - cart.createdAt < REPLAY_WINDOW && at < cart.expiresAt;
      if (same && live && (cart.latest === undefined || cart.latest.state === "pending")) return { status: 201, body: cart.body };
    }
    // Amendment M5: a completer key names one approval; an earlier approval's key is refused (a replay returned above).
    if (v16 && [...approvals.values()].some((a) => a.snapshot.v === 2 && a.snapshot.completer_keyid === request.completer_keyid)) {
      return fail(400, "bad_request", "completer_keyid belongs to an earlier approval");
    }
    if (request.quantity > offer.item.stock) return fail(409, "conflict", "not enough stock");
    const mode = v16 ? chooseMode(offer.item, request.completion_accepts ?? ["handoff"]) : "handoff";
    if (mode === null) return fail(409, "conflict", "no completion mode in common");
    const approvedAt = passkeyApprovedAt.get(ipKey);
    const passkeyTier = approvedAt !== undefined && at - approvedAt < PASSKEY_TIER_WINDOW;
    const retry = take(`carts:${ipKey}`, passkeyTier ? quotas.carts_per_hour_passkey : quotas.carts_per_hour, 3600, at);
    if (retry !== null) return limited("carts", retry);

    const item = offer.item;
    const cartHandle = handle("ct");
    const cart: Cart = {
      cart_handle: cartHandle,
      merchant: item.merchant,
      item: { title: item.title, variant: item.variant },
      quantity: request.quantity,
      unit_price: item.price,
      shipping: item.shipping,
      total: { amount_minor: item.price.amount_minor * request.quantity + item.shipping.amount_minor, currency: "USD" },
      total_kind: item.total_kind,
      expires_at: timestamp(at + CART_TTL),
    };
    if (item.image_url !== undefined) cart.image_url = item.image_url;
    if (v16) {
      Object.assign(cart, {
        completion_mode: mode,
        merchant_origin: `https://${item.merchant.domain.toLowerCase()}`,
        variant_ref: variantRef(item),
        total_estimated: false,
      });
      if (cartPatch !== null) Object.assign(cart, cartPatch);
    }
    carts.set(cartHandle, {
      handle: cartHandle,
      owner: keyid,
      version,
      ...(request.completer_keyid === undefined ? {} : { completer: request.completer_keyid }),
      addressKey: ipKey,
      offerHandle: request.offer_handle,
      item,
      quantity: request.quantity,
      shipTo: request.ship_to,
      createdAt: at,
      expiresAt: at + CART_TTL,
      body: cart,
    });
    return { status: 201, body: cart };
  }

  function createApproval(param: string, keyid: string, ipKey: string, at: number): Reply {
    if (!CartHandle.safeParse(param).success) return fail(400, "bad_request", "malformed cart handle");
    const cart = carts.get(param);
    if (cart?.owner !== keyid) return UNKNOWN_HANDLE();
    if (at >= cart.expiresAt) return fail(410, "gone", "cart expired");
    const latest = cart.latest;
    if (latest !== undefined) refresh(latest, at);
    if (latest?.state === "pending" && cart.lastNewApprovalAt !== undefined && at - cart.lastNewApprovalAt < REPLAY_WINDOW) {
      return { status: 201, body: latest.created };
    }
    const retry = take(`approvals:${ipKey}`, quotas.approvals_per_day, 86_400, at);
    if (retry !== null) return limited("approvals", retry);
    if (latest?.state === "pending") latest.state = "expired";

    const approvalHandle = handle("ap");
    const expiresAt = Math.min(cart.expiresAt, at + APPROVAL_TTL);
    const continueUrl = `https://${cart.item.merchant.domain}/checkout/${cart.handle}`;
    const v1: Snapshot = {
      v: 1,
      approval: approvalHandle,
      nonce: randomBytes(16).toString("base64url"),
      merchant: cart.body.merchant,
      item: cart.body.item,
      quantity: cart.quantity,
      unit_price: cart.body.unit_price,
      shipping: cart.body.shipping,
      total: cart.body.total,
      total_kind: cart.body.total_kind,
      ship_to: { country: "US", postal_prefix: cart.shipTo.postal_code.slice(0, 3) },
      continue_url_hash: `sha256:${sha256Hex(continueUrl)}`,
      rule_version: RULE_VERSION,
      expires_at: timestamp(expiresAt),
    };
    let snapshot: AnySnapshot = v1;
    if (cart.version === "1.6.0") {
      const { body } = cart;
      // The checkout URL's query (`?key=…`) is not part of the hash (amendment L1).
      const checkoutHash = checkoutRefHash(`gid://shopify/Checkout/${cart.handle}?key=${randomBytes(8).toString("hex")}`);
      if (body.completion_mode === undefined || body.merchant_origin === undefined || body.variant_ref === undefined || cart.completer === undefined || checkoutHash === null) {
        throw new Error("a 1.6.0 cart without its 1.6.0 fields");
      }
      const v2: SnapshotV2 = {
        ...v1,
        v: 2,
        ship_to: { country: "US", postal_code: cart.shipTo.postal_code },
        merchant_origin: body.merchant_origin,
        variant_ref: body.variant_ref,
        checkout_ref_hash: checkoutHash,
        completion_mode: body.completion_mode,
        completer_keyid: cart.completer,
        total_estimated: body.total_estimated ?? false,
      };
      snapshot = snapshotPatch === null ? v2 : { ...v2, ...snapshotPatch };
    }
    const snapshotHash = sha256Hex(canonicalize(snapshot));
    const linkPath = `/c/${randomBytes(16).toString("base64url")}`;
    const created: ApprovalCreated = {
      approval_handle: approvalHandle,
      approval_link_path: linkPath,
      snapshot,
      snapshot_hash: snapshotHash,
      check_code: snapshotHash.slice(0, 8),
      state: "pending",
      expires_at: timestamp(expiresAt),
    };
    const record: ApprovalRecord = {
      handle: approvalHandle,
      owner: keyid,
      cart,
      snapshot,
      snapshotHash,
      continueUrl,
      linkPath,
      expiresAt,
      state: "pending",
      created,
      reports: new Map(),
    };
    approvals.set(approvalHandle, record);
    cart.latest = record;
    cart.lastNewApprovalAt = at;
    return { status: 201, body: created };
  }

  /**
   * Who may read or report an approval (Appendix G R1/R7): the session that created its cart, or, in 1.6.0, the
   * snapshot's completer key until 48 h after the later of `expires_at` and a terminal outcome.
   */
  function mayUse(a: ApprovalRecord, keyid: string, version: ServedVersion, at: number): boolean {
    if (a.owner === keyid) return true;
    if (version !== "1.6.0" || a.snapshot.v !== 2 || a.snapshot.completer_keyid !== keyid) return false;
    return at < Math.max(a.expiresAt, a.terminalAt ?? 0) + COMPLETER_WINDOW;
  }

  const modeOf = (a: ApprovalRecord): CompletionMode => (a.snapshot.v === 2 ? a.snapshot.completion_mode : "handoff");

  function getApproval(param: string, keyid: string, version: ServedVersion, at: number): Reply {
    if (!ApprovalHandle.safeParse(param).success) return fail(400, "bad_request", "malformed approval handle");
    const a = approvals.get(param);
    if (a === undefined || !mayUse(a, keyid, version, at)) return UNKNOWN_HANDLE();
    refresh(a, at);
    let state = a.state;
    if (a.outcome !== undefined) {
      const mapped = statusState(a.outcome.state, modeOf(a))[version];
      if (mapped === null) return UNKNOWN_HANDLE();
      state = mapped;
    }
    const status: ApprovalStatus = {
      state,
      display: { merchant: a.snapshot.merchant.name, title: a.snapshot.item.title, total: a.snapshot.total },
    };
    if (a.cart.body.image_url !== undefined) status.display.image_url = a.cart.body.image_url;
    if (a.orderNumber !== undefined) status.order_number = a.orderNumber;
    const withProof = state === "approved" || state === "handed_off" || state === "ordered";
    if (withProof && a.approvedBy !== undefined) status.proof = servedProof(a, a.approvedBy, at);
    if (version === "1.6.0" && a.outcome !== undefined) status.outcome = a.outcome;
    return { status: 200, body: status };
  }

  /** How Intent Cloud stores a gateway's report (Appendix G R5): never as more than `reported` assurance. */
  function storedOutcome(report: OutcomeReport): CloudOutcome {
    const base = { source: "gateway_report", assurance: "reported", observed_at: report.observed_at } as const;
    if (report.state !== "ordered" && report.state !== "mismatch") return { ...base, state: report.state };
    // Copied by key name: src/ lint forbids reading a property named like `process.binding`.
    const reported = Object.fromEntries(REPORTED_KEYS.filter((k) => report[k] !== undefined).map((k) => [k, report[k]])) as NonNullable<CloudOutcome["reported"]>;
    return { ...base, state: "reported", reported };
  }

  /** `POST /v1/approvals/{h}/outcome-reports` (Appendix G R1–R7). */
  function reportOutcome(param: string, body: Buffer, keyid: string, version: ServedVersion, at: number): Reply {
    if (version !== "1.6.0") return fail(404, "not_found", "not found");
    if (!ApprovalHandle.safeParse(param).success) return fail(400, "bad_request", "malformed approval handle");
    const a = approvals.get(param);
    if (a === undefined || a.snapshot.v !== 2) return UNKNOWN_HANDLE();
    // R1 first: any key but the cart's session or the completer gets 404, like an unknown handle; then R0.
    if (!mayUse(a, keyid, version, at)) return UNKNOWN_HANDLE();
    if (modeOf(a) !== "shop_agent") return fail(409, "conflict", "not a shop_agent approval");
    if (reportFault !== null) return fail(reportFault, "bad_request", "fake cloud error");
    const parsed = OutcomeReport.safeParse(parseJson(body));
    if (!parsed.success) return fail(400, "bad_request", "body does not match OutcomeReport");
    const report = parsed.data;
    if (report.state === "completing" && report.checkout_ref === undefined) return fail(400, "bad_request", "completing needs checkout_ref");
    if ((report.state === "ordered" || report.state === "mismatch") && !ORDER_KEYS.every((k) => k in report)) {
      return fail(400, "bad_request", `${report.state} needs order_ref, final_total and binding`);
    }
    const hash = sha256Hex(canonicalize(report));
    const prior = a.reports.get(report.report_id);
    if (prior !== undefined) return prior.hash === hash ? prior.reply : fail(409, "conflict", "report_id reused with another body");
    refresh(a, at);
    if (a.outcome === undefined) {
      if (report.state !== "completing") return fail(409, "conflict", "the first report must be completing");
      if (a.state !== "approved" || at >= a.expiresAt) return fail(410, "gone", "the approval is not approved, or has expired");
    } else if (a.terminalAt !== undefined) {
      return fail(409, "conflict", "the outcome is final");
    } else if (report.state === "completing") {
      return fail(409, "conflict", "the approval is already completing");
    }
    const outcome = storedOutcome(report);
    a.outcome = outcome;
    if (report.state === "ordered" || report.state === "mismatch" || report.state === "failed") a.terminalAt = at;
    const reply: Reply = { status: 201, body: { accepted: true, outcome } };
    a.reports.set(report.report_id, { hash, body: report, reply });
    return reply;
  }

  // ---- The edge -------------------------------------------------------------------------------------------------

  // The edge's endpoints: path pattern and the one method it answers. Any other path is 404, another method 405.
  const ENDPOINT_METHODS: readonly (readonly [RegExp, string])[] = [
    [/^\/v1\/meta$/, "GET"],
    [/^\/v1\/signature-keys$/, "GET"],
    [/^\/v1\/key-statement$/, "GET"],
    [/^\/v1\/catalog\/search$/, "POST"],
    [/^\/v1\/carts$/, "POST"],
    [/^\/v1\/carts\/[^/]+\/approvals$/, "POST"],
    [/^\/v1\/approvals\/[^/]+$/, "GET"],
    [/^\/v1\/approvals\/[^/]+\/outcome-reports$/, "POST"],
  ];

  /**
   * The version a request is answered in (1.6.0 §V1): the header's when this host serves 1.6.0, 1.5.0 without it;
   * null for a value this host does not serve. A host from before 1.6.0 ignores the header.
   */
  function negotiate(req: IncomingMessage): ServedVersion | null {
    if (!versions.has("1.6.0")) return "1.5.0";
    const raw = req.headers["intent-contract-version"];
    if (raw === undefined) return versions.has("1.5.0") ? "1.5.0" : null;
    return raw === "1.6.0" || (raw === "1.5.0" && versions.has("1.5.0")) ? raw : null;
  }

  function route(method: string, path: string, body: Buffer, req: IncomingMessage, ipKey: string, version: ServedVersion | null, at: number): Reply {
    if (body.length > MAX_BODY_BYTES) return fail(413, "too_large", "body over 16 KiB");
    const retry = take(`requests:${ipKey}`, quotas.requests_per_minute, 60, at);
    if (retry !== null) return limited("requests", retry);
    if (version === null) return fail(400, "bad_request", "unsupported contract version");

    const endpoint = ENDPOINT_METHODS.find(([pattern]) => pattern.test(path));
    if (endpoint === undefined) return fail(404, "not_found", "not found");
    if (endpoint[1] !== method) return fail(405, "not_found", "method not allowed");

    // The approval key only: receipts are signed by the edge, and app keys are never served here.
    if (path === "/v1/signature-keys") {
      const k = keys.approval;
      return { status: 200, body: { keys: [{ kty: "OKP", crv: "Ed25519", kid: k.kid, x: k.x, use: "sig", alg: "EdDSA" }] } };
    }
    if (path === "/v1/key-statement") return { status: 200, body: servedStatement(at) };

    const verified = verifyRequest(req.headers, { method, path, body }, { now: at, seenNonce });
    if (!verified.ok) return verified.status === 400 ? DIGEST_MISMATCH() : UNAUTHORIZED();
    const { keyid } = verified;
    if (path === "/v1/meta") {
      const limits = {
        requests_per_minute: Math.max(1, quotas.requests_per_minute),
        carts_per_hour: Math.max(1, quotas.carts_per_hour),
        carts_per_hour_passkey: Math.max(1, quotas.carts_per_hour_passkey),
        approvals_per_day: Math.max(1, quotas.approvals_per_day),
      };
      return { status: 200, body: { contract_version: version, contract_sums_sha256: sums[version], rule_versions: [RULE_VERSION], limits } };
    }
    if (path === "/v1/catalog/search") return search(body, version, at);
    if (path === "/v1/carts") return createCart(body, keyid, ipKey, version, at);
    const cartApprovals = /^\/v1\/carts\/([^/]+)\/approvals$/.exec(path);
    if (cartApprovals !== null) return createApproval(cartApprovals[1] ?? "", keyid, ipKey, at);
    const reports = /^\/v1\/approvals\/([^/]+)\/outcome-reports$/.exec(path);
    if (reports !== null) return reportOutcome(reports[1] ?? "", body, keyid, version, at);
    return getApproval(/^\/v1\/approvals\/([^/]+)$/.exec(path)?.[1] ?? "", keyid, version, at);
  }

  function receiptHeaders(method: string, path: string, body: Buffer, req: IncomingMessage, status: number, at: number): Record<string, string> {
    const digested = faultOn("receiptDigest", path) ? Buffer.from("another body") : body;
    const request: ReceiptRequestType = { method, path, content_digest: contentDigest(digested) };
    const input = req.headers["signature-input"];
    const profile = typeof input === "string" ? PROFILE_INPUT.exec(input) : null;
    if (profile !== null) {
      const signed = { ...request, created: Number(profile[1]), nonce: profile[2] ?? "", keyid: profile[3] ?? "" };
      if (ReceiptRequest.safeParse(signed).success) Object.assign(request, signed);
    }
    const jcs = canonicalize({ v: 1, kid: keys.receipt.kid, request, status, received_at: timestamp(at) });
    const signedBytes = faultOn("receiptSignature", path) ? `${RECEIPT_PREFIX}${jcs} ` : RECEIPT_PREFIX + jcs;
    return {
      "intent-receipt": Buffer.from(jcs, "utf8").toString("base64url"),
      "intent-receipt-signature": keys.receipt.sign(signedBytes),
    };
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const at = now();
    if (cloudflareStatus !== null) {
      const page = `<html><body>error code: ${String(cloudflareStatus)}</body></html>`;
      res.writeHead(cloudflareStatus, { "content-type": "text/html", "content-length": String(Buffer.byteLength(page)) });
      res.end(page);
      return;
    }
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
    const ipKey = addressKey(req.socket.remoteAddress ?? "unknown");
    const version = negotiate(req);
    let reply: Reply;
    try {
      reply = route(method, path, body, req, ipKey, version, at);
    } catch {
      reply = fail(500, "bad_request", "fake cloud error");
    }
    const bytes = Buffer.from(JSON.stringify(reply.body), "utf8");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(bytes.length),
      // An unsupported request version is answered in the newest version this host serves.
      "intent-contract-version": version ?? CONTRACT_VERSION,
      ...reply.headers,
    };
    const drop = reply.status >= 200 && reply.status < 300 && faultOn("dropReceipt", path);
    if (!drop) Object.assign(headers, receiptHeaders(method, path, body, req, reply.status, at));
    res.writeHead(reply.status, headers);
    res.end(bytes);
  }

  // ---- The confirm page and the merchant ------------------------------------------------------------------------

  function decide(approvalHandle: string, passkey: SoftPasskey, action: Action, override: Partial<AssertOptions> = {}): Outcome {
    const a = approvals.get(approvalHandle);
    if (a === undefined) return { status: 404, reason: "unknown approval" };
    const at = now();
    refresh(a, at);
    if (a.state === "expired") return { status: 410, state: a.state, reason: "approval expired" };
    if (a.state !== "pending") return { status: 409, state: a.state, reason: `already ${a.state}` };
    const expected = { rpId: RP_ID, origin: CONFIRM_ORIGIN, challenge: challengeFor(action, a.snapshotHash) };
    const assertion = passkey.assert({ ...expected, ...override });
    const problem = assertionProblem(assertion, passkey.publicJwk, expected);
    if (problem !== null) return { status: 400, state: a.state, reason: problem };

    a.claimedBy = passkey.sub;
    const prev = ledger.at(-1);
    const entry = {
      seq: ledger.length + 1,
      prev_hash: prev?.entry_hash ?? "0".repeat(64),
      approval: a.handle,
      event: action === "approve" ? "approved" : "rejected",
      snapshot_hash: a.snapshotHash,
      credential_id: assertion.credential_id,
      rule_version: a.snapshot.rule_version,
      recorded_at: timestamp(at),
    };
    const ref = { seq: entry.seq, entry_hash: sha256Hex(canonicalize(entry)) };
    ledger.push(ref);
    a.ledger = ref;
    if (action === "reject") {
      a.state = "rejected";
      return { status: 200, state: a.state };
    }
    a.approvedBy = { assertion, credentialPublicKey: passkey.publicJwk };
    a.state = "approved";
    passkeyApprovedAt.set(a.cart.addressKey, at);
    return { status: 200, state: a.state };
  }

  const server = createServer((req, res) => {
    serve(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const rootJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: keys.root.x };
  const setFault = (fault: Fault) => (path?: string) => {
    faults.set(fault, path);
  };

  return {
    url: `http://127.0.0.1:${String(port)}`,
    keys: {
      rootKid: keys.root.kid,
      rootPublicJwk: rootJwk,
      rootPin: { kid: keys.root.kid, jwk: rootJwk },
      receiptKid: keys.receipt.kid,
      receiptPublicKey: keys.receipt.x,
      approvalKid: keys.approval.kid,
      approvalPublicKey: keys.approval.x,
    },
    statement,
    approveWithPasskey: (h, passkey, override) => decide(h, passkey, "approve", override),
    reject: (h, passkey, override) => decide(h, passkey, "reject", override),
    handoff(h) {
      const a = approvals.get(h);
      if (a === undefined) return { status: 404, reason: "unknown approval" };
      if (a.state !== "approved") return { status: 409, state: a.state, reason: `cannot hand off when ${a.state}` };
      if (modeOf(a) !== "handoff") return { status: 409, state: a.state, reason: "the approval's completion mode is not handoff" };
      // Appendix A hand-off invariant: redirect only to a URL whose hash is in the snapshot.
      if (`sha256:${sha256Hex(a.continueUrl)}` !== a.snapshot.continue_url_hash) {
        a.state = "expired";
        return { status: 409, state: a.state, reason: "continue_url does not match the snapshot" };
      }
      a.state = "handed_off";
      // The confirm page's redirect is Intent Cloud's own unsigned event: `reported` at most (Appendix G sources).
      if (a.snapshot.v === 2) a.outcome = { state: "handed_off", source: "checkout_page", assurance: "reported", observed_at: timestamp(now()) };
      return { status: 200, state: a.state, continueUrl: a.continueUrl };
    },
    order(h) {
      const a = approvals.get(h);
      if (a === undefined) return { status: 404, reason: "unknown approval" };
      if (a.state !== "handed_off") return { status: 409, state: a.state, reason: `cannot order when ${a.state}` };
      orders += 1;
      a.orderNumber = `ORD-${String(100000 + orders)}`;
      a.state = "ordered";
      if (a.snapshot.v === 2) {
        const at = now();
        a.outcome = {
          state: "ordered",
          source: "signed_webhook",
          assurance: "verified",
          order_ref: a.orderNumber,
          final_total: a.snapshot.total,
          binding: {
            rule_version: "binding-v1",
            result: "ok",
            checks: { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "match", total: "match" },
          },
          observed_at: timestamp(at),
        };
        a.terminalAt = at;
      }
      return { status: 200, state: a.state, orderNumber: a.orderNumber };
    },
    setOutcome(h, outcome) {
      const a = approvals.get(h);
      if (a === undefined) return { status: 404, reason: "unknown approval" };
      if (a.snapshot.v !== 2) return { status: 409, state: a.state, reason: "a 1.5.0 approval has no outcome" };
      if (a.state !== "approved" && a.state !== "handed_off") return { status: 409, state: a.state, reason: `no outcome when ${a.state}` };
      if (a.terminalAt !== undefined) return { status: 409, state: a.state, reason: "the outcome is final" };
      const at = now();
      a.outcome = { ...outcome, observed_at: timestamp(at) };
      if (TERMINAL.has(outcome.state)) a.terminalAt = at;
      return { status: 200, state: statusState(outcome.state, modeOf(a))["1.6.0"] };
    },
    inspect(h) {
      const a = approvals.get(h);
      if (a === undefined) return undefined;
      refresh(a, now());
      const view: ApprovalRecordView = {
        state: a.state,
        snapshot: a.snapshot,
        snapshot_hash: a.snapshotHash,
        approval_link: CONFIRM_ORIGIN + a.linkPath,
        reports: [...a.reports.values()].map((r) => r.body),
      };
      if (a.claimedBy !== undefined) view.claimed_by = a.claimedBy;
      if (a.ledger !== undefined) view.ledger = a.ledger;
      if (a.outcome !== undefined) view.outcome = a.outcome;
      return view;
    },
    approvalForLink(linkPath) {
      for (const a of approvals.values()) if (a.linkPath === linkPath) return a.handle;
      return undefined;
    },
    simulateCloudflareError(status) {
      cloudflareStatus = status;
    },
    tamper: {
      receiptSignature: setFault("receiptSignature"),
      receiptDigest: setFault("receiptDigest"),
      dropReceipt: setFault("dropReceipt"),
      proofHash() {
        faults.set("proofHash", undefined);
      },
      proofUnknownKid() {
        faults.set("proofUnknownKid", undefined);
      },
      statementNonRoot() {
        faults.set("statementNonRoot", undefined);
      },
      statementExpired() {
        faults.set("statementExpired", undefined);
      },
      secondCredential(h, sub) {
        const passkey = new SoftPasskey(sub === undefined ? {} : { sub });
        return { outcome: decide(h, passkey, "approve"), passkey };
      },
      cart(patch) {
        cartPatch = patch;
      },
      snapshot(patch) {
        snapshotPatch = patch;
      },
      proofSnapshot(patch) {
        proofSnapshotPatch = patch;
      },
      reportStatus(status) {
        reportFault = status;
      },
      reset() {
        faults.clear();
        cartPatch = null;
        snapshotPatch = null;
        proofSnapshotPatch = null;
        reportFault = null;
      },
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
