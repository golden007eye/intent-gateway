// The fake Intent Cloud over real HTTP. Receipts, statements and proofs are checked here with code written from
// appendices D, E and F and keys taken from the vector files, not with the fake's own code; where a vector fixes
// the bytes (s1 statement, d1 receipts) the fake must reproduce them exactly.
import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalCreated,
  type ApprovalProof,
  ApprovalStatus,
  Cart,
  ErrorBody,
  Jwks,
  KeyStatement,
  Meta,
  RateLimited,
  Receipt,
  SearchResponse,
} from "../contract/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { createSession, type Session, sessionFromSeed, signRequest } from "../signing/index.ts";
import { verifyApprovalProof, verifyReceipt, verifyStatement } from "../trust/index.ts";
import {
  type CatalogItem,
  CONFIRM_ORIGIN,
  DEFAULT_CATALOG,
  type FakeCloud,
  type FakeCloudOptions,
  SoftPasskey,
  startFakeCloud,
} from "./index.ts";
import { addressKey } from "./server.ts";

const repo = join(import.meta.dirname, "..", "..");
const load = (name: string): unknown => JSON.parse(readFileSync(join(repo, "contract", "vectors", name), "utf8"));

interface S1 {
  expected: { root_public_key_b64url: string; statement: KeyStatement };
}
interface D1 {
  expected: { public_key_b64url: string };
  cases: { name: string; input: { received_at: number }; expected: { intent_receipt: string; intent_receipt_signature: string } }[];
}
interface C2 {
  input: { ed25519_seed_hex: string; method: string; path: string; body: string; created: number; nonce: string };
  expected: { replay: { now: number; status: number } };
  refusals: { name: string; headers: Record<string, string>; body: string; now: number; status: number }[];
}
interface E1 {
  input: { valid_at: number };
  expected: { proof: ApprovalProof };
  refusals: { name: string; step: number; proof: ApprovalProof; approval_handle?: string }[];
}

const s1 = load("s1-key-statement.json") as S1;
const d1 = load("d1-receipt.json") as D1;
const c2 = load("c2-http-signature.json") as C2;
const e1 = load("e1-approval-proof.json") as E1;

