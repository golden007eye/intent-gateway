// The fake Intent Cloud's contract 1.7.0: POST /v1/checkouts (v4 snapshots, the refusals and their order, the pause,
// replay and supersession), the currency table on Meta, the ceilings at approve and at the completing report, and
// binding-v2 on reports, over real HTTP with requests signed here. 1.6.1 stays frozen beside it.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AccountKey,
  ApprovalCreated,
  ApprovalStatus,
  type CheckoutRequest,
  checkoutRefHash,
  checkoutRequestProblems,
  ErrorBody,
  Meta,
  OutcomeReportAccepted,
  SnapshotV4,
} from "../contract/index.ts";
import { createSession, type Session, signRequest } from "../signing/index.ts";
import { type FakeCloud, type FakeCloudOptions, SoftPasskey, startFakeCloud } from "./index.ts";

/** Read by a constant key: src/ lint forbids naming a property `binding` (it would also match `process.binding`). */
const BINDING = "binding";
const T0 = Date.parse("2026-10-18T12:00:00Z");
let clock = T0;
const open: FakeCloud[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function start(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  clock = T0;
  const cloud = await startFakeCloud({ now: () => clock, oneTap: true, ...options });
  open.push(cloud);
  return cloud;
}

async function call(cloud: FakeCloud, session: Session, method: "GET" | "POST", path: string, value?: unknown, version: string | null = "1.7.0") {
  const body = Buffer.from(value === undefined ? "" : JSON.stringify(value), "utf8");
  const headers: Record<string, string> = { accept: "application/json", ...signRequest(session, { method, path, body, created: Math.floor(clock / 1000) }) };
  if (method === "POST") headers["content-type"] = "application/json";
  if (version !== null) headers["intent-contract-version"] = version;
  const res = await fetch(cloud.url + path, { method, headers, ...(method === "POST" ? { body: new Uint8Array(body) } : {}) });
  return { status: res.status, json: JSON.parse(await res.text()) as unknown };
}

function accountKey(): AccountKey {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", x: jwk.x as string };
}
const ACCOUNT = accountKey();

/** A submitted checkout; `patch` changes the checkout, `top` the request around it. */
function request(completer: Session, patch: Partial<CheckoutRequest["checkout"]> = {}, top: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    checkout: {
      checkout_ref_hash: checkoutRefHash("gid://shopify/Checkout/FAKE0001?key=K") as string,
      myshopify_domain: "test-shop.myshopify.com",
      store_site: "https://shop.example",
      store_name: "Test Shop",
      variant_ref: "gid://shopify/ProductVariant/1001",
      title: "Trail Runner 3",
      quantity: 1,
      currency: "USD",
      totals: { subtotal: 1200, shipping: 500, tax: 100, total: 1800 },
      ship_to: { country: "US", postal_code: "94110" },
      ...patch,
    },
    completion_mode: "shop_agent",
    completer_keyid: completer.keyid,
    account_key: ACCOUNT,
    ...top,
  };
}

const submit = (cloud: FakeCloud, session: Session, body: unknown, version: string | null = "1.7.0") => call(cloud, session, "POST", "/v1/checkouts", body, version);

