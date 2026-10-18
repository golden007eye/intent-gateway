// The fake Intent Cloud: an HTTP server on 127.0.0.1 that plays both the edge (body cap, request limit, appendix-C
// signature check, receipts on every response) and the platform behind it (catalog, carts, approvals, proofs).
// It follows contract/gateway-api.v1.yaml and appendices A–G, and the real platform's observable behaviour where the
// contract leaves room (error codes and messages, 404/405, quotas per address key, idempotency, proof issue time),
// so the fake, demo mode and staging answer alike. The confirm page is driven through `approveWithPasskey` and `reject`.
//
// Versions (contract 1.7.0): a request with `Intent-Contract-Version: 1.7.0` is answered as 1.7.0 (the vendored copy:
// `POST /v1/checkouts` with v4 snapshots, the currency table on Meta, ceilings and refusals; carts keep v3), one with
// `1.6.1` as the frozen 1.6.1 (v3 snapshots, a Shopify merchant's `myshopify_domain` on offers, carts and snapshots,
// with the 1.6.1 sums), one with `1.6.0` as the frozen 1.6.0 (v2 snapshots, the completer key, outcomes, outcome
// reports, with the 1.6.0 sums), and one without the header as 1.5.0, byte for byte, with the 1.5.0 sums. An approval
// is read and reported on only in the version that created it (R8). `versions: ["1.5.0"]` makes a host that predates
// 1.6.0 and ignores the header.
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AnySnapshot,
  type ApprovalCreated,
  type AnyApprovalProof,
  type ApprovalProofV1,
  type ApprovalState,
  type ApprovalStatus,
  type Cart,
  CartHandle,
  type CompletionMode,
  type CredentialPublicKey,
  ApprovalHandle,
  CartRequest,
  CartRequestV1,
  CheckoutRequest,
  checkoutRefHash,
  coarsePostcode,
  continueUrlAllowed,
  continueUrlHash,
  CONTRACT_VERSION,
  type CurrencyCeiling,
  currencyTableVersion,
  type Money,
  type RefusalCode,
  type SnapshotV4,
  totalsAddUp,
  accountKeyThumbprint,
  type KeyStatement,
  type Offer,
  type Outcome as CloudOutcome,
  Outcome as CloudOutcomeSchema,
  OutcomeReport,
  type OutcomeState,
  type OutcomeStatement,
  type ReceiptRequest as ReceiptRequestType,
  ReceiptRequest,
  SearchRequest,
  type ShipTo,
  type SnapshotV1,
  type SnapshotV2,
  type SnapshotV3,
  type WebAuthnAssertion,
} from "../contract/index.ts";
import { PAUSE_CONTRACT_VERSION, PauseRequest, pauseSigningBytes } from "../contract/index.ts";
import { canonicalize, nonIntegerToken, sha256Hex } from "../jcs/index.ts";
import { bindingResult, bindingV2 } from "../outcome/index.ts";
import { contentDigest, createNonceCache, verifyRequest } from "../signing/index.ts";
import { type CatalogItem, DEFAULT_CATALOG, searchCatalog } from "./catalog.ts";
import {
  APPROVAL_PREFIX,
  CONFIRM_ORIGIN,
  loadKeys,
  makeStatement,
  OUTCOME_PREFIX,
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

/** The versions a host can serve; the vendored copy is CONTRACT_VERSION (1.7.0). */
export type ServedVersion = "1.5.0" | "1.6.0" | "1.6.1" | "1.7.0";
const SERVED: readonly ServedVersion[] = ["1.5.0", "1.6.0", "1.6.1", "1.7.0"];
/** The released 1.5.0 `SHA256SUMS` sha256 (contract/SOURCE.md), which a header-less request is answered with. */
export const SUMS_1_5_0 = "c6fc6ffea8b7cb9053a74e0a3aa340d73d1c2800fcc4c47669707400d06410d2";
/** The frozen 1.6.0 `SHA256SUMS` sha256 (contract/SOURCE.md), which a 1.6.0 request is answered with. */
export const SUMS_1_6_0 = "b75b771e3ae299d74a53f450574af6fab8e63d6bcca2b42aa957046afbf4657d";
/** The frozen 1.6.1 `SHA256SUMS` sha256 (contract/SOURCE.md), which a 1.6.1 request is answered with. */
export const SUMS_1_6_1 = "bc035ee36b0a8fe54e1b87919c8de215c508ab5369d8254fdcdecf18c23710d8";
/** A 1.6.x-or-later version: the completer key, outcomes (everything but 1.5.0). */
const isV16 = (version: ServedVersion): boolean => version !== "1.5.0";
/** A version whose carts get v3 snapshots and the myshopify pair: 1.6.1, and 1.7.0, whose carts keep 1.6.1's rules. */
const isV3 = (version: ServedVersion): boolean => version === "1.6.1" || version === "1.7.0";
/** Intent Cloud's default currency table (1.7.0): USD only, $500 an order, $1,000 a buyer's rolling week. */
export const DEFAULT_CURRENCIES: Readonly<Record<string, CurrencyCeiling>> = Object.freeze({ USD: { order: 50_000, week: 100_000 } });
const WEEK = 7 * 86_400;
/**
 * The fake's category keywords for `category_excluded` (1.7.0: best effort, on the title's words), one or two per
 * excluded group: health and medical, age-restricted, financial or digital goods.
 */
const EXCLUDED_TITLE_WORDS: readonly RegExp[] = [/\bvape\b/i, /\bcbd\b/i, /\bwine\b/i, /\bwhisk(?:e)?y\b/i, /\balcohol\b/i, /\bgift ?card\b/i, /\bprescription\b/i, /\bcigar(?:ette)?s?\b/i];
const TERMINAL: ReadonlySet<OutcomeState> = new Set(["ordered", "mismatch", "failed", "checkout_expired"]);
/** What an `ordered` or `mismatch` report must carry (Appendix G), and what R5 keeps of it under `reported`. */
const ORDER_KEYS = ["order_ref", "final_total", "binding"] as const;
const REPORTED_KEYS = ["state", "source", ...ORDER_KEYS] as const;
/** The outcome member named like `process.binding`, which src/ lint keeps out of property reads. */
const BINDING_KEY = "binding";

/** Rule 25 in integers (`recheck-v1`): `ceil(0.8·A) ≤ R ≤ A`. */
const totalMatchesApproved = (approvedMinor: number, finalMinor: number): boolean => 5 * finalMinor >= 4 * approvedMinor && finalMinor <= approvedMinor;

/** `ApprovalStatus.state` for an outcome (Appendix G, vector o3): 1.6.x, 1.7.0 and the 1.5.0 downgrade (null: not served). */
export function statusState(
  outcome: OutcomeState,
  mode: CompletionMode,
): { "1.7.0": ApprovalState; "1.6.1": ApprovalState; "1.6.0": ApprovalState; "1.5.0": ApprovalState | null } {
  if (outcome === "ordered") return { "1.7.0": "ordered", "1.6.1": "ordered", "1.6.0": "ordered", "1.5.0": mode === "handoff" ? "ordered" : null };
  return mode === "handoff"
    ? { "1.7.0": "handed_off", "1.6.1": "handed_off", "1.6.0": "handed_off", "1.5.0": "handed_off" }
    : { "1.7.0": "approved", "1.6.1": "approved", "1.6.0": "approved", "1.5.0": null };
}

/** What the passkey approved, as Money: a v1 to v3 snapshot's total, a v4 snapshot's `totals.total` in its currency. */
function approvedTotal(s: AnySnapshot): Money {
  return s.v === 4 ? ({ amount_minor: s.totals.total, currency: s.currency } as Money) : s.total;
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
  /** The contract versions served. Default all four; `["1.5.0"]` is a host from before 1.6.0 that ignores the header. */
  versions?: readonly ServedVersion[];
  /**
   * Whether `shop_agent` carts and checkouts are enabled (Intent Cloud's ONE_TAP_GATEWAY_ENABLED). Default false: a
   * `shop_agent` checkout is then refused `one_tap_off`. `checkouts.setOneTap` changes it later.
   */
  oneTap?: boolean;
  /** 1.7.0: the currency table's ceilings per currency. Default DEFAULT_CURRENCIES (USD only). */
  currencies?: Readonly<Record<string, CurrencyCeiling>>;
}

/**
 * Controls and records for 1.7.0's submitted checkouts (`POST /v1/checkouts`). Each control stays until changed.
 * The snapshot seams of `tamper` (snapshot, proofSnapshot) apply to checkout approvals too.
 */
export interface CheckoutControls {
  /** Every body `POST /v1/checkouts` received that parsed as JSON, in order (refused ones included). */
  readonly received: readonly unknown[];
  /**
   * Pauses (true) or resumes (false) every account key: a submit gets 409 `paused`, the confirm page refuses the
   * approval, and a `completing` report gets 409 `paused`. (The real platform pauses the buyers pinned to a key; the
   * fake pauses all, so a test can pause before any key is pinned.)
   */
  setPaused(paused: boolean): void;
  /** One tap on or off (Intent Cloud's ONE_TAP_GATEWAY_ENABLED): off refuses a `shop_agent` checkout `one_tap_off`. */
  setOneTap(on: boolean): void;
  /** myshopify domains on Intent Cloud's block list (`store_blocked`); replaces the list. */
  blockStores(domains: readonly string[]): void;
  /** Replaces the currency table (its version follows, so Meta and new snapshots name the new one). */
  setCurrencies(currencies: Readonly<Record<string, CurrencyCeiling>>): void;
  /** The account key thumbprints pinned so far (at each first passkey approval of a v4 snapshot). */
  pinned(): readonly string[];
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

/** A patch over a served snapshot: v2/v3 fields for a cart's approval, v4 fields for a submitted checkout's. */
export type SnapshotPatch = Partial<SnapshotV3> | Partial<SnapshotV2> | Partial<SnapshotV4>;

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
  /** 1.6.x carts carry these values instead of their own (completion_mode, variant_ref, merchant_origin, …). */
  cart(patch: Partial<Cart>): void;
  /** 1.6.x offers carry these values instead of their own (myshopify_domain, variant_ref, …). */
  offer(patch: Partial<Offer>): void;
  /**
   * 1.6.x snapshots carry these values instead of their own, with snapshot_hash and check_code computed over them
   * (`v: 2` on a 1.6.1 approval serves a v2 snapshot; a key set to undefined is dropped).
   */
  snapshot(patch: SnapshotPatch): void;
  /** 1.6.x proofs (and 1.7.0 checkout proofs) carry a snapshot with these values, correctly hashed and cloud-signed. */
  proofSnapshot(patch: SnapshotPatch): void;
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
  /** 1.7.0 submitted checkouts: controls and the bodies received. */
  checkouts: CheckoutControls;
  /**
   * The account pause (contract 1.7.0 draft, ADR-0023): `register` pins an account key (as the first passkey approval
   * does), `resume` is the passkey resume on the confirm page's /account. While paused, `POST /v1/carts` answers 409
   * `paused`.
   */
  accountPause: {
    register(thumbprint: string, x: string): void;
    resume(): void;
    readonly paused: boolean;
    lastCounter(thumbprint: string): number;
  };
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

/** 1.7.0: what a submitted checkout's approval keeps of its request. */
interface CheckoutRecord {
  bodyHash: string;
  createdAt: number;
  checkoutRefHash: string;
  mode: CompletionMode;
  thumbprint: string;
}

interface ApprovalRecord {
  handle: string;
  owner: string;
  /** The version that created it (R8), and the address key it came from (the passkey tier). */
  version: ServedVersion;
  addressKey: string;
  imageUrl?: string;
  /** The cart for a cart's approval; null for a submitted checkout's (1.7.0), which has `checkout` instead. */
  cart: CartRecord | null;
  checkout?: CheckoutRecord;
  /** When the passkey approved it (seconds): the week ceiling counts approvals of the rolling 7 days. */
  approvedAt?: number;
  snapshot: AnySnapshot;
  snapshotHash: string;
  continueUrl: string;
  linkPath: string;
  expiresAt: number;
  state: ApprovalState;
  // The 201 body as served: a v1 snapshot for a 1.5.0 cart, v2 for a 1.6.0 one, v3 for a 1.6.1 one.
  created: Omit<ApprovalCreated, "snapshot"> & { snapshot: AnySnapshot };
  claimedBy?: string;
  ledger?: { seq: number; entry_hash: string };
  /** The approving passkey's assertion and key; the proof is signed from them at each read. */
  approvedBy?: { assertion: WebAuthnAssertion; credentialPublicKey: CredentialPublicKey };
  orderNumber?: string;
  /** 1.6.0: the outcome, and when it became terminal (seconds). */
  outcome?: CloudOutcome;
  terminalAt?: number;
  /** 1.6.0: the last reported state (R4) and the accepted completing report's id, which every later report names. */
  reportedState?: OutcomeReport["state"];
  completingReportId?: string;
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

function toOffer(offerHandle: string, item: CatalogItem, version: ServedVersion, patch: Partial<Offer> | null): Offer {
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
  if (isV16(version)) offer.variant_ref = variantRef(item);
  // R8 and Appendix A v3: only a 1.6.1 caller (or 1.7.0, whose carts keep 1.6.1's rules) receives myshopify_domain.
  if (isV3(version) && item.myshopify_domain !== undefined) offer.myshopify_domain = item.myshopify_domain;
  return isV16(version) && patch !== null ? dropUndefined({ ...offer, ...patch }) : offer;
}

/** The value without its keys set to undefined (a tamper patch removes a field that way). */
function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Starts the fake on 127.0.0.1. */
export async function startFakeCloud(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  const clockMs = options.now ?? Date.now;
  const now = (): number => Math.floor(clockMs() / 1000);
  const quotas: Quotas = { ...DEFAULT_QUOTAS, ...options.quotas };
  const keys = loadKeys();
  const versions: ReadonlySet<ServedVersion> = new Set(options.versions ?? SERVED);
  let oneTap = options.oneTap ?? false;
  // The vendored copy is 1.7.0 (CONTRACT_VERSION); 1.5.0, 1.6.0 and 1.6.1 are answered with their frozen sums.
  const sums: Record<ServedVersion, string> = {
    "1.5.0": SUMS_1_5_0,
    "1.6.0": SUMS_1_6_0,
    "1.6.1": SUMS_1_6_1,
    "1.7.0": sha256Hex(readFileSync(new URL("../../contract/SHA256SUMS", import.meta.url))),
  };
  let currencies: Readonly<Record<string, CurrencyCeiling>> = options.currencies ?? DEFAULT_CURRENCIES;
  let paused = false;
  let blockedStores: ReadonlySet<string> = new Set();
  const pinnedKeys = new Set<string>();
  const receivedCheckouts: unknown[] = [];
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
  let offerPatch: Partial<Offer> | null = null;
  let snapshotPatch: SnapshotPatch | null = null;
  let proofSnapshotPatch: SnapshotPatch | null = null;
  let reportFault: number | null = null;
  const accountKeys = new Map<string, { x: string; counter: number }>();
  let accountPaused = false;

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
  function servedProof(a: ApprovalRecord, approvedBy: NonNullable<ApprovalRecord["approvedBy"]>, at: number): AnyApprovalProof {
    const ref = a.ledger;
    if (ref === undefined) throw new Error("an approved approval without a ledger entry");
    // A 1.5.0 approval's proof names its v1 snapshot, a 1.6.0 one its v2 snapshot, a 1.6.1 one its v3 snapshot.
    const unsigned: Omit<ApprovalProofV1, "cloud_signature" | "snapshot"> & { snapshot: AnySnapshot } = {
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
      return { ...changed, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(changed)) } as AnyApprovalProof;
    }
    if (faults.has("proofUnknownKid")) {
      const changed = { ...unsigned, kid: "cloud-approval-209912" };
      return { ...changed, cloud_signature: randomKey(changed.kid).sign(APPROVAL_PREFIX + canonicalize(changed)) } as AnyApprovalProof;
    }
    if (proofSnapshotPatch !== null && a.snapshot.v !== 1) {
      const snapshot = dropUndefined({ ...a.snapshot, ...proofSnapshotPatch });
      const changed = { ...unsigned, snapshot, snapshot_hash: sha256Hex(canonicalize(snapshot)) };
      return { ...changed, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(changed)) } as AnyApprovalProof;
    }
    return { ...unsigned, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(unsigned)) } as AnyApprovalProof;
  }

  /**
   * The outcome statement a 1.6.0 read serves beside the outcome (Appendix G): the approval key's signature over
   * "intent-outcome-v1\n" || JCS(statement without cloud_signature). Its ledger names the approval's entry.
   */
  function servedOutcomeStatement(a: ApprovalRecord, outcome: CloudOutcome, at: number): OutcomeStatement {
    const unsigned: Omit<OutcomeStatement, "cloud_signature"> = {
      v: 1,
      approval_handle: a.handle,
      snapshot_hash: a.snapshotHash,
      outcome,
      ledger: a.ledger ?? { seq: 1, entry_hash: sha256Hex(a.handle) },
      issued_at: timestamp(at),
      kid: keys.approval.kid,
    };
    return { ...unsigned, cloud_signature: keys.approval.sign(OUTCOME_PREFIX + canonicalize(unsigned)) };
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
          return toOffer(offerHandle, item, version, offerPatch);
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

  /** `POST /v1/pause` (contract 1.7.0 draft): a signed, counted pause of the account. */
  function pause(body: Buffer, at: number): Reply {
    const parsed = PauseRequest.safeParse(parseJson(body));
    if (!parsed.success) return fail(400, "bad_request", "body does not match PauseRequest");
    const request = parsed.data;
    const account = accountKeys.get(request.account_key_thumbprint);
    if (account === undefined) return fail(404, "not_found", "unknown account key");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: account.x }, format: "jwk" });
    if (!verifySignature(null, pauseSigningBytes(request), key, Buffer.from(request.signature, "base64url"))) return fail(401, "unauthorized", "bad signature");
    if (Math.abs(Date.parse(request.issued_at) / 1000 - at) > 300) return fail(400, "clock_skew", "issued_at is more than 5 minutes off");
    if (request.counter <= account.counter) return { status: 409, body: { error: "counter_replayed", message: "counter replayed", last_counter: account.counter } };
    account.counter = request.counter;
    accountPaused = true;
    return { status: 200, body: { state: "paused", account_key_thumbprint: request.account_key_thumbprint, counter: request.counter, paused_at: timestamp(at) } };
  }

  function createCart(body: Buffer, keyid: string, ipKey: string, version: ServedVersion, at: number): Reply {
    if (accountPaused) return { status: 409, body: { error: "conflict", message: "purchases are paused for this account", code: "paused" } };
    const json = parseJson(body);
    const v16 = isV16(version);
    // 1.6.x requires the completer key; 1.5.0 has neither 1.6.x field, and its strict schema refuses them.
    const parsed = v16 ? CartRequest.safeParse(json) : CartRequestV1.safeParse(json);
    if (!parsed.success) return fail(400, "bad_request", "body does not match CartRequest");
    const request: Partial<CartRequest> & CartRequestV1 = parsed.data;
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
    if (v16 && [...approvals.values()].some((a) => a.snapshot.v !== 1 && a.snapshot.completer_keyid === request.completer_keyid)) {
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
      if (isV3(version) && item.myshopify_domain !== undefined) cart.myshopify_domain = item.myshopify_domain;
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
    const v1: SnapshotV1 = {
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
    if (isV16(cart.version)) {
      const { body } = cart;
      // The checkout URL's query (`?key=…`) is not part of the hash (amendment L1).
      const checkoutHash = checkoutRefHash(`gid://shopify/Checkout/${cart.handle}?key=${randomBytes(8).toString("hex")}`);
      if (body.completion_mode === undefined || body.merchant_origin === undefined || body.variant_ref === undefined || cart.completer === undefined || checkoutHash === null) {
        throw new Error("a 1.6.x cart without its 1.6.x fields");
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
      // 1.6.1: v3, with the Shopify merchant's myshopify domain from Intent Cloud's own merchant config (not the cart).
      const own: SnapshotV2 | SnapshotV3 =
        isV3(cart.version) ? { ...v2, v: 3, ...(cart.item.myshopify_domain === undefined ? {} : { myshopify_domain: cart.item.myshopify_domain }) } : v2;
      snapshot = snapshotPatch === null ? own : (dropUndefined({ ...own, ...snapshotPatch }) as AnySnapshot);
    }
    const snapshotHash = sha256Hex(canonicalize(snapshot));
    const linkPath = `/c/${randomBytes(16).toString("base64url")}`;
    const created: ApprovalRecord["created"] = {
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
      version: cart.version,
      addressKey: cart.addressKey,
      ...(cart.body.image_url === undefined ? {} : { imageUrl: cart.body.image_url }),
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

  // ---- Submitted checkouts (1.7.0) ------------------------------------------------------------------------------

  const tableVersion = (): string => currencyTableVersion(currencies);
  const refused = (status: 403 | 409, code: RefusalCode, message: string): Reply => ({
    status,
    body: { error: status === 403 ? "forbidden" : "conflict", message, code },
  });

  /** An approval that counts against a buyer's week: approved, a v4 snapshot, not released (no order paid). */
  function countsForWeek(a: ApprovalRecord, buyer: string, currency: string, at: number): boolean {
    if (a.snapshot.v !== 4 || a.snapshot.currency !== currency || a.claimedBy !== buyer || a.approvedAt === undefined) return false;
    if (a.state !== "approved" && a.state !== "handed_off" && a.state !== "ordered") return false;
    if (a.outcome?.state === "failed" || a.outcome?.state === "checkout_expired") return false;
    return at - a.approvedAt < WEEK;
  }

  /**
   * The ceiling a v4 approval breaks now (Appendix A "Currency table and ceiling"), or null: `order` against its own
   * total, `week` against the buyer's other approved, unreleased orders in the same currency plus this one. With no
   * buyer yet (before the passkey) only `order` is checked.
   */
  function ceilingBroken(s: SnapshotV4, buyer: string | undefined, self: string, at: number): "ceiling_order" | "ceiling_week" | null {
    const ceiling = currencies[s.currency];
    if (ceiling === undefined || ceiling.order === 0 || s.totals.total > ceiling.order) return "ceiling_order";
    if (buyer === undefined) return null;
    let week = s.totals.total;
    for (const a of approvals.values()) if (a.handle !== self && countsForWeek(a, buyer, s.currency, at)) week += approvedTotal(a.snapshot).amount_minor;
    return week > ceiling.week ? "ceiling_week" : null;
  }

  /** `POST /v1/checkouts` (1.7.0): a Shop checkout the gateway submits, answered with its pending v4 approval. */
  function createCheckout(body: Buffer, keyid: string, ipKey: string, version: ServedVersion, at: number): Reply {
    if (version !== "1.7.0") return fail(404, "not_found", "not found");
    const json = parseJson(body);
    if (json !== undefined) receivedCheckouts.push(json);
    const parsed = CheckoutRequest.safeParse(json);
    if (!parsed.success) return fail(400, "bad_request", "body does not match CheckoutRequest");
    const request = parsed.data;
    const { checkout } = request;
    const bodyHash = sha256Hex(canonicalize(request));
    if (request.completer_keyid === keyid) return fail(400, "bad_request", "completer_keyid must not be the session key");
    // Replay window: the same session sending the same body gets the same approval again while it is pending.
    for (const a of approvals.values()) {
      refresh(a, at);
      if (a.checkout?.bodyHash === bodyHash && a.owner === keyid && a.state === "pending" && at - a.checkout.createdAt < REPLAY_WINDOW) {
        return { status: 201, body: a.created };
      }
    }
    // Amendment M5 (Appendix C, 1.7.0): a new completer key per request, never an earlier approval's.
    if ([...approvals.values()].some((a) => a.snapshot.v !== 1 && a.snapshot.completer_keyid === request.completer_keyid)) {
      return fail(400, "bad_request", "completer_keyid belongs to an earlier approval");
    }
    if ((request.completion_mode === "handoff") !== (checkout.continue_url !== undefined)) {
      return fail(400, "bad_request", "continue_url is required for handoff and forbidden for shop_agent");
    }
    if (checkout.continue_url !== undefined && !continueUrlAllowed(checkout.continue_url, checkout)) {
      return fail(400, "bad_request", "continue_url is not on shop.app, the myshopify domain or the store site");
    }
    if (coarsePostcode(checkout.ship_to.country, checkout.ship_to.postal_code) !== checkout.ship_to.postal_code) {
      return fail(400, "bad_request", "ship_to.postal_code is not the coarse postcode");
    }
    if (!totalsAddUp(checkout.totals)) return fail(400, "bad_request", "totals do not add up");
    const thumbprint = accountKeyThumbprint(request.account_key);
    if (paused || accountPaused) return refused(409, "paused", "purchases are paused for this account key");
    // The refusals, in Appendix A's order.
    if (request.completion_mode === "shop_agent" && !oneTap) return refused(403, "one_tap_off", "one tap is off");
    if (currencies[checkout.currency] === undefined) return refused(403, "currency_unsupported", "the currency is not supported");
    if (blockedStores.has(checkout.myshopify_domain)) return refused(403, "store_blocked", "the store is blocked");
    if (EXCLUDED_TITLE_WORDS.some((w) => w.test(checkout.title))) return refused(403, "category_excluded", "the item is in an excluded category");
    const ceiling = currencies[checkout.currency];
    if (ceiling === undefined || ceiling.order === 0 || checkout.totals.total > ceiling.order) {
      return refused(403, "ceiling_order", "the total is above the order ceiling");
    }
    // 1.7.0: checkouts per IP key have the carts' quota (higher after a recent passkey approval): 429 `checkouts`.
    const approvedAt = passkeyApprovedAt.get(ipKey);
    const passkeyTier = approvedAt !== undefined && at - approvedAt < PASSKEY_TIER_WINDOW;
    const checkoutRetry = take(`checkouts:${ipKey}`, passkeyTier ? quotas.carts_per_hour_passkey : quotas.carts_per_hour, 3600, at);
    if (checkoutRetry !== null) return limited("checkouts", checkoutRetry);
    const retry = take(`approvals:${ipKey}`, quotas.approvals_per_day, 86_400, at);
    if (retry !== null) return limited("approvals", retry);
    // A new request for the same checkout and mode supersedes this session's pending approval of it.
    for (const a of approvals.values()) {
      if (a.owner === keyid && a.state === "pending" && a.checkout?.checkoutRefHash === checkout.checkout_ref_hash && a.checkout.mode === request.completion_mode) {
        a.state = "expired";
      }
    }

    const approvalHandle = handle("ap");
    const expiresAt = at + APPROVAL_TTL;
    const own: SnapshotV4 = {
      v: 4,
      approval: approvalHandle,
      nonce: randomBytes(16).toString("base64url"),
      expires_at: timestamp(expiresAt),
      rule_version: RULE_VERSION,
      store_name: checkout.store_name,
      store_site: checkout.store_site,
      myshopify_domain: checkout.myshopify_domain,
      variant_ref: checkout.variant_ref,
      title: checkout.title,
      quantity: checkout.quantity,
      currency: checkout.currency,
      totals: checkout.totals,
      ship_to: { country: checkout.ship_to.country, postal_code_coarse: checkout.ship_to.postal_code },
      checkout_ref_hash: checkout.checkout_ref_hash,
      completion_mode: request.completion_mode,
      completer_keyid: request.completer_keyid,
      currency_table: tableVersion(),
      account_key_thumbprint: thumbprint,
      ...(checkout.continue_url === undefined ? {} : { continue_url_hash: continueUrlHash(checkout.continue_url) }),
    };
    const snapshot = snapshotPatch === null ? own : (dropUndefined({ ...own, ...snapshotPatch }) as AnySnapshot);
    const snapshotHash = sha256Hex(canonicalize(snapshot));
    const linkPath = `/c/${randomBytes(16).toString("base64url")}`;
    const created: ApprovalRecord["created"] = {
      approval_handle: approvalHandle,
      approval_link_path: linkPath,
      snapshot,
      snapshot_hash: snapshotHash,
      check_code: snapshotHash.slice(0, 8),
      state: "pending",
      expires_at: timestamp(expiresAt),
    };
    approvals.set(approvalHandle, {
      handle: approvalHandle,
      owner: keyid,
      version,
      addressKey: ipKey,
      cart: null,
      checkout: { bodyHash, createdAt: at, checkoutRefHash: checkout.checkout_ref_hash, mode: request.completion_mode, thumbprint },
      snapshot,
      snapshotHash,
      continueUrl: checkout.continue_url ?? "",
      linkPath,
      expiresAt,
      state: "pending",
      created,
      reports: new Map(),
    });
    return { status: 201, body: created };
  }

  /**
   * Who may read or report an approval (Appendix G R1/R7): the session that created its cart, or, in 1.6.x, the
   * snapshot's completer key until 48 h after the later of `expires_at` and a terminal outcome.
   */
  function mayUse(a: ApprovalRecord, keyid: string, version: ServedVersion, at: number): boolean {
    if (a.owner === keyid) return true;
    if (!isV16(version) || a.snapshot.v === 1 || a.snapshot.completer_keyid !== keyid) return false;
    return at < Math.max(a.expiresAt, a.terminalAt ?? 0) + COMPLETER_WINDOW;
  }

  /** R8 by exact version: a 1.6.x or 1.7.0 approval is read and reported on only in the version that created it. */
  const otherVersion = (a: ApprovalRecord, version: ServedVersion): boolean => isV16(a.version) && version !== a.version;

  const modeOf = (a: ApprovalRecord): CompletionMode => (a.snapshot.v !== 1 ? a.snapshot.completion_mode : "handoff");

  function getApproval(param: string, keyid: string, version: ServedVersion, at: number): Reply {
    if (!ApprovalHandle.safeParse(param).success) return fail(400, "bad_request", "malformed approval handle");
    const a = approvals.get(param);
    if (a === undefined || !mayUse(a, keyid, version, at)) return UNKNOWN_HANDLE();
    // R8: an approval created by a 1.6.x request is read only with that version's header.
    if (otherVersion(a, version)) return UNKNOWN_HANDLE();
    refresh(a, at);
    let state = a.state;
    if (a.outcome !== undefined) {
      const mapped = statusState(a.outcome.state, modeOf(a))[version];
      if (mapped === null) return UNKNOWN_HANDLE();
      state = mapped;
    }
    // A 1.5.0 approval's proof carries its v1 snapshot, which the 1.6.0 ApprovalStatus schema does not allow.
    const s = a.snapshot;
    const status: Omit<ApprovalStatus, "proof"> & { proof?: AnyApprovalProof } = {
      state,
      display: s.v === 4 ? { merchant: s.store_name, title: s.title, total: approvedTotal(s) } : { merchant: s.merchant.name, title: s.item.title, total: s.total },
    };
    if (a.imageUrl !== undefined) status.display.image_url = a.imageUrl;
    if (a.orderNumber !== undefined) status.order_number = a.orderNumber;
    const withProof = state === "approved" || state === "handed_off" || state === "ordered";
    if (withProof && a.approvedBy !== undefined) status.proof = servedProof(a, a.approvedBy, at);
    if (isV16(version) && a.outcome !== undefined) {
      status.outcome = a.outcome;
      status.outcome_statement = servedOutcomeStatement(a, a.outcome, at);
    }
    return { status: 200, body: status };
  }

  /**
   * How Intent Cloud stores a gateway's report (Appendix G R5): source gateway_report, reported assurance, and what the
   * gateway said under `reported`; an ordered or mismatch report is stored as `reported`, the others in their state.
   * Beside an ordered or mismatch report, Intent Cloud's own binding-v1 re-run of the reported values: in 1.6.1 (a v3
   * snapshot, option (a)) every check it cannot observe is `unknown` and only check 5 compares, so a legitimate order
   * is `incomplete`, never `mismatch`; a 1.6.0 approval keeps 1.6.0's re-run, whose check 3 is `differs`.
   */
  function storedOutcome(report: OutcomeReport, snapshot: SnapshotV2 | SnapshotV3 | SnapshotV4): CloudOutcome {
    // Copied by key name: src/ lint forbids reading a property named like `process.binding`.
    const reported = Object.fromEntries(REPORTED_KEYS.filter((k) => report[k] !== undefined).map((k) => [k, report[k]])) as NonNullable<CloudOutcome["reported"]>;
    const ordered = report.state === "ordered" || report.state === "mismatch";
    const state = ordered ? "reported" : report.state;
    const stored: CloudOutcome = { state, source: "gateway_report", assurance: "reported", observed_at: report.observed_at, reported };
    if (!ordered || report.final_total === undefined) return stored;
    if (snapshot.v === 4) {
      // binding-v2 (1.7.0) over what the report gives: only check 5 can compare; every check Intent Cloud cannot
      // observe itself is `unknown`, so a legitimate order is `incomplete`, never `mismatch` (as option (a) for v3).
      const total = bindingV2(snapshot, { final_total: report.final_total }, { mode: snapshot.completion_mode, ship_to_optional: false }).checks.total;
      const checks = { merchant_origin: "unknown", checkout_ref: "unknown", line: "unknown", ship_to: "unknown", total } as const;
      return { ...stored, [BINDING_KEY]: { rule_version: "binding-v2", result: bindingResult(checks, false), checks } };
    }
    const total = totalMatchesApproved(snapshot.total.amount_minor, report.final_total.amount_minor) ? "match" : "differs";
    const checks = { merchant_origin: "unknown", checkout_ref: "unknown", line: snapshot.v === 3 ? "unknown" : "differs", ship_to: "unknown", total } as const;
    const result = Object.values(checks).includes("differs") ? "mismatch" : "incomplete";
    return { ...stored, [BINDING_KEY]: { rule_version: "binding-v1", result, checks } };
  }

  /** R4's transitions of the reported state; `approved` is before any report. Terminal states allow nothing. */
  const NEXT: Readonly<Record<string, readonly string[]>> = {
    approved: ["completing"],
    completing: ["indeterminate", "ordered", "mismatch", "failed"],
    indeterminate: ["ordered", "mismatch", "failed"],
  };

  /** `POST /v1/approvals/{h}/outcome-reports` (Appendix G R1–R7). */
  function reportOutcome(param: string, body: Buffer, keyid: string, version: ServedVersion, at: number): Reply {
    if (!isV16(version)) return fail(404, "not_found", "not found");
    if (!ApprovalHandle.safeParse(param).success) return fail(400, "bad_request", "malformed approval handle");
    const a = approvals.get(param);
    if (a === undefined || a.snapshot.v === 1 || otherVersion(a, version)) return UNKNOWN_HANDLE();
    const snapshot = a.snapshot;
    // R1 first: any key but the cart's session or the completer gets 404, like an unknown handle; then R0.
    if (!mayUse(a, keyid, version, at)) return UNKNOWN_HANDLE();
    if (modeOf(a) !== "shop_agent") return fail(409, "conflict", "not a shop_agent approval");
    if (reportFault !== null) return fail(reportFault, "bad_request", "fake cloud error");
    const parsed = OutcomeReport.safeParse(parseJson(body));
    if (!parsed.success) return fail(400, "bad_request", "body does not match OutcomeReport");
    // The schema holds the field rules (checkout_ref_hash, completing_report_id, the order fields, gateway_precheck).
    const report = parsed.data;
    // R2: the body hash is hex(SHA-256(JCS(body))); a retry resends the same bytes and gets the first answer.
    const hash = sha256Hex(canonicalize(report));
    const prior = a.reports.get(report.report_id);
    if (prior !== undefined) return prior.hash === hash ? prior.reply : fail(409, "conflict", "report_id reused with another body");
    // A v4 approval's reports are bound with binding-v2 (Appendix G, 1.7.0), a v2 or v3 one's with binding-v1.
    const reportedRule = report[BINDING_KEY]?.rule_version;
    if (reportedRule !== undefined && reportedRule !== (snapshot.v === 4 ? "binding-v2" : "binding-v1")) {
      return fail(400, "bad_request", `binding.rule_version must be ${snapshot.v === 4 ? "binding-v2" : "binding-v1"}`);
    }
    refresh(a, at);
    const current = a.reportedState ?? "approved";
    if (report.state === "completing") {
      if (current !== "approved") return fail(409, "conflict", "the approval is already completing");
      if (a.state !== "approved" || at >= a.expiresAt) return fail(410, "gone", "the approval is not approved, or has expired");
      // 1.7.0: the pause and both ceilings again at the completing redemption; the approval stays approved.
      if (snapshot.v === 4) {
        if (paused || accountPaused) return refused(409, "paused", "purchases are paused for this account key");
        // One tap turned off since the approval: a shop_agent redemption is refused, so nothing is paid.
        if (snapshot.completion_mode === "shop_agent" && !oneTap) return refused(409, "one_tap_off", "one tap is off");
        const broken = ceilingBroken(snapshot, a.claimedBy, a.handle, at);
        if (broken !== null) return refused(409, broken, `the ${broken === "ceiling_order" ? "order" : "week"} ceiling is exceeded`);
      }
    } else if (report.completing_report_id !== a.completingReportId) {
      return fail(409, "conflict", "completing_report_id is not the accepted completing report");
    }
    if (!(NEXT[current] ?? []).includes(report.state)) return fail(409, "conflict", `no ${report.state} report after ${current}`);
    const outcome = storedOutcome(report, snapshot);
    a.outcome = outcome;
    a.reportedState = report.state;
    if (report.state === "completing") a.completingReportId = report.report_id;
    // Terminal is judged on the reported state (R4).
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
    [/^\/v1\/checkouts$/, "POST"],
  ];

  /**
   * The version a request is answered in: the header's when this host serves it, 1.5.0 without it; null for a value
   * this host does not serve. A host from before 1.6.0 ignores the header.
   */
  function negotiate(req: IncomingMessage): ServedVersion | null {
    if (!versions.has("1.6.0") && !versions.has("1.6.1") && !versions.has("1.7.0")) return "1.5.0";
    const raw = req.headers["intent-contract-version"];
    if (raw === undefined) return versions.has("1.5.0") ? "1.5.0" : null;
    return SERVED.find((v) => v === raw && versions.has(v)) ?? null;
  }

  function route(method: string, path: string, body: Buffer, req: IncomingMessage, ipKey: string, version: ServedVersion | null, at: number): Reply {
    if (body.length > MAX_BODY_BYTES) return fail(413, "too_large", "body over 16 KiB");
    const retry = take(`requests:${ipKey}`, quotas.requests_per_minute, 60, at);
    if (retry !== null) return limited("requests", retry);
    if (path === "/v1/pause" && method === "POST" && req.headers["intent-contract-version"] === PAUSE_CONTRACT_VERSION) {
      const checked = verifyRequest(req.headers, { method, path, body }, { now: at, seenNonce });
      if (!checked.ok) return checked.status === 400 ? DIGEST_MISMATCH() : UNAUTHORIZED();
      return pause(body, at);
    }
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
      // 1.7.0 adds the currency table; the frozen versions answer exactly as their files say.
      const table = version === "1.7.0" ? { currency_table: { version: tableVersion(), currencies } } : {};
      return { status: 200, body: { contract_version: version, contract_sums_sha256: sums[version], rule_versions: [RULE_VERSION], limits, ...table } };
    }
    if (path === "/v1/catalog/search") return search(body, version, at);
    if (path === "/v1/carts") return createCart(body, keyid, ipKey, version, at);
    if (path === "/v1/checkouts") return createCheckout(body, keyid, ipKey, version, at);
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
      "intent-contract-version": path === "/v1/pause" && req.headers["intent-contract-version"] === PAUSE_CONTRACT_VERSION ? PAUSE_CONTRACT_VERSION : (version ?? CONTRACT_VERSION),
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
    // 1.7.0: the confirm page refuses an approval over either ceiling, or while paused; the decline still works.
    if (action === "approve" && a.snapshot.v === 4) {
      if (paused || accountPaused) return { status: 409, state: a.state, reason: "paused" };
      const broken = ceilingBroken(a.snapshot, passkey.sub, a.handle, at);
      if (broken !== null) return { status: 409, state: a.state, reason: broken };
    }

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
    a.approvedAt = at;
    // Appendix H: the account key is pinned to the buyer at the first passkey approval of a v4 snapshot.
    if (a.snapshot.v === 4) pinnedKeys.add(a.snapshot.account_key_thumbprint);
    passkeyApprovedAt.set(a.addressKey, at);
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
      if (a.snapshot.v !== 1) a.outcome = { state: "handed_off", source: "checkout_page", assurance: "reported", observed_at: timestamp(now()) };
      return { status: 200, state: a.state, continueUrl: a.continueUrl };
    },
    order(h) {
      const a = approvals.get(h);
      if (a === undefined) return { status: 404, reason: "unknown approval" };
      if (a.state !== "handed_off") return { status: 409, state: a.state, reason: `cannot order when ${a.state}` };
      orders += 1;
      a.orderNumber = `ORD-${String(100000 + orders)}`;
      a.state = "ordered";
      if (a.snapshot.v !== 1) {
        const at = now();
        a.outcome = {
          state: "ordered",
          source: "signed_webhook",
          assurance: "verified",
          order_ref: a.orderNumber,
          final_total: approvedTotal(a.snapshot),
          binding: {
            rule_version: a.snapshot.v === 4 ? "binding-v2" : "binding-v1",
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
      if (a.snapshot.v === 1) return { status: 409, state: a.state, reason: "a 1.5.0 approval has no outcome" };
      if (a.state !== "approved" && a.state !== "handed_off") return { status: 409, state: a.state, reason: `no outcome when ${a.state}` };
      if (a.terminalAt !== undefined) return { status: 409, state: a.state, reason: "the outcome is final" };
      const at = now();
      // Parsed, so a test cannot make the fake serve an outcome the 1.6.0 schema refuses (fields, O1, assurance caps).
      a.outcome = CloudOutcomeSchema.parse({ ...outcome, observed_at: timestamp(at) });
      if (TERMINAL.has(outcome.state)) a.terminalAt = at;
      return { status: 200, state: statusState(outcome.state, modeOf(a))["1.6.1"] };
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
    checkouts: {
      received: receivedCheckouts,
      setPaused(on) {
        paused = on;
      },
      setOneTap(on) {
        oneTap = on;
      },
      blockStores(domains) {
        blockedStores = new Set(domains);
      },
      setCurrencies(table) {
        currencies = { ...table };
      },
      pinned: () => [...pinnedKeys],
    },
    accountPause: {
      register(thumbprint, x) {
        accountKeys.set(thumbprint, { x, counter: 0 });
      },
      resume() {
        accountPaused = false;
      },
      get paused() {
        return accountPaused;
      },
      lastCounter(thumbprint) {
        return accountKeys.get(thumbprint)?.counter ?? 0;
      },
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
      offer(patch) {
        offerPatch = patch;
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
        offerPatch = null;
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