const ed25519 = (x: string): KeyObject => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
const ROOT = ed25519(s1.expected.root_public_key_b64url);
const RECEIPT_KEY = ed25519(d1.expected.public_key_b64url);
const DAY = 86_400;
const seconds = (t: string): number => Date.parse(t) / 1000;
const digestOf = (body: Uint8Array): string => `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;

// ---- Independent checks (appendices D, E, F) ---------------------------------------------------------------------

/** Appendix F steps 1–3 against the s1 root. Returns the failing reason, or null. */
function statementProblem(st: KeyStatement, now: number): string | null {
  if (!KeyStatement.safeParse(st).success) return "schema";
  const { signature, ...unsigned } = st;
  const life = seconds(st.expires_at) - seconds(st.issued_at);
  if (life < 90 * DAY || life > 180 * DAY) return "lifetime";
  if (st.kid !== "cloud-root-1") return "root kid";
  if (!verify(null, Buffer.from(`intent-statement-v1\n${canonicalize(unsigned)}`), ROOT, Buffer.from(signature, "base64url"))) return "signature";
  if (seconds(st.issued_at) > now + 300) return "issued ahead";
  if (now >= seconds(st.expires_at)) return "expired";
  return null;
}

interface Sent {
  method: string;
  path: string;
  body: Uint8Array;
  signed?: { keyid: string; nonce: string; created: number };
}

/** Appendix D verification steps 1–5 for the response to `sent`. Returns the failing reason, or null. */
function receiptProblem(res: Response, sent: Sent): string | null {
  const encoded = res.headers.get("intent-receipt");
  const signature = res.headers.get("intent-receipt-signature");
  if (encoded === null || signature === null) return "missing";
  const bytes = Buffer.from(encoded, "base64url");
  const parsed = Receipt.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!parsed.success) return "schema";
  const r = parsed.data;
  if (canonicalize(r) !== bytes.toString("utf8")) return "not canonical";
  if (r.kid !== "cloud-receipt-202610") return "kid";
  const signed = Buffer.concat([Buffer.from("intent-receipt-v1\n"), bytes]);
  if (!verify(null, signed, RECEIPT_KEY, Buffer.from(signature, "base64url"))) return "signature";
  if (r.request.method !== sent.method || r.request.path !== sent.path) return "request line";
  if (r.request.content_digest !== digestOf(sent.body)) return "digest";
  if (sent.signed !== undefined) {
    const { keyid, nonce, created } = sent.signed;
    if (r.request.keyid !== keyid || r.request.nonce !== nonce || r.request.created !== created) return "signature parameters";
  }
  if (r.status !== res.status) return "status";
  return null;
}

/** Appendix E steps 1–6 for an approval the gateway created, against a statement already verified. */
function proofProblem(proof: ApprovalProof, approval: string, st: KeyStatement): string | null {
  if (proof.approval_handle !== approval || proof.snapshot.approval !== approval) return "1 handle";
  const key = st.keys.find((k) => k.kid === proof.kid && k.kid.startsWith("cloud-approval-"));
  if (key === undefined) return "2 kid";
  const { cloud_signature, ...unsigned } = proof;
  const signed = Buffer.from(`intent-approval-v1\n${canonicalize(unsigned)}`);
  if (!verify(null, signed, ed25519(key.x), Buffer.from(cloud_signature, "base64url"))) return "2 cloud signature";
  const hash = sha256Hex(canonicalize(proof.snapshot));
  if (proof.snapshot_hash !== hash) return "3 snapshot hash";
  const clientDataJson = Buffer.from(proof.assertion.client_data_json, "base64url");
  const c = JSON.parse(clientDataJson.toString("utf8")) as Record<string, unknown>;
  const challenge = createHash("sha256").update(canonicalize({ action: "approve", snapshot_hash: hash })).digest("base64url");
  if (c.type !== "webauthn.get" || c.challenge !== challenge || c.origin !== st.confirm_origin) return "4 client data";
  if (c.crossOrigin !== undefined && c.crossOrigin !== false) return "4 crossOrigin";
  const authData = Buffer.from(proof.assertion.authenticator_data, "base64url");
  if (authData.length < 37 || !authData.subarray(0, 32).equals(createHash("sha256").update(st.rp_id).digest())) return "5 rpIdHash";
  if (((authData[32] ?? 0) & 0x05) !== 0x05) return "5 flags";
  const data = Buffer.concat([authData, createHash("sha256").update(clientDataJson).digest()]);
  const passkey = createPublicKey({ key: { ...proof.credential_public_key }, format: "jwk" });
  if (!verify("sha256", data, passkey, Buffer.from(proof.assertion.signature, "base64url"))) return "6 passkey signature";
  return null;
}

// ---- Harness -----------------------------------------------------------------------------------------------------

let clock = Date.parse("2026-10-15T12:00:00Z");
const open: FakeCloud[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function start(options: FakeCloudOptions = {}, at = "2026-10-15T12:00:00Z"): Promise<FakeCloud> {
  clock = Date.parse(at);
  const cloud = await startFakeCloud({ now: () => clock, ...options });
  open.push(cloud);
  return cloud;
}

const nowSeconds = (): number => Math.floor(clock / 1000);
const PROFILE_INPUT =
  /^sig1=\("@method" "@path" "content-digest"\);created=(\d+);nonce="([^"]*)";keyid="([^"]*)";alg="ed25519";tag="intent-gateway-v1"$/;

interface Call {
  res: Response;
  json: unknown;
  sent: Sent;
}

/** Sends one request, signed by `session` unless it is null; `headers` override the signed ones. */
async function call(
  cloud: FakeCloud,
  session: Session | null,
  method: "GET" | "POST",
  path: string,
  body: string | Buffer = "",
  extra: { nonce?: string; created?: number; headers?: Record<string, string> } = {},
): Promise<Call> {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const created = extra.created ?? nowSeconds();
  let headers: Record<string, string> = { accept: "application/json" };
  if (session !== null) {
    const input = { method, path, body: bytes, created, ...(extra.nonce === undefined ? {} : { nonce: extra.nonce }) };
    headers = { ...headers, ...signRequest(session, input) };
  }
  if (method === "POST") headers["content-type"] = "application/json";
  headers = { ...headers, ...extra.headers };
  // The receipt names keyid, nonce and created exactly when the Signature-Input sent follows the profile.
  const profile = PROFILE_INPUT.exec(headers["signature-input"] ?? "");
  const signed = profile === null ? undefined : { created: Number(profile[1]), nonce: profile[2] ?? "", keyid: profile[3] ?? "" };
  const res = await fetch(cloud.url + path, { method, headers, ...(method === "POST" ? { body: new Uint8Array(bytes) } : {}) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { res, json, sent: { method, path, body: bytes, ...(signed === undefined ? {} : { signed }) } };
}

const post = (cloud: FakeCloud, session: Session, path: string, value: unknown): Promise<Call> =>
  call(cloud, session, "POST", path, JSON.stringify(value));

const SHIP = { country: "US", postal_code: "94110" };
// Intent Cloud's error bodies: one body per failure class, whatever the cause inside it.
const UNAUTHORIZED = { error: "unauthorized", message: "authentication failed" };
const DIGEST_MISMATCH = { error: "digest_mismatch", message: "content digest mismatch" };
const UNKNOWN_HANDLE = { error: "not_found", message: "unknown handle" };

async function offerHandle(cloud: FakeCloud, session: Session, title: string): Promise<string> {
  const { json } = await post(cloud, session, "/v1/catalog/search", { ship_to: SHIP });
  const found = SearchResponse.parse(json).offers.find((o) => o.title === title);
  if (found === undefined) throw new Error(`no offer ${title}`);
  return found.offer_handle;
}

async function newApproval(cloud: FakeCloud, session: Session, title = "Trail Runner 3", quantity = 1): Promise<ApprovalCreated> {
  const offer = await offerHandle(cloud, session, title);
  const cart = Cart.parse((await post(cloud, session, "/v1/carts", { offer_handle: offer, quantity, ship_to: SHIP })).json);
  const created = await call(cloud, session, "POST", `/v1/carts/${cart.cart_handle}/approvals`);
  expect(created.res.status).toBe(201);
  return ApprovalCreated.parse(created.json);
}

async function status(cloud: FakeCloud, session: Session, approval: string): Promise<ApprovalStatus> {
  const { res, json } = await call(cloud, session, "GET", `/v1/approvals/${approval}`);
  expect(res.status).toBe(200);
  return ApprovalStatus.parse(json);
}

// ---- Tests -------------------------------------------------------------------------------------------------------

describe("key statement (appendix F)", () => {
  it("is vector s1 byte for byte on s1's issue day, and verifies under the s1 root", async () => {
    const cloud = await start({}, "2026-09-01T08:30:00Z");
    expect(cloud.statement).toEqual(s1.expected.statement);
    const { res, json, sent } = await call(cloud, null, "GET", "/v1/key-statement");
    expect(res.status).toBe(200);
    expect(json).toEqual(s1.expected.statement);
    expect(statementProblem(KeyStatement.parse(json), nowSeconds())).toBeNull();
    expect(receiptProblem(res, sent)).toBeNull();
  });

  it("on any day lists current and next keys, lives 90–180 days and verifies under the s1 root", async () => {
    const cloud = await start();
    const st = KeyStatement.parse((await call(cloud, null, "GET", "/v1/key-statement")).json);
    expect(statementProblem(st, nowSeconds())).toBeNull();
    expect(st.keys.map((k) => k.kid)).toEqual(["cloud-receipt-202610", "cloud-receipt-202611", "cloud-approval-202610", "cloud-approval-202611"]);
    expect(st.keys).toEqual(s1.expected.statement.keys);
    expect(cloud.keys.rootPin).toEqual({ kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: s1.expected.root_public_key_b64url } });
  });

  it("serves at GET /v1/signature-keys, unsigned, only the approval key, as the statement lists it", async () => {
    const cloud = await start();
    const { res, json, sent } = await call(cloud, null, "GET", "/v1/signature-keys");
    expect(res.status).toBe(200);
    expect(receiptProblem(res, sent)).toBeNull();
    const listed = cloud.statement.keys.find((k) => k.kid === "cloud-approval-202610");
    expect(Jwks.parse(json)).toEqual({ keys: [{ kty: "OKP", crv: "Ed25519", kid: "cloud-approval-202610", x: listed?.x, use: "sig", alg: "EdDSA" }] });
  });
});

describe("GET /v1/meta", () => {
  it("reports contract 1.5.0, the vendored SHA256SUMS hash and the version header", async () => {
    const cloud = await start();
    const { res, json } = await call(cloud, createSession(), "GET", "/v1/meta");
    expect(res.status).toBe(200);
    expect(res.headers.get("intent-contract-version")).toBe("1.5.0");
    const meta = Meta.parse(json);
    const source = /sha256 of `SHA256SUMS`: `([0-9a-f]{64})`/.exec(readFileSync(join(repo, "contract", "SOURCE.md"), "utf8"));
    expect(meta.contract_sums_sha256).toBe(source?.[1]);
    expect(meta.contract_version).toBe("1.5.0");
    expect(json).toEqual({
      contract_version: "1.5.0",
      contract_sums_sha256: source?.[1],
      rule_versions: ["recheck-v1"],
      limits: { requests_per_minute: 120, carts_per_hour: 10, carts_per_hour_passkey: 50, approvals_per_day: 20 },
    });
    expect(json).not.toHaveProperty("enrol_origin");
  });

  it("is signed: an unsigned read gets 401 authentication failed", async () => {
    const cloud = await start();
    const { res, json } = await call(cloud, null, "GET", "/v1/meta");
    expect(res.status).toBe(401);
    expect(json).toEqual(UNAUTHORIZED);
  });
});

describe("receipts (appendix D)", () => {
  const c2Session = sessionFromSeed(Buffer.from(c2.input.ed25519_seed_hex, "hex"));
  const fixed: CatalogItem = { ...(DEFAULT_CATALOG[0] as CatalogItem), offer_handle: "of_TEST0001" };
  const c2Call = (cloud: FakeCloud): Promise<Call> =>
    call(cloud, c2Session, "POST", c2.input.path, c2.input.body, { created: c2.input.created, nonce: c2.input.nonce });
  const d1Case = (i: number) => {
    const v = d1.cases[i];
    if (v === undefined) throw new Error("d1 case missing");
    return v;
  };

  it("reproduces d1 case 1 (unsigned key-statement read, 200) byte for byte", async () => {
    const v = d1Case(1);
    const cloud = await start({}, new Date(v.input.received_at * 1000).toISOString());
    const { res } = await call(cloud, null, "GET", "/v1/key-statement");
    expect(res.headers.get("intent-receipt")).toBe(v.expected.intent_receipt);
    expect(res.headers.get("intent-receipt-signature")).toBe(v.expected.intent_receipt_signature);
  });

  it("reproduces d1 case 0 (the c2 cart request, 201) byte for byte", async () => {
    const v = d1Case(0);
    const cloud = await start({ catalog: [fixed] }, new Date(v.input.received_at * 1000).toISOString());
    const { res, json } = await c2Call(cloud);
    expect(res.status).toBe(201);
    Cart.parse(json);
    expect(res.headers.get("intent-receipt")).toBe(v.expected.intent_receipt);
    expect(res.headers.get("intent-receipt-signature")).toBe(v.expected.intent_receipt_signature);
  });

  it("reproduces d1 case 2 (the c2 request refused by a quota, 429) with Retry-After and the RateLimited body", async () => {
    const v = d1Case(2);
    const cloud = await start({ catalog: [fixed], quotas: { carts_per_hour: 0 } }, new Date(v.input.received_at * 1000).toISOString());
    const { res, json } = await c2Call(cloud);
    expect(res.status).toBe(429);
    expect(RateLimited.parse(json).limit).toBe("carts");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("intent-receipt")).toBe(v.expected.intent_receipt);
    expect(res.headers.get("intent-receipt-signature")).toBe(v.expected.intent_receipt_signature);
  });

  it("carries a valid receipt and the version header on every status the edge emits", async () => {
    const cloud = await start({ quotas: { requests_per_minute: 13 } });
    const session = createSession();
    const other = createSession();
    const handle = await offerHandle(cloud, session, "Road Runner 2");
    const cart = Cart.parse((await post(cloud, session, "/v1/carts", { offer_handle: handle, quantity: 1, ship_to: SHIP })).json);
    const cases: [number, Promise<Call>][] = [
      [200, call(cloud, session, "GET", "/v1/meta")],
      [201, post(cloud, session, "/v1/carts", { offer_handle: handle, quantity: 2, ship_to: SHIP })],
      [400, post(cloud, session, "/v1/carts", { offer_handle: handle, quantity: 9, ship_to: SHIP })],
      [401, call(cloud, null, "GET", "/v1/meta")],
      [404, call(cloud, other, "POST", `/v1/carts/${cart.cart_handle}/approvals`)],
      [404, call(cloud, session, "GET", "/v1/nowhere")],
      [405, call(cloud, session, "GET", "/v1/carts")],
      [409, post(cloud, session, "/v1/carts", { offer_handle: handle, quantity: 3, ship_to: SHIP })],
      [413, call(cloud, session, "POST", "/v1/carts", Buffer.alloc(16 * 1024 + 1, 0x20))],
    ];
    for (const [expected, pending] of cases) {
      const { res, json, sent } = await pending;
      expect(res.status, sent.path).toBe(expected);
      expect(res.headers.get("intent-contract-version")).toBe("1.5.0");
      expect(receiptProblem(res, sent)).toBeNull();
      if (expected >= 400) ErrorBody.parse(json);
    }
    clock += 31 * 60_000; // the search's offer handle has expired
    const gone = await post(cloud, session, "/v1/carts", { offer_handle: handle, quantity: 1, ship_to: SHIP });
    expect(gone.res.status).toBe(410);
    expect(receiptProblem(gone.res, gone.sent)).toBeNull();

    for (let i = 0; i < 13; i++) await call(cloud, session, "GET", "/v1/meta");
    const limited = await call(cloud, session, "GET", "/v1/meta");
    expect(limited.res.status).toBe(429);
    expect(RateLimited.parse(limited.json).limit).toBe("requests");
    expect(Number(limited.res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(receiptProblem(limited.res, limited.sent)).toBeNull();
  });

  it("names the parsed keyid, nonce and created even when the signature is invalid, and none when unsigned", async () => {
    const cloud = await start();
    const session = createSession();
    const forged = await call(cloud, session, "GET", "/v1/meta", "", { headers: { signature: `sig1=:${Buffer.alloc(64).toString("base64")}:` } });
    expect(forged.res.status).toBe(401);
    expect(receiptProblem(forged.res, forged.sent)).toBeNull();
    const unsigned = await call(cloud, null, "GET", "/v1/meta");
    const r = Receipt.parse(JSON.parse(Buffer.from(unsigned.res.headers.get("intent-receipt") ?? "", "base64url").toString()));
    expect([r.request.keyid, r.request.nonce, r.request.created]).toEqual([undefined, undefined, undefined]);
  });

  it("answers a simulated 52x with neither a receipt nor the version header, then recovers", async () => {
    const cloud = await start();
    cloud.simulateCloudflareError(522);
    const { res } = await call(cloud, createSession(), "GET", "/v1/meta");
    expect(res.status).toBe(522);
    expect(res.headers.get("intent-contract-version")).toBeNull();
    expect(res.headers.get("intent-receipt")).toBeNull();
    expect(res.headers.get("intent-receipt-signature")).toBeNull();
    cloud.simulateCloudflareError(null);
    const back = await call(cloud, createSession(), "GET", "/v1/meta");
    expect(back.res.status).toBe(200);
    expect(receiptProblem(back.res, back.sent)).toBeNull();
  });
});

describe("request signatures (appendix C)", () => {
  const body = Buffer.from(c2.input.body, "utf8");
  const fixed: CatalogItem = { ...(DEFAULT_CATALOG[0] as CatalogItem), offer_handle: "of_TEST0001" };

  for (const refusal of c2.refusals) {
    it(`answers c2 "${refusal.name}" with ${String(refusal.status)}, the contract error body and a receipt`, async () => {
      const cloud = await start({ catalog: [fixed] }, new Date(refusal.now * 1000).toISOString());
      const { res, json, sent } = await call(cloud, null, "POST", c2.input.path, refusal.body, { headers: refusal.headers });
      expect(res.status).toBe(refusal.status);
      ErrorBody.parse(json);
      expect(json).toEqual(refusal.status === 400 ? DIGEST_MISMATCH : UNAUTHORIZED);
      expect(receiptProblem(res, sent)).toBeNull();
    });
  }

  it("refuses a replayed nonce with 401 (c2 replay), and a forged request does not burn the nonce", async () => {
    const session = sessionFromSeed(Buffer.from(c2.input.ed25519_seed_hex, "hex"));
    const cloud = await start({ catalog: [fixed] }, new Date(c2.input.created * 1000).toISOString());
    const opts = { created: c2.input.created, nonce: c2.input.nonce };
    const forged = await call(cloud, session, "POST", c2.input.path, body, {
      ...opts,
      headers: { signature: `sig1=:${Buffer.alloc(64, 1).toString("base64")}:` },
    });
    expect(forged.res.status).toBe(401);
    expect((await call(cloud, session, "POST", c2.input.path, body, opts)).res.status).toBe(201);
    clock = c2.expected.replay.now * 1000;
    const replay = await call(cloud, session, "POST", c2.input.path, body, opts);
    expect(replay.res.status).toBe(c2.expected.replay.status);
    expect(ErrorBody.parse(replay.json)).toEqual(UNAUTHORIZED);
  });

  it("keeps one nonce store across sessions: a nonce another session used is refused with 401", async () => {
    const cloud = await start();
    const nonce = Buffer.alloc(16, 9).toString("base64url");
    const first = await call(cloud, createSession(), "GET", "/v1/meta", "", { nonce });
    expect(first.res.status).toBe(200);
    const other = await call(cloud, createSession(), "GET", "/v1/meta", "", { nonce });
    expect(other.res.status).toBe(401);
    expect(other.json).toEqual(UNAUTHORIZED);
    expect(receiptProblem(other.res, other.sent)).toBeNull();
  });

  it("refuses missing headers, a short nonce and an unsigned request on a signed endpoint with 401", async () => {
    const cloud = await start();
    const session = createSession();
    const short = Buffer.alloc(15).toString("base64url");
    const params = `("@method" "@path" "content-digest");created=${String(nowSeconds())};nonce="${short}";keyid="${session.keyid}";alg="ed25519";tag="intent-gateway-v1"`;
    const results = [
      await call(cloud, null, "POST", "/v1/catalog/search", JSON.stringify({ ship_to: SHIP })),
      await call(cloud, session, "GET", "/v1/meta", "", { headers: { "signature-input": `sig1=${params}` } }),
      await call(cloud, null, "GET", "/v1/approvals/ap_TEST0001", "", { headers: { "content-digest": digestOf(Buffer.alloc(0)) } }),
    ];
    for (const { res, json, sent } of results) {
      expect(res.status).toBe(401);
      ErrorBody.parse(json);
      expect(receiptProblem(res, sent)).toBeNull();
    }
    // Attack: the body does not tell a prober which check failed.
    expect(results.map((r) => r.json)).toEqual([UNAUTHORIZED, UNAUTHORIZED, UNAUTHORIZED]);
  });
});

describe("catalog, carts and approvals", () => {
  it("returns US offers from *.example merchants, including an electronics and an excluded-category item", async () => {
    const cloud = await start();
    const session = createSession();
    const all = SearchResponse.parse((await post(cloud, session, "/v1/catalog/search", { ship_to: SHIP })).json).offers;
    expect(all.length).toBe(DEFAULT_CATALOG.length);
    for (const offer of all) expect(offer.merchant.domain).toMatch(/\.example$/);
    expect(all.map((o) => o.title)).toEqual(expect.arrayContaining(["Studio Headphones", "Vitamin D3 Gummies"]));
    const shoes = SearchResponse.parse(
      (await post(cloud, session, "/v1/catalog/search", { category: "running-shoes", must_haves: ["trail"], ship_to: SHIP })).json,
    );
    expect(shoes.offers.map((o) => o.title)).toEqual(["Trail Runner 3"]);
    const electronics = await post(cloud, session, "/v1/catalog/search", { category: "electronics", ship_to: SHIP });
    expect(SearchResponse.parse(electronics.json).offers.map((o) => o.title)).toEqual(["Studio Headphones"]);
    const cheap = await post(cloud, session, "/v1/catalog/search", { budget_max: { amount_minor: 2000, currency: "USD" }, ship_to: SHIP });
    expect(SearchResponse.parse(cheap.json).offers.map((o) => o.title)).toEqual(["Ceramic Mug", "Vitamin D3 Gummies"]);
    const nonUs = await post(cloud, session, "/v1/catalog/search", { ship_to: { country: "CA", postal_code: "94110" } });
    expect(nonUs.res.status).toBe(400);
  });

  it("builds the appendix-A snapshot from the cart and keeps the approval pending without a proof", async () => {
    const cloud = await start();
    const session = createSession();
    const created = await newApproval(cloud, session, "Trail Runner 3", 2);
    const s = created.snapshot;
    expect(created.snapshot_hash).toBe(sha256Hex(canonicalize(s)));
    expect(created.check_code).toBe(created.snapshot_hash.slice(0, 8));
    expect(s.approval).toBe(created.approval_handle);
    expect(s.total).toEqual({ amount_minor: 2 * 8999 + 500, currency: "USD" });
    expect(s.ship_to).toEqual({ country: "US", postal_prefix: "941" });
    expect(cloud.inspect(created.approval_handle)?.approval_link).toBe(`https://confirm.example${created.approval_link_path}`);
    const pending = await status(cloud, session, created.approval_handle);
    expect(pending.state).toBe("pending");
    expect(pending.proof).toBeUndefined();
    expect(pending.display).toEqual({
      merchant: "Trail Supply Co",
      title: "Trail Runner 3",
      total: s.total,
      image_url: "https://images.example/p01.webp",
    });
  });

  for (const alg of ["ES256", "RS256"] as const) {
    it(`${alg}: pending → approved → handed_off → ordered, with a proof that verifies independently from approved on`, async () => {
      const cloud = await start();
      const session = createSession();
      const created = await newApproval(cloud, session);
      const passkey = new SoftPasskey({ alg, sub: "buyer-1" });
      expect(cloud.approveWithPasskey(created.approval_handle, passkey)).toEqual({ status: 200, state: "approved" });
      const view = cloud.inspect(created.approval_handle);
      expect(view?.claimed_by).toBe("buyer-1");
      expect(view?.ledger?.seq).toBe(1);

      const approved = await status(cloud, session, created.approval_handle);
      expect(approved.state).toBe("approved");
      const proof = approved.proof;
      if (proof === undefined) throw new Error("no proof");
      expect(proofProblem(proof, created.approval_handle, cloud.statement)).toBeNull();
      expect(proof.snapshot).toEqual(created.snapshot);
      expect(proof.credential_public_key).toEqual(passkey.publicJwk);
      expect(proof.ledger).toEqual(view?.ledger);
      expect(JSON.stringify(proof)).not.toContain("buyer-1");

      expect(proof.issued_at).toBe(new Date(clock).toISOString().replace(/\.\d{3}Z$/, "Z"));

      const handoff = cloud.handoff(created.approval_handle);
      expect(handoff.status).toBe(200);
      expect(`sha256:${sha256Hex(handoff.continueUrl ?? "")}`).toBe(created.snapshot.continue_url_hash);
      expect((await status(cloud, session, created.approval_handle)).state).toBe("handed_off");
      const ordered = cloud.order(created.approval_handle);
      clock += 90_000;
      const final = await status(cloud, session, created.approval_handle);
      expect(final.state).toBe("ordered");
      expect(final.order_number).toBe(ordered.orderNumber);
      // A later read is issued at that read, still names the `approved` ledger entry, and still verifies.
      const later = final.proof;
      if (later === undefined) throw new Error("no proof after order");
      expect(seconds(later.issued_at) - seconds(proof.issued_at)).toBe(90);
      expect(later.ledger).toEqual(proof.ledger);
      expect({ ...later, issued_at: proof.issued_at, cloud_signature: "" }).toEqual({ ...proof, cloud_signature: "" });
      expect(proofProblem(later, created.approval_handle, cloud.statement)).toBeNull();
      expect(cloud.inspect(created.approval_handle)?.ledger).toEqual(proof.ledger);
    });
  }

  it("refuses a second decision with 409, and hand-off or order out of turn", async () => {
    const cloud = await start();
    const session = createSession();
    const created = await newApproval(cloud, session);
    expect(cloud.handoff(created.approval_handle).status).toBe(409);
    expect(cloud.order(created.approval_handle).status).toBe(409);
    cloud.approveWithPasskey(created.approval_handle, new SoftPasskey());
    expect(cloud.reject(created.approval_handle, new SoftPasskey()).status).toBe(409);
    expect(cloud.approveWithPasskey("ap_unknown1", new SoftPasskey()).status).toBe(404);
    expect(cloud.handoff("ap_unknown1").status).toBe(404);
    expect(cloud.order("ap_unknown1").status).toBe(404);
  });

  it("rejects with a passkey over the reject challenge: no proof, ledger entry recorded", async () => {
    const cloud = await start();
    const session = createSession();
    const created = await newApproval(cloud, session);
    expect(cloud.reject(created.approval_handle, new SoftPasskey({ sub: "buyer-2" })).state).toBe("rejected");
    expect(cloud.inspect(created.approval_handle)?.claimed_by).toBe("buyer-2");
    const rejected = await status(cloud, session, created.approval_handle);
    expect(rejected.state).toBe("rejected");
    expect(rejected.proof).toBeUndefined();
  });

  it("the confirm page refuses an assertion over the wrong challenge, origin or flags", async () => {
    const cloud = await start();
    const created = await newApproval(cloud, createSession());
    const passkey = new SoftPasskey();
    const h = created.approval_handle;
    const rejectChallenge = createHash("sha256")
      .update(canonicalize({ action: "reject", snapshot_hash: created.snapshot_hash }))
      .digest("base64url");
    expect(cloud.approveWithPasskey(h, passkey, { challenge: rejectChallenge }).status).toBe(400);
    expect(cloud.approveWithPasskey(h, passkey, { origin: "https://evil.example" }).status).toBe(400);
    expect(cloud.approveWithPasskey(h, passkey, { flags: 0x01 }).status).toBe(400);
    expect(cloud.inspect(h)?.state).toBe("pending");
  });

  it("gives another session 404 for a cart's approvals and for an approval", async () => {
    const cloud = await start();
    const owner = createSession();
    const created = await newApproval(cloud, owner);
    const intruder = createSession();
    const read = await call(cloud, intruder, "GET", `/v1/approvals/${created.approval_handle}`);
    expect(read.res.status).toBe(404);
    const unknown = await call(cloud, owner, "GET", "/v1/approvals/ap_doesnotexist");
    expect(unknown.res.status).toBe(404);
    expect(read.json).toEqual(unknown.json);
    expect(read.json).toEqual(UNKNOWN_HANDLE);
    const ownCart = await post(cloud, owner, "/v1/carts", { offer_handle: await offerHandle(cloud, owner, "Ceramic Mug"), quantity: 1, ship_to: SHIP });
    const foreignCart = await call(cloud, intruder, "POST", `/v1/carts/${Cart.parse(ownCart.json).cart_handle}/approvals`);
    expect([foreignCart.res.status, foreignCart.json]).toEqual([404, UNKNOWN_HANDLE]);
    const offer = await post(cloud, owner, "/v1/carts", { offer_handle: "of_doesnotexist", quantity: 1, ship_to: SHIP });
    expect([offer.res.status, offer.json]).toEqual([404, UNKNOWN_HANDLE]);
    expect((await call(cloud, owner, "GET", "/v1/approvals/bad")).res.status).toBe(400);
    expect((await call(cloud, owner, "POST", "/v1/carts/bad/approvals")).res.status).toBe(400);
  });

  it("replays a cart and an approval within 10 minutes; later a new approval supersedes the pending one", async () => {
    const cloud = await start();
    const session = createSession();
    const offer = await offerHandle(cloud, session, "Trail Runner 3");
    const request = { offer_handle: offer, quantity: 1, ship_to: SHIP };
    const first = Cart.parse((await post(cloud, session, "/v1/carts", request)).json);
    const again = Cart.parse((await post(cloud, session, "/v1/carts", { ...request, ship_to: { country: "US", postal_code: "94199" } })).json);
    expect(again.cart_handle).toBe(first.cart_handle);
    const path = `/v1/carts/${first.cart_handle}/approvals`;
    const a = ApprovalCreated.parse((await call(cloud, session, "POST", path)).json);
    const b = ApprovalCreated.parse((await call(cloud, session, "POST", path)).json);
    expect(b).toEqual(a);
    clock += 11 * 60_000;
    const c = ApprovalCreated.parse((await call(cloud, session, "POST", path)).json);
    expect(c.approval_handle).not.toBe(a.approval_handle);
    expect((await status(cloud, session, a.approval_handle)).state).toBe("expired");
    expect(cloud.approveWithPasskey(a.approval_handle, new SoftPasskey()).status).toBe(410);
    clock += 5 * 60_000; // past the cart's 15 minutes
    expect((await call(cloud, session, "POST", path)).res.status).toBe(410);
  });

  it("answers 404 not_found off the endpoints and 405 not_found for another method, each with a receipt", async () => {
    const cloud = await start();
    const session = createSession();
    for (const [method, path, expected] of [
      ["GET", "/v1/nowhere", 404],
      ["POST", "/v2/meta", 404],
      ["POST", "/v1/meta", 405],
      ["GET", "/v1/catalog/search", 405],
      ["POST", "/v1/key-statement", 405],
      ["GET", "/v1/carts/ct_x/approvals", 405],
      ["POST", "/v1/approvals/ap_x", 405],
    ] as const) {
      const { res, json, sent } = await call(cloud, session, method, path);
      expect(res.status, `${method} ${path}`).toBe(expected);
      expect(ErrorBody.parse(json).error).toBe("not_found");
      expect(receiptProblem(res, sent)).toBeNull();
    }
  });

  it("limits carts per address key: a new session resets nothing, a replay counts once, Retry-After is the oldest cart", async () => {
    const cloud = await start({ quotas: { carts_per_hour: 2 } });
    const first = createSession();
    const offer = await offerHandle(cloud, first, "Trail Runner 3");
    const request = { offer_handle: offer, quantity: 1, ship_to: SHIP };
    expect((await post(cloud, first, "/v1/carts", request)).res.status).toBe(201);
    expect((await post(cloud, first, "/v1/carts", request)).res.status).toBe(201); // the same cart: counted once
    clock += 10 * 60_000;
    const second = createSession(); // a new session key on the same address
    expect((await post(cloud, second, "/v1/carts", request)).res.status).toBe(201);
    const third = createSession();
    const refused = await post(cloud, third, "/v1/carts", request);
    expect(refused.res.status).toBe(429);
    // The oldest counted cart leaves the hour 50 minutes from now.
    expect(refused.json).toEqual({ error: "rate_limited", message: "the carts limit is used up; retry later", limit: "carts", retry_after_seconds: 3000 });
    expect(refused.res.headers.get("retry-after")).toBe("3000");
    expect(receiptProblem(refused.res, refused.sent)).toBeNull();
    clock += 3000 * 1000;
    const fresh = { ...request, offer_handle: await offerHandle(cloud, third, "Trail Runner 3") }; // the first expired
    expect((await post(cloud, third, "/v1/carts", fresh)).res.status).toBe(201);
  });

  it("raises an address key to the passkey tier for 24 h once a cart from it is approved by passkey", async () => {
    const cloud = await start({ quotas: { carts_per_hour: 1, carts_per_hour_passkey: 3 } });
    const session = createSession();
    const created = await newApproval(cloud, session); // cart 1 of 1
    const mug = { offer_handle: await offerHandle(cloud, session, "Ceramic Mug"), quantity: 1, ship_to: SHIP };
    expect((await post(cloud, session, "/v1/carts", mug)).res.status).toBe(429);
    cloud.approveWithPasskey(created.approval_handle, new SoftPasskey());
    const other = createSession();
    expect((await post(cloud, other, "/v1/carts", mug)).res.status).toBe(201); // 2 of 3
    expect((await post(cloud, other, "/v1/carts", { ...mug, quantity: 2 })).res.status).toBe(201); // 3 of 3
    const limited = await post(cloud, other, "/v1/carts", { ...mug, quantity: 3 });
    expect(RateLimited.parse(limited.json).limit).toBe("carts");
    clock += 24 * 3600_000; // the hour and the 24 h tier have both passed
    const again = { ...mug, offer_handle: await offerHandle(cloud, other, "Ceramic Mug") };
    expect((await post(cloud, other, "/v1/carts", again)).res.status).toBe(201);
    expect((await post(cloud, other, "/v1/carts", { ...again, quantity: 2 })).res.status).toBe(429);
  });

  it("names no owner, claimer or user handle in any response body", async () => {
    const cloud = await start();
    const session = createSession();
    const passkey = new SoftPasskey({ sub: "buyer-sub-7" });
    const offer = await offerHandle(cloud, session, "Trail Runner 3");
    const cart = await post(cloud, session, "/v1/carts", { offer_handle: offer, quantity: 1, ship_to: SHIP });
    const handle = Cart.parse(cart.json).cart_handle;
    const created = await call(cloud, session, "POST", `/v1/carts/${handle}/approvals`);
    const approval = ApprovalCreated.parse(created.json).approval_handle;
    cloud.approveWithPasskey(approval, passkey);
    const bodies = [cart, created, await call(cloud, session, "GET", `/v1/approvals/${approval}`)].map((c) => JSON.stringify(c.json));
    cloud.handoff(approval);
    cloud.order(approval);
    bodies.push(JSON.stringify((await call(cloud, session, "GET", `/v1/approvals/${approval}`)).json));
    for (const body of bodies) {
      expect(body).not.toContain(session.keyid);
      expect(body).not.toContain("buyer-sub-7");
      expect(body).not.toMatch(/owner|claim|user_?handle/i);
    }
  });

  it("limits new approvals per day with 429 approvals", async () => {
    const cloud = await start({ quotas: { approvals_per_day: 1 } });
    const session = createSession();
    const created = await newApproval(cloud, session);
    clock += 11 * 60_000;
    const cart = await post(cloud, session, "/v1/carts", { offer_handle: await offerHandle(cloud, session, "Ceramic Mug"), quantity: 1, ship_to: SHIP });
    const more = await call(cloud, session, "POST", `/v1/carts/${Cart.parse(cart.json).cart_handle}/approvals`);
    expect(more.res.status).toBe(429);
    expect(RateLimited.parse(more.json)).toMatchObject({ limit: "approvals", message: "the approvals limit is used up; retry later" });
    expect(created.state).toBe("pending");
  });
});

