// The fake Intent Cloud's contract 1.6.0 (version negotiation, snapshot v2, the completer key, mode choice, outcome
// reports R1–R7 and the state table of Appendix G, vector o3), over real HTTP with requests signed here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCreated, ApprovalStatus, Cart, type CompletionMode, ErrorBody, Meta, OutcomeReportAccepted, SearchResponse, SnapshotV2 } from "../contract/index.ts";
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
  version: string | null = "1.6.0",
): Promise<{ status: number; version: string | null; json: unknown }> {
  const body = Buffer.from(value === undefined ? "" : JSON.stringify(value), "utf8");
  const headers: Record<string, string> = { accept: "application/json", ...signRequest(session, { method, path, body, created: Math.floor(clock / 1000) }) };
  if (method === "POST") headers["content-type"] = "application/json";
  if (version !== null) headers["intent-contract-version"] = version;
  const res = await fetch(cloud.url + path, { method, headers, ...(method === "POST" ? { body: new Uint8Array(body) } : {}) });
  const text = await res.text();
  return { status: res.status, version: res.headers.get("intent-contract-version"), json: JSON.parse(text) as unknown };
}

const SHOP_AGENT_ITEM: CatalogItem = { ...(DEFAULT_CATALOG[0] as CatalogItem), completion: ["shop_agent", "handoff"] };

interface Purchase {
  session: Session;
  completer: Session;
  handle: string;
  created: ApprovalCreated;
  cart: Cart;
}

/** Search, cart and approval over 1.6.0 with a fresh session and completer key. */
async function purchase(cloud: FakeCloud, accepts: CompletionMode[] = ["handoff"]): Promise<Purchase> {
  const session = createSession();
  const completer = createSession();
  const search = await call(cloud, session, "POST", "/v1/catalog/search", { category: "running-shoes", ship_to: SHIP });
  const offer = SearchResponse.parse(search.json).offers[0];
  if (offer === undefined) throw new Error("no offer");
  expect(offer.variant_ref).toMatch(/^gid:\/\/shopify\/ProductVariant\/\d+$/);
  const cartReply = await call(cloud, session, "POST", "/v1/carts", {
    offer_handle: offer.offer_handle,
    quantity: 1,
    ship_to: SHIP,
    completer_keyid: completer.keyid,
    completion_accepts: accepts,
  });
  expect(cartReply.status).toBe(201);
  const cart = Cart.parse(cartReply.json);
  const approval = await call(cloud, session, "POST", `/v1/carts/${cart.cart_handle}/approvals`);
  expect(approval.status).toBe(201);
  const created = ApprovalCreated.parse(approval.json);
  return { session, completer, handle: created.approval_handle, created, cart };
}

const read = (cloud: FakeCloud, p: Purchase, by: Session, version: string | null = "1.6.0") => call(cloud, by, "GET", `/v1/approvals/${p.handle}`, undefined, version);
const report = (cloud: FakeCloud, p: Purchase, value: unknown, by: Session = p.completer) => call(cloud, by, "POST", `/v1/approvals/${p.handle}/outcome-reports`, value);
const COMPLETING = { report_id: "or_AAAAAAAAAAAAAAAA", state: "completing", source: "shop_api", checkout_ref: "gid://shopify/Checkout/1", observed_at: "2026-10-15T12:01:00Z" };
const BINDING_OK = {
  rule_version: "binding-v1",
  result: "ok",
  checks: { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "match", total: "match" },
};