describe("POST /v1/checkouts (1.7.0)", () => {
  it("answers a pending approval whose v4 snapshot is the request (Appendix E step 7), naming the table and the account key", async () => {
    const cloud = await start();
    const s = createSession();
    const body = request(createSession());
    const reply = await submit(cloud, s, body);
    expect(reply.status).toBe(201);
    const created = ApprovalCreated.parse(reply.json);
    const snapshot = SnapshotV4.parse(created.snapshot);
    expect(checkoutRequestProblems(snapshot, body)).toEqual([]);
    const meta = Meta.parse((await call(cloud, s, "GET", "/v1/meta")).json);
    expect(snapshot.currency_table).toBe(meta.currency_table?.version);
    expect(cloud.checkouts.received).toEqual([body]);
    expect(created.check_code).toBe(created.snapshot_hash.slice(0, 8));
  });

  it("is 1.7.0 only: a 1.6.1 or header-less request gets 404", async () => {
    const cloud = await start();
    expect((await submit(cloud, createSession(), request(createSession()), "1.6.1")).status).toBe(404);
    expect((await submit(cloud, createSession(), request(createSession()), null)).status).toBe(404);
  });

  const bad: [string, Partial<CheckoutRequest["checkout"]>, Partial<CheckoutRequest>][] = [
    ["a US postcode that is not the 5-digit coarse form", { ship_to: { country: "US", postal_code: "9411" } }, {}],
    ["totals that do not add up", { totals: { subtotal: 1200, shipping: 500, tax: 100, total: 1700 } }, {}],
    ["a continue_url for shop_agent", { continue_url: "https://shop.app/checkouts/x" }, {}],
    ["a continue_url on another host", { continue_url: "https://evil.example/cart" }, { completion_mode: "handoff" }],
    ["handoff without a continue_url", {}, { completion_mode: "handoff" }],
  ];
  it.each(bad)("refuses %s with 400", async (_name, patch, top) => {
    const cloud = await start();
    const reply = await submit(cloud, createSession(), request(createSession(), patch, top));
    expect(reply.status).toBe(400);
    expect(ErrorBody.parse(reply.json).error).toBe("bad_request");
  });

  it("accepts a hand-off to the store's own myshopify domain and signs its hash", async () => {
    const cloud = await start();
    const url = "https://test-shop.myshopify.com/cart/c/FAKE0001";
    const reply = await submit(cloud, createSession(), request(createSession(), { continue_url: url }, { completion_mode: "handoff" }));
    expect(reply.status).toBe(201);
    expect(SnapshotV4.parse(ApprovalCreated.parse(reply.json).snapshot).continue_url_hash).toMatch(/^sha256:/);
  });

  it("refuses a completer key that is the session key, or an earlier approval's", async () => {
    const cloud = await start();
    const s = createSession();
    expect((await submit(cloud, s, request(s))).status).toBe(400);
    const completer = createSession();
    expect((await submit(cloud, s, request(completer))).status).toBe(201);
    expect((await submit(cloud, s, request(completer, { title: "Another" }))).status).toBe(400);
  });

  it("refuses in Appendix A's order: paused (409), then one_tap_off, currency_unsupported, store_blocked, category_excluded, ceiling_order (403)", async () => {
    const cloud = await start({ currencies: { USD: { order: 1000, week: 5000 } } });
    // Every refusal holds at once: each is lifted in turn, so the next one shows.
    cloud.checkouts.setPaused(true);
    cloud.checkouts.setOneTap(false);
    cloud.checkouts.blockStores(["test-shop.myshopify.com"]);
    const codes: (string | undefined)[] = [];
    const attempt = async (currency: string): Promise<void> => {
      const reply = await submit(cloud, createSession(), request(createSession(), { currency, title: "Vape pen" }));
      codes.push(`${String(reply.status)} ${String(ErrorBody.parse(reply.json).code)}`);
    };
    await attempt("CAD");
    cloud.checkouts.setPaused(false);
    await attempt("CAD");
    cloud.checkouts.setOneTap(true);
    await attempt("CAD");
    await attempt("USD");
    cloud.checkouts.blockStores([]);
    await attempt("USD");
    const last = await submit(cloud, createSession(), request(createSession()));
    codes.push(`${String(last.status)} ${String(ErrorBody.parse(last.json).code)}`);
    expect(codes).toEqual(["409 paused", "403 one_tap_off", "403 currency_unsupported", "403 store_blocked", "403 category_excluded", "403 ceiling_order"]);
  });

  it("a ceiling of 0 refuses every checkout in that currency", async () => {
    const cloud = await start({ currencies: { USD: { order: 0, week: 0 } } });
    const reply = await submit(cloud, createSession(), request(createSession()));
    expect([reply.status, ErrorBody.parse(reply.json).code]).toEqual([403, "ceiling_order"]);
  });

  it("replay: the same session and body within 10 minutes gets the same pending approval", async () => {
    const cloud = await start();
    const s = createSession();
    const body = request(createSession());
    const first = ApprovalCreated.parse((await submit(cloud, s, body)).json);
    clock += 9 * 60_000;
    const again = ApprovalCreated.parse((await submit(cloud, s, body)).json);
    expect(again).toEqual(first);
  });

  it("supersession: a new request for the same checkout and mode expires the session's pending one", async () => {
    const cloud = await start();
    const s = createSession();
    const first = ApprovalCreated.parse((await submit(cloud, s, request(createSession()))).json);
    const second = ApprovalCreated.parse((await submit(cloud, s, request(createSession()))).json);
    expect(second.approval_handle).not.toBe(first.approval_handle);
    expect(cloud.inspect(first.approval_handle)?.state).toBe("expired");
    expect(cloud.inspect(second.approval_handle)?.state).toBe("pending");
  });
});

