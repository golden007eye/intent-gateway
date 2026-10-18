// The fake Intent Cloud's contract 1.6.x (version negotiation, snapshots v2 and v3, the completer key, mode choice,
// the myshopify pair, outcome reports R1–R8 and R5 option (a), and the state table of Appendix G, vector o3), over
// real HTTP with requests signed here. Requests speak 1.6.1, as the gateway does, unless a test names another version.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCreated, ApprovalStatus, Cart, type CompletionMode, ErrorBody, Meta, OutcomeReportAccepted, SearchResponse, SnapshotV2, SnapshotV3 } from "../contract/index.ts";
import { createSession, type Session, signRequest } from "../signing/index.ts";
import { type CatalogItem, DEFAULT_CATALOG, type FakeCloud, type FakeCloudOptions, SoftPasskey, startFakeCloud, statusState } from "./index.ts";

const repo = join(import.meta.dirname, "..", "..");
const T0 = Date.parse("2026-10-15T12:00:00Z");
const HOUR = 3_600_000;
const SHIP = { country: "US", postal_code: "94110" } as const;
let clock = T0;
const open: FakeCloud[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function start(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  clock = T0;
  const cloud = await startFakeCloud({ now: () => clock, ...options });
  open.push(cloud);
  return cloud;
}

/** One signed request; `version` null sends no Intent-Contract-Version header. */
async function call(
  cloud: FakeCloud,
  session: Session,
  method: "GET" | "POST",
  path: string,
  value?: unknown,
  version: string | null = "1.6.1",
): Promise<{ status: number; version: string | null; json: unknown }> {
  const body = Buffer.from(value === undefined ? "" : JSON.stringify(value), "utf8");
  const headers: Record<string, string> = { accept: "application/json", ...signRequest(session, { method, path, body, created: Math.floor(clock / 1000) }) };
  if (method === "POST") headers["content-type"] = "application/json";
  if (version !== null) headers["intent-contract-version"] = version;
  const res = await fetch(cloud.url + path, { method, headers, ...(method === "POST" ? { body: new Uint8Array(body) } : {}) });
  const text = await res.text();
  return { status: res.status, version: res.headers.get("intent-contract-version"), json: JSON.parse(text) as unknown };
}

const SHOP_AGENT_ITEM: CatalogItem = { ...(DEFAULT_CATALOG[0] as CatalogItem), completion: ["shop_agent", "handoff"], myshopify_domain: "trail-supply.myshopify.com" };

interface Purchase {
  session: Session;
  completer: Session;
  handle: string;
  created: ApprovalCreated;
  cart: Cart;
}

/** Search, cart and approval in `version` (1.6.1 by default) with a fresh session and completer key. */
async function purchase(cloud: FakeCloud, accepts: CompletionMode[] = ["handoff"], version = "1.6.1"): Promise<Purchase> {
  const session = createSession();
  const completer = createSession();
  const search = await call(cloud, session, "POST", "/v1/catalog/search", { category: "running-shoes", ship_to: SHIP }, version);
  const offer = SearchResponse.parse(search.json).offers[0];
  if (offer === undefined) throw new Error("no offer");
  expect(offer.variant_ref).toMatch(/^gid:\/\/shopify\/ProductVariant\/\d+$/);
  const cartReply = await call(cloud, session, "POST", "/v1/carts", {
    offer_handle: offer.offer_handle,
    quantity: 1,
    ship_to: SHIP,
    completer_keyid: completer.keyid,
    completion_accepts: accepts,
  }, version);
  expect(cartReply.status).toBe(201);
  const cart = Cart.parse(cartReply.json);
  const approval = await call(cloud, session, "POST", `/v1/carts/${cart.cart_handle}/approvals`, undefined, version);
  expect(approval.status).toBe(201);
  const json = approval.json as { snapshot: unknown };
  const created = (version === "1.6.0" ? ApprovalCreated.extend({ snapshot: SnapshotV2 }) : ApprovalCreated).parse(json) as ApprovalCreated;
  return { session, completer, handle: created.approval_handle, created, cart };
}

const read = (cloud: FakeCloud, p: Purchase, by: Session, version: string | null = "1.6.1") => call(cloud, by, "GET", `/v1/approvals/${p.handle}`, undefined, version);
const report = (cloud: FakeCloud, p: Purchase, value: unknown, by: Session = p.completer, version = "1.6.1") =>
  call(cloud, by, "POST", `/v1/approvals/${p.handle}/outcome-reports`, value, version);
const ID = (c: string): string => `or_${c.repeat(22)}`;
/** The outcome member named like `process.binding`, which src/ lint keeps out of property reads. */
const BINDING = "binding";
const COMPLETING = { report_id: ID("A"), state: "completing", source: "shop_api", checkout_ref_hash: `sha256:${"0".repeat(64)}`, observed_at: "2026-10-15T12:01:00Z" };
const BINDING_OK = {
  rule_version: "binding-v1",
  result: "ok",
  checks: { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "match", total: "match" },
};

describe("version negotiation (1.6.1)", () => {
  it("answers 1.6.1 and 1.6.0 each with its own sums, 1.5.0 without the header, and 400 for a version it does not serve", async () => {
    const cloud = await start();
    const s = createSession();
    const v161 = await call(cloud, s, "GET", "/v1/meta");
    expect([v161.version, Meta.parse(v161.json).contract_version]).toEqual(["1.6.1", "1.6.1"]);
    expect(Meta.parse(v161.json).contract_sums_sha256).toBe("bc035ee36b0a8fe54e1b87919c8de215c508ab5369d8254fdcdecf18c23710d8");
    const v16 = await call(cloud, s, "GET", "/v1/meta", undefined, "1.6.0");
    expect([v16.version, Meta.parse(v16.json).contract_version]).toEqual(["1.6.0", "1.6.0"]);
    expect(Meta.parse(v16.json).contract_sums_sha256).toBe("b75b771e3ae299d74a53f450574af6fab8e63d6bcca2b42aa957046afbf4657d");
    const v15 = await call(cloud, s, "GET", "/v1/meta", undefined, null);
    expect([v15.version, Meta.parse(v15.json).contract_version]).toEqual(["1.5.0", "1.5.0"]);
    const bad = await call(cloud, s, "GET", "/v1/meta", undefined, "1.7.0");
    expect(bad.status).toBe(400);
    expect(ErrorBody.parse(bad.json)).toEqual({ error: "bad_request", message: "unsupported contract version" });
  });

  it("a host from before 1.6.0 ignores the header and answers 1.5.0", async () => {
    const cloud = await start({ versions: ["1.5.0"] });
    const r = await call(cloud, createSession(), "GET", "/v1/meta");
    expect([r.version, Meta.parse(r.json).contract_version]).toEqual(["1.5.0", "1.5.0"]);
  });

  it("1.6.0 carts need a completer key; 1.5.0 carts refuse the 1.6.0 fields; 1.5.0 offers carry no variant_ref", async () => {
    const cloud = await start();
    const s = createSession();
    const offers = SearchResponse.parse((await call(cloud, s, "POST", "/v1/catalog/search", { category: "running-shoes", ship_to: SHIP }, null)).json).offers;
    expect(offers[0]).not.toHaveProperty("variant_ref");
    const handle = offers[0]?.offer_handle;
    expect((await call(cloud, s, "POST", "/v1/carts", { offer_handle: handle, quantity: 1, ship_to: SHIP })).status).toBe(400);
    const with16 = { offer_handle: handle, quantity: 1, ship_to: SHIP, completer_keyid: createSession().keyid };
    expect((await call(cloud, s, "POST", "/v1/carts", with16, null)).status).toBe(400);
    expect((await call(cloud, s, "POST", "/v1/carts", { ...with16, completer_keyid: s.keyid })).status).toBe(400);
  });
});

describe("snapshot v3 and the completer key", () => {
  it("offer = cart = snapshot: variant, origin, mode, 5-digit ZIP and the completer key sent", async () => {
    const cloud = await start();
    const p = await purchase(cloud);
    expect(p.cart).toMatchObject({ completion_mode: "handoff", merchant_origin: `https://${p.cart.merchant.domain}`, total_estimated: false });
    const s = SnapshotV3.parse(p.created.snapshot);
    expect(s.myshopify_domain).toBeUndefined();
    expect(s).toMatchObject({
      ship_to: SHIP,
      merchant_origin: p.cart.merchant_origin,
      variant_ref: p.cart.variant_ref,
      completion_mode: "handoff",
      completer_keyid: p.completer.keyid,
      total_estimated: false,
    });
    expect(s.checkout_ref_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("the completer key reads the approval until 48 h after expires_at; any other key gets 404 (R7)", async () => {
    const cloud = await start();
    const p = await purchase(cloud);
    expect((await read(cloud, p, p.completer)).status).toBe(200);
    expect((await read(cloud, p, createSession())).status).toBe(404);
    // A 1.5.0 caller has no completer key.
    expect((await read(cloud, p, p.completer, null)).status).toBe(404);
    const expiresAt = Date.parse(SnapshotV3.parse(p.created.snapshot).expires_at);
    clock = expiresAt + 48 * HOUR - 1000;
    expect((await read(cloud, p, p.completer)).status).toBe(200);
    clock = expiresAt + 48 * HOUR;
    expect((await read(cloud, p, p.completer)).status).toBe(404);
    expect((await read(cloud, p, p.session)).status).toBe(200);
  });

  it("mode choice: the item's first mode the caller accepts and the environment enables, else 409", async () => {
    const on = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    expect((await purchase(on, ["shop_agent", "handoff"])).cart.completion_mode).toBe("shop_agent");
    expect((await purchase(on, ["handoff"])).cart.completion_mode).toBe("handoff");
    const off = await start({ catalog: [SHOP_AGENT_ITEM] });
    expect((await purchase(off, ["shop_agent", "handoff"])).cart.completion_mode).toBe("handoff");
    const only = await start({ oneTap: true, catalog: [{ ...SHOP_AGENT_ITEM, completion: ["shop_agent"] }] });
    const s = createSession();
    const offer = SearchResponse.parse((await call(only, s, "POST", "/v1/catalog/search", { category: "running-shoes", ship_to: SHIP })).json).offers[0];
    const refused = await call(only, s, "POST", "/v1/carts", { offer_handle: offer?.offer_handle, quantity: 1, ship_to: SHIP, completer_keyid: createSession().keyid });
    expect([refused.status, ErrorBody.parse(refused.json).message]).toEqual([409, "no completion mode in common"]);
  });
});

describe("outcome reports (Appendix G R1–R7)", () => {
  async function approvedShopAgent(): Promise<{ cloud: FakeCloud; p: Purchase }> {
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const p = await purchase(cloud, ["shop_agent", "handoff"]);
    expect(cloud.approveWithPasskey(p.handle, new SoftPasskey()).status).toBe(200);
    return { cloud, p };
  }

  it("404 for another key (R1, as for an unknown handle); the first report must be completing; completing redeems once and replays", async () => {
    const { cloud, p } = await approvedShopAgent();
    const intruder = await report(cloud, p, COMPLETING, createSession());
    expect([intruder.status, intruder.json]).toEqual([404, { error: "not_found", message: "unknown handle" }]);
    const failedFirst = { report_id: ID("B"), completing_report_id: ID("A"), state: "failed", source: "shop_api", observed_at: "2026-10-15T12:01:00Z" };
    expect((await report(cloud, p, failedFirst)).status).toBe(409);
    const first = await report(cloud, p, COMPLETING);
    expect(first.status).toBe(201);
    // R5: stored as the gateway's report, reported assurance, with what it said under `reported`.
    expect(OutcomeReportAccepted.parse(first.json).outcome).toMatchObject({
      state: "completing",
      source: "gateway_report",
      assurance: "reported",
      reported: { state: "completing", source: "shop_api" },
    });
    expect(await report(cloud, p, COMPLETING)).toEqual(first);
    expect((await report(cloud, p, { ...COMPLETING, checkout_ref_hash: `sha256:${"1".repeat(64)}` })).status).toBe(409);
    expect((await report(cloud, p, { ...COMPLETING, report_id: ID("C") })).status).toBe(409);
    // A report without checkout_ref_hash, or with the raw checkout id, does not match the schema.
    expect((await report(cloud, p, { ...COMPLETING, report_id: ID("D"), checkout_ref_hash: undefined, checkout_ref: "gid://shopify/Checkout/1" })).status).toBe(400);
    const status = ApprovalStatus.parse((await read(cloud, p, p.completer)).json);
    expect([status.state, status.outcome?.state]).toEqual(["approved", "completing"]);
  });

  it("a gateway's ordered is stored as reported, is final, and the session key may report too (R1, R4, R5)", async () => {
    const { cloud, p } = await approvedShopAgent();
    expect((await report(cloud, p, COMPLETING, p.session)).status).toBe(201);
    const ordered = {
      report_id: ID("D"),
      completing_report_id: ID("A"),
      state: "ordered",
      source: "shop_api",
      order_ref: "gid://shopify/Order/1001",
      final_total: p.cart.total,
      binding: BINDING_OK,
      observed_at: "2026-10-15T12:02:00Z",
    };
    // R4: every later report names the accepted completing one.
    expect((await report(cloud, p, { ...ordered, completing_report_id: ID("Z") })).status).toBe(409);
    const r = await report(cloud, p, ordered);
    expect(r.status).toBe(201);
    expect(OutcomeReportAccepted.parse(r.json).outcome).toMatchObject({ state: "reported", source: "gateway_report", assurance: "reported", reported: { state: "ordered" } });
    expect((await report(cloud, p, { ...ordered, report_id: ID("E"), state: "failed" })).status).toBe(409);
    expect(cloud.inspect(p.handle)?.reports.map((x) => x.state)).toEqual(["completing", "ordered"]);
  });

  it("R4 transitions: completing → indeterminate → failed, then nothing; a failed report is stored as failed with reported", async () => {
    const { cloud, p } = await approvedShopAgent();
    expect((await report(cloud, p, COMPLETING)).status).toBe(201);
    const later = (id: string, state: string, source = "shop_api") => ({ report_id: ID(id), completing_report_id: ID("A"), state, source, observed_at: "2026-10-15T12:03:00Z" });
    expect((await report(cloud, p, later("B", "indeterminate"))).status).toBe(201);
    const failed = await report(cloud, p, later("C", "failed", "gateway_precheck"));
    expect(OutcomeReportAccepted.parse(failed.json).outcome).toMatchObject({ state: "failed", assurance: "reported", reported: { state: "failed", source: "gateway_precheck" } });
    expect((await report(cloud, p, later("D", "indeterminate"))).status).toBe(409);
  });

  it("410 for completing when not approved or after expires_at (R3); 409 on a hand-off approval", async () => {
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const pending = await purchase(cloud, ["shop_agent"]);
    expect((await report(cloud, pending, COMPLETING)).status).toBe(410);
    const late = await purchase(cloud, ["shop_agent"]);
    cloud.approveWithPasskey(late.handle, new SoftPasskey());
    clock = Date.parse(SnapshotV3.parse(late.created.snapshot).expires_at);
    expect((await report(cloud, late, COMPLETING)).status).toBe(410);
    clock = T0;
    const handoff = await purchase(cloud, ["handoff"]);
    cloud.approveWithPasskey(handoff.handle, new SoftPasskey());
    expect((await report(cloud, handoff, COMPLETING)).status).toBe(409);
    // R1 before R0: another key learns nothing about the approval's mode.
    expect((await report(cloud, handoff, COMPLETING, createSession())).status).toBe(404);
  });
});

describe("vector o3: ApprovalStatus.state for every outcome", () => {
  interface O3 {
    cases: { input: { outcome_state: string; mode: CompletionMode }; expected: { "1.6.1": string; "1.6.0": string; "1.5.0": string | null } }[];
  }
  const o3 = JSON.parse(readFileSync(join(repo, "contract", "vectors", "o3-status-state.json"), "utf8")) as O3;

  it.each(o3.cases.map((c) => [`${c.input.outcome_state} (${c.input.mode})`, c] as const))("%s: statusState and the served state", async (_name, c) => {
    const { outcome_state: state, mode } = c.input;
    expect(statusState(state as never, mode)).toEqual(c.expected);
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const p = await purchase(cloud, [mode]);
    cloud.approveWithPasskey(p.handle, new SoftPasskey());
    const order = state === "ordered" || state === "mismatch" ? { order_ref: "#1001", final_total: p.cart.total, binding: BINDING_OK as never } : {};
    const source = state === "reported" ? "gateway_report" : "merchant_api";
    const reported = state === "reported" ? { reported: { state: "ordered" as const, source: "shop_api" as const } } : {};
    expect(cloud.setOutcome(p.handle, { state: state as never, source, assurance: state === "ordered" ? "verified" : "reported", ...order, ...reported }).status).toBe(200);
    const v16 = ApprovalStatus.parse((await read(cloud, p, p.session)).json);
    expect(v16.state).toBe(c.expected["1.6.1"]);
    expect(v16.outcome?.state).toBe(state);
    expect(v16.proof).toBeDefined();
    // R8: this approval was created by a 1.6.1 request, so a read without the header, or as 1.6.0, is 404 whatever
    // the row (the 1.5.0 column is for approvals created by 1.5.0 requests; statusState is checked against it above).
    expect((await read(cloud, p, p.session, null)).status).toBe(404);
    expect((await read(cloud, p, p.session, "1.6.0")).status).toBe(404);
  });
});

describe("contract 1.6.1: the myshopify pair, R8 by exact version and R5 option (a)", () => {
  it("a Shopify merchant's myshopify_domain is on the 1.6.1 offer, cart and v3 snapshot, and never served to 1.6.0", async () => {
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const p161 = await purchase(cloud, ["shop_agent", "handoff"]);
    expect(p161.cart.myshopify_domain).toBe("trail-supply.myshopify.com");
    expect(SnapshotV3.parse(p161.created.snapshot)).toMatchObject({ v: 3, myshopify_domain: "trail-supply.myshopify.com" });
    const p160 = await purchase(cloud, ["shop_agent", "handoff"], "1.6.0");
    expect(p160.cart).not.toHaveProperty("myshopify_domain");
    expect(SnapshotV2.parse(p160.created.snapshot)).not.toHaveProperty("myshopify_domain");
    const offers = SearchResponse.parse((await call(cloud, createSession(), "POST", "/v1/catalog/search", { category: "running-shoes", ship_to: SHIP }, "1.6.0")).json).offers;
    expect(offers[0]).not.toHaveProperty("myshopify_domain");
  });

  it("R8: a 1.6.0 approval is read and reported on only as 1.6.0, a 1.6.1 one only as 1.6.1", async () => {
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const p160 = await purchase(cloud, ["shop_agent"], "1.6.0");
    const p161 = await purchase(cloud, ["shop_agent"]);
    for (const p of [p160, p161]) cloud.approveWithPasskey(p.handle, new SoftPasskey());
    expect((await read(cloud, p160, p160.completer, "1.6.0")).status).toBe(200);
    expect((await read(cloud, p160, p160.completer, "1.6.1")).status).toBe(404);
    expect((await read(cloud, p161, p161.completer, "1.6.0")).status).toBe(404);
    expect((await report(cloud, p161, COMPLETING, p161.completer, "1.6.0")).status).toBe(404);
    expect((await report(cloud, p160, COMPLETING, p160.completer, "1.6.1")).status).toBe(404);
    expect((await report(cloud, p160, COMPLETING, p160.completer, "1.6.0")).status).toBe(201);
  });

  it("R5 option (a): a gateway's ordered on a v3 snapshot is re-run with every check Intent Cloud cannot observe unknown (incomplete); 1.6.0 keeps check 3 differs", async () => {
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const ordered = (p: Purchase) => ({
      report_id: ID("D"),
      completing_report_id: ID("A"),
      state: "ordered",
      source: "shop_api",
      order_ref: "gid://shopify/Order/12345678901234",
      final_total: p.cart.total,
      binding: BINDING_OK,
      observed_at: "2026-10-15T12:02:00Z",
    });
    const p161 = await purchase(cloud, ["shop_agent"]);
    cloud.approveWithPasskey(p161.handle, new SoftPasskey());
    expect((await report(cloud, p161, COMPLETING)).status).toBe(201);
    const r161 = OutcomeReportAccepted.parse((await report(cloud, p161, ordered(p161))).json).outcome;
    expect(r161[BINDING]).toEqual({
      rule_version: "binding-v1",
      result: "incomplete",
      checks: { merchant_origin: "unknown", checkout_ref: "unknown", line: "unknown", ship_to: "unknown", total: "match" },
    });
    const p160 = await purchase(cloud, ["shop_agent"], "1.6.0");
    cloud.approveWithPasskey(p160.handle, new SoftPasskey());
    expect((await report(cloud, p160, COMPLETING, p160.completer, "1.6.0")).status).toBe(201);
    const r160 = OutcomeReportAccepted.parse((await report(cloud, p160, ordered(p160), p160.completer, "1.6.0")).json).outcome;
    expect(r160[BINDING]).toMatchObject({ result: "mismatch", checks: { line: "differs" } });
  });
});