describe("tamper hooks", () => {
  it("receiptSignature, receiptDigest and dropReceipt each break the receipt check, and reset restores it", async () => {
    const cloud = await start();
    const session = createSession();
    cloud.tamper.receiptSignature();
    let r = await call(cloud, session, "GET", "/v1/meta");
    expect(receiptProblem(r.res, r.sent)).toBe("signature");
    cloud.tamper.reset();
    cloud.tamper.receiptDigest("/v1/meta");
    r = await call(cloud, session, "GET", "/v1/meta");
    expect(receiptProblem(r.res, r.sent)).toBe("digest");
    r = await call(cloud, session, "GET", "/v1/key-statement");
    expect(receiptProblem(r.res, r.sent)).toBeNull();
    cloud.tamper.reset();
    cloud.tamper.dropReceipt();
    r = await call(cloud, session, "GET", "/v1/meta");
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("intent-contract-version")).toBe("1.5.0");
    expect(receiptProblem(r.res, r.sent)).toBe("missing");
    const refused = await call(cloud, null, "GET", "/v1/meta");
    expect(receiptProblem(refused.res, refused.sent)).toBeNull();
    cloud.tamper.reset();
    r = await call(cloud, session, "GET", "/v1/meta");
    expect(receiptProblem(r.res, r.sent)).toBeNull();
  });

  it("statementNonRoot and statementExpired each fail the statement check", async () => {
    const cloud = await start();
    cloud.tamper.statementNonRoot();
    let st = KeyStatement.parse((await call(cloud, null, "GET", "/v1/key-statement")).json);
    expect(st.kid).toBe("cloud-root-1");
    expect(statementProblem(st, nowSeconds())).toBe("signature");
    cloud.tamper.reset();
    cloud.tamper.statementExpired();
    st = KeyStatement.parse((await call(cloud, null, "GET", "/v1/key-statement")).json);
    expect(statementProblem(st, nowSeconds())).toBe("expired");
  });

  it("proofHash and proofUnknownKid each fail the proof check; secondCredential approves with another passkey", async () => {
    const cloud = await start();
    const session = createSession();
    const created = await newApproval(cloud, session);
    const h = created.approval_handle;
    const first = new SoftPasskey();
    cloud.approveWithPasskey(h, first);
    const proofOf = async (): Promise<ApprovalProof> => {
      const p = (await status(cloud, session, h)).proof;
      if (p === undefined) throw new Error("no proof");
      return p;
    };
    cloud.tamper.proofHash();
    expect(proofProblem(await proofOf(), h, cloud.statement)).toBe("3 snapshot hash");
    cloud.tamper.reset();
    cloud.tamper.proofUnknownKid();
    expect(proofProblem(await proofOf(), h, cloud.statement)).toBe("2 kid");
    cloud.tamper.reset();
    expect(proofProblem(await proofOf(), h, cloud.statement)).toBeNull();

    const next = await newApproval(cloud, session, "Ceramic Mug");
    const { outcome, passkey } = cloud.tamper.secondCredential(next.approval_handle);
    expect(outcome.state).toBe("approved");
    const proof = (await status(cloud, session, next.approval_handle)).proof;
    expect(proof === undefined ? "none" : proofProblem(proof, next.approval_handle, cloud.statement)).toBeNull();
    expect(proof?.assertion.credential_id).toBe(passkey.credentialId);
    expect(proof?.assertion.credential_id).not.toBe(first.credentialId);
  });
});