describe("a v4 approval after the passkey (1.7.0)", () => {
  async function approved(cloud: FakeCloud, passkey = new SoftPasskey(), patch: Partial<CheckoutRequest["checkout"]> = {}) {
    const session = createSession();
    const completer = createSession();
    const created = ApprovalCreated.parse((await submit(cloud, session, request(completer, patch))).json);
    const outcome = cloud.approveWithPasskey(created.approval_handle, passkey);
    return { session, completer, created, outcome, passkey };
  }

  it("serves the proof with the v4 snapshot in 1.7.0 only (R8), and pins the account key", async () => {
    const cloud = await start();
    const p = await approved(cloud);
    expect(p.outcome.status).toBe(200);
    const status = ApprovalStatus.parse((await call(cloud, p.completer, "GET", `/v1/approvals/${p.created.approval_handle}`)).json);
    expect(status.state).toBe("approved");
    expect(status.proof?.snapshot).toEqual(p.created.snapshot);
    expect(status.display).toMatchObject({ merchant: "Test Shop", title: "Trail Runner 3", total: { amount_minor: 1800, currency: "USD" } });
    expect((await call(cloud, p.completer, "GET", `/v1/approvals/${p.created.approval_handle}`, undefined, "1.6.1")).status).toBe(404);
    expect(cloud.checkouts.pinned()).toEqual([SnapshotV4.parse(p.created.snapshot).account_key_thumbprint]);
  });

  it("the confirm page refuses an approval over the week ceiling, or while paused; the decline still works", async () => {
    const cloud = await start({ currencies: { USD: { order: 2000, week: 3000 } } });
    const passkey = new SoftPasskey();
    expect((await approved(cloud, passkey)).outcome.status).toBe(200);
    const second = await approved(cloud, passkey, { checkout_ref_hash: checkoutRefHash("gid://shopify/Checkout/FAKE0002") as string });
    expect(second.outcome).toMatchObject({ status: 409, reason: "ceiling_week", state: "pending" });
    cloud.checkouts.setPaused(true);
    expect(cloud.approveWithPasskey(second.created.approval_handle, passkey)).toMatchObject({ status: 409, reason: "paused" });
    expect(cloud.reject(second.created.approval_handle, passkey).status).toBe(200);
  });

  const completing = (checkoutRef: string) => ({ report_id: "or_AAAAAAAAAAAAAAAAAAAAAA", state: "completing", source: "shop_api", checkout_ref_hash: checkoutRef, observed_at: "2026-10-18T12:00:00Z" });
  const report = (cloud: FakeCloud, p: { completer: Session; created: ApprovalCreated }, body: unknown) =>
    call(cloud, p.completer, "POST", `/v1/approvals/${p.created.approval_handle}/outcome-reports`, body);

  it("the completing report re-checks the order ceiling and the pause: 409 with the code, and the approval stays approved", async () => {
    const cloud = await start();
    const p = await approved(cloud);
    const ref = SnapshotV4.parse(p.created.snapshot).checkout_ref_hash;
    cloud.checkouts.setCurrencies({ USD: { order: 1000, week: 100_000 } });
    const over = await report(cloud, p, completing(ref));
    expect([over.status, ErrorBody.parse(over.json).code]).toEqual([409, "ceiling_order"]);
    cloud.checkouts.setCurrencies({ USD: { order: 50_000, week: 100_000 } });
    cloud.checkouts.setPaused(true);
    const paused = await report(cloud, p, completing(ref));
    expect([paused.status, ErrorBody.parse(paused.json).code]).toEqual([409, "paused"]);
    expect(cloud.inspect(p.created.approval_handle)?.state).toBe("approved");
    cloud.checkouts.setPaused(false);
    expect((await report(cloud, p, completing(ref))).status).toBe(201);
  });

  it("the week ceiling at completing counts the buyer's other approved orders", async () => {
    const cloud = await start({ currencies: { USD: { order: 2000, week: 4000 } } });
    const passkey = new SoftPasskey();
    const p = await approved(cloud, passkey);
    await approved(cloud, passkey, { checkout_ref_hash: checkoutRefHash("gid://shopify/Checkout/FAKE0002") as string });
    cloud.checkouts.setCurrencies({ USD: { order: 2000, week: 3000 } });
    const reply = await report(cloud, p, completing(SnapshotV4.parse(p.created.snapshot).checkout_ref_hash));
    expect([reply.status, ErrorBody.parse(reply.json).code]).toEqual([409, "ceiling_week"]);
  });

  it("an ordered report is re-run with binding-v2 (only the total compares); a binding-v1 report is refused", async () => {
    const cloud = await start();
    const p = await approved(cloud);
    expect((await report(cloud, p, completing(SnapshotV4.parse(p.created.snapshot).checkout_ref_hash))).status).toBe(201);
    const checks = { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "match", total: "match" };
    const ordered = (rule: string, id: string) => ({
      report_id: id,
      completing_report_id: "or_AAAAAAAAAAAAAAAAAAAAAA",
      state: "ordered",
      source: "shop_api",
      order_ref: "gid://shopify/Order/1",
      final_total: { amount_minor: 1800, currency: "USD" },
      binding: { rule_version: rule, result: "ok", checks },
      observed_at: "2026-10-18T12:01:00Z",
    });
    expect((await report(cloud, p, ordered("binding-v1", "or_BBBBBBBBBBBBBBBBBBBBBB"))).status).toBe(400);
    const accepted = OutcomeReportAccepted.parse((await report(cloud, p, ordered("binding-v2", "or_CCCCCCCCCCCCCCCCCCCCCC"))).json);
    expect(accepted.outcome[BINDING]).toEqual({
      rule_version: "binding-v2",
      result: "incomplete",
      checks: { merchant_origin: "unknown", checkout_ref: "unknown", line: "unknown", ship_to: "unknown", total: "match" },
    });
  });
});