describe("version negotiation (1.6.0 §V1)", () => {
  it("answers 1.6.0 with the header, 1.5.0 without, and 400 for a version it does not serve", async () => {
    const cloud = await start();
    const s = createSession();
    const v16 = await call(cloud, s, "GET", "/v1/meta");
    expect([v16.version, Meta.parse(v16.json).contract_version]).toEqual(["1.6.0", "1.6.0"]);
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

describe("snapshot v2 and the completer key", () => {
  it("offer = cart = snapshot: variant, origin, mode, 5-digit ZIP and the completer key sent", async () => {
    const cloud = await start();
    const p = await purchase(cloud);
    expect(p.cart).toMatchObject({ completion_mode: "handoff", merchant_origin: `https://${p.cart.merchant.domain}`, total_estimated: false });
    const s = SnapshotV2.parse(p.created.snapshot);
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
    const expiresAt = Date.parse(SnapshotV2.parse(p.created.snapshot).expires_at);
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
    expect((await report(cloud, p, { ...COMPLETING, state: "failed", report_id: "or_BBBBBBBBBBBBBBBB" })).status).toBe(409);
    const first = await report(cloud, p, COMPLETING);
    expect(first.status).toBe(201);
    expect(OutcomeReportAccepted.parse(first.json).outcome).toMatchObject({ state: "completing", assurance: "reported" });
    expect(await report(cloud, p, COMPLETING)).toEqual(first);
    expect((await report(cloud, p, { ...COMPLETING, checkout_ref: "other" })).status).toBe(409);
    expect((await report(cloud, p, { ...COMPLETING, report_id: "or_CCCCCCCCCCCCCCCC" })).status).toBe(409);
    const status = ApprovalStatus.parse((await read(cloud, p, p.completer)).json);
    expect([status.state, status.outcome?.state]).toEqual(["approved", "completing"]);
  });

  it("a gateway's ordered is stored as reported, is final, and the session key may report too (R1, R4, R5)", async () => {
    const { cloud, p } = await approvedShopAgent();
    expect((await report(cloud, p, COMPLETING, p.session)).status).toBe(201);
    const ordered = { report_id: "or_DDDDDDDDDDDDDDDD", state: "ordered", source: "shop_api", order_ref: "#1001", final_total: p.cart.total, binding: BINDING_OK, observed_at: "2026-10-15T12:02:00Z" };
    const r = await report(cloud, p, ordered);
    expect(r.status).toBe(201);
    expect(OutcomeReportAccepted.parse(r.json).outcome).toMatchObject({ state: "reported", source: "gateway_report", assurance: "reported", reported: { state: "ordered" } });
    expect((await report(cloud, p, { ...ordered, report_id: "or_EEEEEEEEEEEEEEEE", state: "failed" })).status).toBe(409);
    expect(cloud.inspect(p.handle)?.reports.map((x) => x.state)).toEqual(["completing", "ordered"]);
  });

  it("410 for completing when not approved or after expires_at (R3); 409 on a hand-off approval", async () => {
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const pending = await purchase(cloud, ["shop_agent"]);
    expect((await report(cloud, pending, COMPLETING)).status).toBe(410);
    const late = await purchase(cloud, ["shop_agent"]);
    cloud.approveWithPasskey(late.handle, new SoftPasskey());
    clock = Date.parse(SnapshotV2.parse(late.created.snapshot).expires_at);
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
    cases: { input: { outcome_state: string; mode: CompletionMode }; expected: { "1.6.0": string; "1.5.0": string | null } }[];
  }
  const o3 = JSON.parse(readFileSync(join(repo, "contract", "vectors", "o3-status-state.json"), "utf8")) as O3;

  it.each(o3.cases.map((c) => [`${c.input.outcome_state} (${c.input.mode})`, c] as const))("%s: statusState and the served state", async (_name, c) => {
    const { outcome_state: state, mode } = c.input;
    expect(statusState(state as never, mode)).toEqual(c.expected);
    const cloud = await start({ oneTap: true, catalog: [SHOP_AGENT_ITEM] });
    const p = await purchase(cloud, [mode]);
    cloud.approveWithPasskey(p.handle, new SoftPasskey());
    expect(cloud.setOutcome(p.handle, { state: state as never, source: "merchant_api", assurance: state === "ordered" ? "verified" : "reported", ...(state === "ordered" ? { binding: BINDING_OK as never } : {}) }).status).toBe(200);
    const v16 = ApprovalStatus.parse((await read(cloud, p, p.session)).json);
    expect(v16.state).toBe(c.expected["1.6.0"]);
    expect(v16.outcome?.state).toBe(state);
    expect(v16.proof).toBeDefined();
    const v15 = await read(cloud, p, p.session, null);
    if (c.expected["1.5.0"] === null) expect(v15.status).toBe(404);
    else expect(ApprovalStatus.parse(v15.json)).toMatchObject({ state: c.expected["1.5.0"] });
  });
});