describe("the gateway's trust module (G15) accepts the fake and refuses its tampering", () => {
  const pin = (cloud: FakeCloud) => [cloud.keys.rootPin];
  const keySetOf = (cloud: FakeCloud, st: unknown) => {
    const result = verifyStatement(st, pin(cloud), new Date(clock));
    if (!result.ok) throw new Error(`statement refused: ${result.reason}`);
    return result.keySet;
  };
  const sentOf = (c: Call) => ({ method: c.sent.method, path: c.sent.path, content_digest: digestOf(c.sent.body), ...c.sent.signed });
  const responseOf = (c: Call) => ({
    status: c.res.status,
    receipt: c.res.headers.get("intent-receipt") ?? undefined,
    signature: c.res.headers.get("intent-receipt-signature") ?? undefined,
  });

  it("verifyStatement, verifyReceipt and verifyApprovalProof accept the fake's statement, receipts and proof", async () => {
    const cloud = await start();
    const session = createSession();
    const keySet = keySetOf(cloud, (await call(cloud, null, "GET", "/v1/key-statement")).json);
    const meta = await call(cloud, session, "GET", "/v1/meta");
    expect(verifyReceipt(responseOf(meta), sentOf(meta), keySet, new Date(clock)).ok).toBe(true);

    const created = await newApproval(cloud, session);
    const pending = {
      kind: "approval_pending",
      body: { handle: created.approval_handle, approval_url: `${CONFIRM_ORIGIN}${created.approval_link_path}`, snapshot_hash: created.snapshot_hash },
    };
    cloud.approveWithPasskey(created.approval_handle, new SoftPasskey({ alg: "RS256" }));
    const approved = await call(cloud, session, "GET", `/v1/approvals/${created.approval_handle}`);
    expect(verifyApprovalProof(approved.json, pending, keySet, [pending], new Date(clock)).ok).toBe(true);

    cloud.tamper.proofHash();
    const badHash = await call(cloud, session, "GET", `/v1/approvals/${created.approval_handle}`);
    expect(verifyApprovalProof(badHash.json, pending, keySet, [pending], new Date(clock))).toMatchObject({ ok: false, step: 3 });
    cloud.tamper.reset();
    cloud.tamper.proofUnknownKid();
    const badKid = await call(cloud, session, "GET", `/v1/approvals/${created.approval_handle}`);
    expect(verifyApprovalProof(badKid.json, pending, keySet, [pending], new Date(clock))).toMatchObject({ ok: false, step: 2, reason: "unknown_kid" });
    cloud.tamper.reset();
    cloud.tamper.receiptSignature();
    const badReceipt = await call(cloud, session, "GET", "/v1/meta");
    expect(verifyReceipt(responseOf(badReceipt), sentOf(badReceipt), keySet, new Date(clock))).toMatchObject({ ok: false, step: 3 });
    cloud.tamper.reset();
    cloud.tamper.receiptDigest();
    const otherDigest = await call(cloud, session, "GET", "/v1/meta");
    expect(verifyReceipt(responseOf(otherDigest), sentOf(otherDigest), keySet, new Date(clock))).toMatchObject({ ok: false, step: 4 });
  });

  it("verifyStatement refuses the non-root and expired statements", async () => {
    const cloud = await start();
    cloud.tamper.statementNonRoot();
    const nonRoot = (await call(cloud, null, "GET", "/v1/key-statement")).json;
    expect(verifyStatement(nonRoot, pin(cloud), new Date(clock))).toMatchObject({ ok: false, step: 2, reason: "bad_signature" });
    cloud.tamper.reset();
    cloud.tamper.statementExpired();
    const expired = (await call(cloud, null, "GET", "/v1/key-statement")).json;
    expect(verifyStatement(expired, pin(cloud), new Date(clock))).toMatchObject({ ok: false, step: 3, reason: "expired" });
  });
});

describe("address keys", () => {
  it("count IPv4 (also IPv4-mapped) by address and IPv6 by its /64", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    // Attack: rotating addresses inside one /64 stays on one key; the next /64 is another key.
    expect(addressKey("2001:db8:1:2::9")).toBe(addressKey("2001:db8:1:2:1:2:3:4"));
    expect(addressKey("2001:db8:1:3::9")).not.toBe(addressKey("2001:db8:1:2::9"));
  });
});

describe("independent checkers", () => {
  // The checks above are only evidence if they accept the published vectors and refuse their broken variants.
  it("accept e1 and refuse each of its refusals", () => {
    expect(proofProblem(e1.expected.proof, "ap_TEST0001", s1.expected.statement)).toBeNull();
    for (const refusal of e1.refusals) {
      const asked = refusal.approval_handle ?? "ap_TEST0001";
      expect(proofProblem(refusal.proof, asked, s1.expected.statement)?.split(" ")[0], refusal.name).toBe(String(refusal.step));
    }
    expect(statementProblem(s1.expected.statement, e1.input.valid_at)).toBeNull();
  });
});
