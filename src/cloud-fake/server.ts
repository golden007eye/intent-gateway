// The fake Intent Cloud: an HTTP server on 127.0.0.1 that plays both the edge (body cap, request limit, appendix-C
// signature check, receipts on every response) and the platform behind it (catalog, carts, approvals, proofs).
// It follows contract/gateway-api.v1.yaml and appendices A–F; the confirm page is driven from the test through
// `approveWithPasskey` and `reject`.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ApprovalCreated,
  type ApprovalProof,
  type ApprovalState,
  type ApprovalStatus,
  type Cart,
  CartHandle,
  ApprovalHandle,
  CartRequest,
  CONTRACT_VERSION,
  type KeyStatement,
  type Offer,
  type ReceiptRequest as ReceiptRequestType,
  ReceiptRequest,
  SearchRequest,
  type ShipTo,
  type Snapshot,
} from "../contract/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { contentDigest, createNonceCache, verifyRequest } from "../signing/index.ts";
import { type CatalogItem, DEFAULT_CATALOG, matches } from "./catalog.ts";
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
const RULE_VERSION = "recheck-v1";

export interface Quotas {
  /** Edge requests per minute per client address (any endpoint). */
  requests_per_minute: number;
  /** New carts per hour per client address. */
  carts_per_hour: number;
  /** Reported in `Meta.limits` only. */
  carts_per_hour_passkey: number;
  /** New approvals per day per client address. */
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
  quotas?: Partial<Quotas>;
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
  snapshot: Snapshot;
  snapshot_hash: string;
  /** The key statement's confirm_origin + approval_link_path. */
  approval_link: string;
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
  /** The merchant reports the order: handed_off → ordered. */
  order(handle: string): Outcome;
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
  snapshot: Snapshot;
  snapshotHash: string;
  continueUrl: string;
  linkPath: string;
  expiresAt: number;
  state: ApprovalState;
  created: ApprovalCreated;
  claimedBy?: string;
  ledger?: { seq: number; entry_hash: string };
  proof?: ApprovalProof;
  orderNumber?: string;
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

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function toOffer(offerHandle: string, item: CatalogItem): Offer {
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
  return offer;
}

/** Starts the fake on 127.0.0.1. */
export async function startFakeCloud(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  const clockMs = options.now ?? Date.now;
  const now = (): number => Math.floor(clockMs() / 1000);
  const quotas: Quotas = { ...DEFAULT_QUOTAS, ...options.quotas };
  const keys = loadKeys();
  const sums = sha256Hex(readFileSync(new URL("../../contract/SHA256SUMS", import.meta.url)));
  const statement = makeStatement(keys, now());
  const seenNonce = createNonceCache();

  const offers = new Map<string, OfferRecord>();
  const carts = new Map<string, CartRecord>();
  const approvals = new Map<string, ApprovalRecord>();
  const buckets = new Map<string, number[]>();
  const faults = new Map<Fault, string | undefined>();
  const ledger: { seq: number; entry_hash: string }[] = [];
  let orders = 0;
  let cloudflareStatus: number | null = null;

  const catalog = options.catalog ?? DEFAULT_CATALOG;
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

  const limited = (limit: string, retry: number): Reply => ({
    status: 429,
    body: { error: "rate_limited", message: `${limit} limit reached`, limit, retry_after_seconds: retry },
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

  function servedProof(proof: ApprovalProof): ApprovalProof {
    const unsigned: Omit<ApprovalProof, "cloud_signature"> & { cloud_signature?: string } = { ...proof };
    delete unsigned.cloud_signature;
    if (faults.has("proofHash")) {
      const changed = { ...unsigned, snapshot_hash: sha256Hex("not the snapshot") };
      return { ...changed, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(changed)) };
    }
    if (faults.has("proofUnknownKid")) {
      const changed = { ...unsigned, kid: "cloud-approval-209912" };
      return { ...changed, cloud_signature: randomKey(changed.kid).sign(APPROVAL_PREFIX + canonicalize(changed)) };
    }
    return proof;
  }

  // ---- Platform handlers (behind the edge) -------------------------------------------------------------------

  function search(body: Buffer, at: number): Reply {
    const parsed = SearchRequest.safeParse(parseJson(body));
    if (!parsed.success) return fail(400, "bad_request", "body does not match SearchRequest");
    const found = catalog.filter((item) => matches(item, parsed.data)).slice(0, 20);
    return {
      status: 200,
      body: {
        offers: found.map((item) => {
          const offerHandle = item.offer_handle ?? handle("of");
          if (item.offer_handle === undefined) offers.set(offerHandle, { item, expiresAt: at + OFFER_TTL });
          return toOffer(offerHandle, item);
        }),
      },
    };
  }

  function createCart(body: Buffer, keyid: string, ip: string, at: number): Reply {
    const parsed = CartRequest.safeParse(parseJson(body));
    if (!parsed.success) return fail(400, "bad_request", "body does not match CartRequest");
    const request = parsed.data;
    const offer = offers.get(request.offer_handle);
    if (offer === undefined) return fail(404, "not_found", "unknown offer");
    if (offer.expiresAt !== null && at >= offer.expiresAt) return fail(410, "gone", "offer expired");
    const zip3 = request.ship_to.postal_code.slice(0, 3);
    for (const cart of carts.values()) {
      const same =
        cart.owner === keyid &&
        cart.offerHandle === request.offer_handle &&
        cart.quantity === request.quantity &&
        cart.shipTo.postal_code.slice(0, 3) === zip3;
      const live = at - cart.createdAt < REPLAY_WINDOW && at < cart.expiresAt;
      if (same && live && (cart.latest === undefined || cart.latest.state === "pending")) return { status: 201, body: cart.body };
    }
    if (request.quantity > offer.item.stock) return fail(409, "conflict", "not enough stock");
    const retry = take(`carts:${ip}`, quotas.carts_per_hour, 3600, at);
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
    carts.set(cartHandle, {
      handle: cartHandle,
      owner: keyid,
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

  function createApproval(param: string, keyid: string, ip: string, at: number): Reply {
    if (!CartHandle.safeParse(param).success) return fail(400, "bad_request", "malformed cart handle");
    const cart = carts.get(param);
    if (cart?.owner !== keyid) return fail(404, "not_found", "unknown cart");
    if (at >= cart.expiresAt) return fail(410, "gone", "cart expired");
    const latest = cart.latest;
    if (latest !== undefined) refresh(latest, at);
    if (latest?.state === "pending" && cart.lastNewApprovalAt !== undefined && at - cart.lastNewApprovalAt < REPLAY_WINDOW) {
      return { status: 201, body: latest.created };
    }
    const retry = take(`approvals:${ip}`, quotas.approvals_per_day, 86_400, at);
    if (retry !== null) return limited("approvals", retry);
    if (latest?.state === "pending") latest.state = "expired";

    const approvalHandle = handle("ap");
    const expiresAt = Math.min(cart.expiresAt, at + APPROVAL_TTL);
    const continueUrl = `https://${cart.item.merchant.domain}/checkout/${cart.handle}`;
    const snapshot: Snapshot = {
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
    };
    approvals.set(approvalHandle, record);
    cart.latest = record;
    cart.lastNewApprovalAt = at;
    return { status: 201, body: created };
  }

  function getApproval(param: string, keyid: string, at: number): Reply {
    if (!ApprovalHandle.safeParse(param).success) return fail(400, "bad_request", "malformed approval handle");
    const a = approvals.get(param);
    if (a?.owner !== keyid) return fail(404, "not_found", "unknown approval");
    refresh(a, at);
    const status: ApprovalStatus = {
      state: a.state,
      display: { merchant: a.snapshot.merchant.name, title: a.snapshot.item.title, total: a.snapshot.total },
    };
    if (a.cart.body.image_url !== undefined) status.display.image_url = a.cart.body.image_url;
    if (a.orderNumber !== undefined) status.order_number = a.orderNumber;
    const withProof = a.state === "approved" || a.state === "handed_off" || a.state === "ordered";
    if (withProof && a.proof !== undefined) status.proof = servedProof(a.proof);
    return { status: 200, body: status };
  }

  // ---- The edge -------------------------------------------------------------------------------------------------

  function route(method: string, path: string, body: Buffer, req: IncomingMessage, ip: string, at: number): Reply {
    if (body.length > MAX_BODY_BYTES) return fail(413, "too_large", "body over 16 KiB");
    const retry = take(`requests:${ip}`, quotas.requests_per_minute, 60, at);
    if (retry !== null) return limited("requests", retry);

    if (method === "GET" && path === "/v1/signature-keys") {
      const listed = [keys.receipt, keys.approval].map((k) => ({ kty: "OKP", crv: "Ed25519", kid: k.kid, x: k.x, use: "sig", alg: "EdDSA" }));
      return { status: 200, body: { keys: listed } };
    }
    if (method === "GET" && path === "/v1/key-statement") return { status: 200, body: servedStatement(at) };

    const cartApprovals = /^\/v1\/carts\/([^/]+)\/approvals$/.exec(path);
    const approval = /^\/v1\/approvals\/([^/]+)$/.exec(path);
    const known =
      (method === "GET" && (path === "/v1/meta" || approval !== null)) ||
      (method === "POST" && (path === "/v1/catalog/search" || path === "/v1/carts" || cartApprovals !== null));
    if (!known) return fail(404, "not_found", "no such endpoint");

    const verified = verifyRequest(req.headers, { method, path, body }, { now: at, seenNonce });
    if (!verified.ok) {
      return verified.status === 400 ? fail(400, "digest_mismatch", "content-digest does not match the body") : fail(401, "unauthorized", verified.code);
    }
    const { keyid } = verified;
    if (path === "/v1/meta") {
      const limits = {
        requests_per_minute: Math.max(1, quotas.requests_per_minute),
        carts_per_hour: Math.max(1, quotas.carts_per_hour),
        carts_per_hour_passkey: Math.max(1, quotas.carts_per_hour_passkey),
        approvals_per_day: Math.max(1, quotas.approvals_per_day),
      };
      return { status: 200, body: { contract_version: CONTRACT_VERSION, contract_sums_sha256: sums, rule_versions: [RULE_VERSION], limits } };
    }
    if (path === "/v1/catalog/search") return search(body, at);
    if (path === "/v1/carts") return createCart(body, keyid, ip, at);
    if (cartApprovals !== null) return createApproval(cartApprovals[1] ?? "", keyid, ip, at);
    return getApproval(approval?.[1] ?? "", keyid, at);
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
    const ip = req.socket.remoteAddress ?? "unknown";
    let reply: Reply;
    try {
      reply = route(method, path, body, req, ip, at);
    } catch {
      reply = fail(500, "bad_request", "fake cloud error");
    }
    const bytes = Buffer.from(JSON.stringify(reply.body), "utf8");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(bytes.length),
      "intent-contract-version": CONTRACT_VERSION,
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
    const unsigned = {
      v: 1 as const,
      approval_handle: a.handle,
      snapshot: a.snapshot,
      snapshot_hash: a.snapshotHash,
      assertion,
      credential_public_key: passkey.publicJwk,
      ledger: ref,
      issued_at: timestamp(at),
      kid: keys.approval.kid,
    };
    a.proof = { ...unsigned, cloud_signature: keys.approval.sign(APPROVAL_PREFIX + canonicalize(unsigned)) };
    a.state = "approved";
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
      // Appendix A hand-off invariant: redirect only to a URL whose hash is in the snapshot.
      if (`sha256:${sha256Hex(a.continueUrl)}` !== a.snapshot.continue_url_hash) {
        a.state = "expired";
        return { status: 409, state: a.state, reason: "continue_url does not match the snapshot" };
      }
      a.state = "handed_off";
      return { status: 200, state: a.state, continueUrl: a.continueUrl };
    },
    order(h) {
      const a = approvals.get(h);
      if (a === undefined) return { status: 404, reason: "unknown approval" };
      if (a.state !== "handed_off") return { status: 409, state: a.state, reason: `cannot order when ${a.state}` };
      orders += 1;
      a.orderNumber = `ORD-${String(100000 + orders)}`;
      a.state = "ordered";
      return { status: 200, state: a.state, orderNumber: a.orderNumber };
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
      };
      if (a.claimedBy !== undefined) view.claimed_by = a.claimedBy;
      if (a.ledger !== undefined) view.ledger = a.ledger;
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
      reset() {
        faults.clear();
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
