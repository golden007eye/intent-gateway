// The chain read as actions: correlation of requests, follow-ups, carts, approvals and blocks; outcomes in verify's
// categories (invariant 5: never "acknowledged" without a receipt entry); summary counts; filters.
import { describe, expect, it } from "vitest";
import { NOT_SENT_REASON } from "../store/index.ts";
import { type Activity, buildActivity, filterActivity } from "./index.ts";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const receiptHeader = Buffer.from(JSON.stringify({ kid: "cloud-receipt-202610", status: 200 })).toString("base64url");

type Spec = [kind: string, body: Record<string, unknown>, ts?: string];

function chain(specs: readonly Spec[]): unknown[] {
  return specs.map(([kind, body, ts], seq) => ({ seq, prev: "", ts: ts ?? `2026-10-16T10:00:${String(seq).padStart(2, "0")}.000Z`, kind, body, hash: "" }));
}

const SEARCH = { category: "running shoes", must_haves: ["road"], budget_max: { amount_minor: 12000, currency: "USD" }, ship_to: { country: "US", postal_code: "94103" } };
const SEARCH_FIELDS = ["budget_max", "budget_max.amount_minor", "budget_max.currency", "category", "must_haves", "ship_to", "ship_to.country", "ship_to.postal_code"];
const CART = { offer_handle: "of_abc", quantity: 1, ship_to: { country: "US", postal_code: "94103" } };
const PIN = "aaaa 1111";

function disclosure(endpoint: string, method: string, path: string, body: unknown, fields: string[] = []): Record<string, unknown> {
  return { endpoint, method, path, fields, body_b64: body === null ? "" : b64(body), content_digest: "sha-256=:x:", keyid: "gw-k" };
}

/** A demo chain with one of every action, in the order a real flow writes them. */
const FLOW: Spec[] = [
  ["session", { mode: "demo" }],
  ["session", { id: "s1" }],
  ["disclosure", disclosure("getMeta", "GET", "/v1/meta", null)],
  ["receipt", { disclosure_seq: 2, status: 200, verified: false, receipt_header: receiptHeader }],
  ["disclosure", disclosure("getKeyStatement", "GET", "/v1/key-statement", null)],
  ["receipt", { disclosure_seq: 4, status: 200, verified: false }],
  ["keys", { statement: { kid: "cloud-root-1", expires_at: "2027-01-14T00:00:00Z" } }],
  ["disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH, SEARCH_FIELDS)],
  ["receipt", { disclosure_seq: 7, status: 200, verified: true, receipt_header: receiptHeader }],
  ["block", { endpoint: "searchCatalog", fields: ["category", "ship_to", "ship_to.postal_code"], blocked: ["categories.block at category"] }],
  ["disclosure", disclosure("createCart", "POST", "/v1/carts", CART, ["offer_handle", "quantity", "ship_to", "ship_to.country", "ship_to.postal_code"])],
  ["receipt", { disclosure_seq: 10, status: 201, verified: true }],
  ["disclosure", disclosure("createApproval", "POST", "/v1/carts/ct_1/approvals", null)],
  ["receipt", { disclosure_seq: 12, status: 201, verified: true }],
  ["approval_pending", { handle: "ap_1", approval_url: "http://127.0.0.1:8788/confirm/c/x", total_minor: 4198, expires_at: "2026-10-16T10:15:00Z" }],
  ["disclosure", disclosure("getApproval", "GET", "/v1/approvals/ap_1", null)],
  ["receipt", { disclosure_seq: 15, status: 200, verified: true }],
  ["approver_pin", { fingerprint: PIN, handle: "ap_1" }],
  ["approval", { handle: "ap_1" }],
];

const actions = (list: readonly Activity[]) => list.map((a) => [a.action, a.outcome, a.seqs]);

describe("buildActivity", () => {
  it("groups a whole flow into start, search, blocked, cart, status and approval, each with its outcome", () => {
    const { activities, summary } = buildActivity(chain(FLOW));
    expect(actions(activities)).toEqual([
      ["start", "acknowledged", [1, 2, 3, 4, 5, 6]],
      ["search", "acknowledged", [7, 8]],
      ["blocked", "blocked", [9]],
      ["cart", "approval_asked", [10, 11, 12, 13, 14]],
      ["status", "acknowledged", [15, 16]],
      ["approval", "approved", [17, 18]],
    ]);
    expect(summary).toMatchObject({
      entries: 19,
      demo: true,
      actions: { start: 1, search: 1, blocked: 1, cart: 1, status: 1, approval: 1, keys: 0, pin: 0, flagged: 0, unreadable: 0 },
      requests: { logged: 6, sent: 6, acknowledged: 6, unacknowledged: 0, not_sent: 0, maybe_sent: 0, discarded: 0 },
      refused: 0,
    });
  });

  it("reads the values each request sent from its logged bytes, and the facts of each action", () => {
    const [start, search, blocked, cart, status, approval] = buildActivity(chain(FLOW)).activities;
    expect(start?.facts).toEqual({ session_id: "s1", key_kid: "cloud-root-1", keys_expire_at: "2027-01-14T00:00:00Z" });
    expect(search?.requests[0]?.fields).toEqual({
      category: "running shoes",
      must_haves: ["road"],
      "budget_max.amount_minor": 12000,
      "budget_max.currency": "USD",
      "ship_to.country": "US",
      "ship_to.postal_code": "94103",
    });
    expect(search?.facts).toEqual({ category: "running shoes", must_haves: ["road"], budget_minor: 12000, currency: "USD", zip: "94103", country: "US" });
    expect(search?.requests[0]?.response).toEqual({
      seq: 8,
      kind: "receipt",
      status: 200,
      acknowledged: true,
      signature_checked: true,
      receipt_kid: "cloud-receipt-202610",
      reason: null,
    });
    // A blocked request's values are not in the chain: only its field names and what held it back.
    expect(blocked).toMatchObject({ blocked: ["categories.block at category"], facts: { endpoint: "searchCatalog", field_names: ["category", "ship_to.postal_code"] }, requests: [] });
    expect(cart?.facts).toEqual({
      offer_handle: "of_abc",
      quantity: 1,
      zip: "94103",
      country: "US",
      approval_handle: "ap_1",
      approval_url: "http://127.0.0.1:8788/confirm/c/x",
      total_minor: 4198,
      expires_at: "2026-10-16T10:15:00Z",
    });
    expect(cart?.requests.map((r) => [r.endpoint, r.fields])).toEqual([
      ["createCart", { offer_handle: "of_abc", quantity: 1, "ship_to.country": "US", "ship_to.postal_code": "94103" }],
      ["createApproval", {}],
    ]);
    expect(status?.facts).toEqual({ approval_handle: "ap_1" });
    expect(approval?.facts).toEqual({ approval_handle: "ap_1", total_minor: 4198, fingerprint: PIN, pinned: true });
  });

  it("a receipt logged before the key statement is acknowledged with its signature not yet checked", () => {
    const start = buildActivity(chain(FLOW)).activities[0];
    expect(start?.requests[0]?.response).toMatchObject({ acknowledged: true, signature_checked: false, receipt_kid: "cloud-receipt-202610" });
    expect(start?.requests[1]?.response).toMatchObject({ acknowledged: true, signature_checked: false, receipt_kid: null });
  });

  it("names each request's delivery in verify's categories: unacknowledged, not sent, maybe sent, discarded", () => {
    const { activities, summary } = buildActivity(
      chain([
        ["disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH)],
        ["unacknowledged", { disclosure_seq: 0, reason: "502 without Intent-Contract-Version" }],
        ["disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH)],
        ["unacknowledged", { disclosure_seq: 2, reason: `${NOT_SENT_REASON} (DNS: not found)` }],
        ["disclosure", disclosure("createCart", "POST", "/v1/carts", CART)],
        ["discarded", { disclosure_seq: 4, reason: "201 without a receipt" }],
        ["disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH)],
      ]),
    );
    expect(actions(activities)).toEqual([
      ["search", "unacknowledged", [0, 1]],
      ["search", "not_sent", [2, 3]],
      ["cart", "discarded", [4, 5]],
      ["search", "maybe_sent", [6]],
    ]);
    expect(activities[0]?.requests[0]?.response).toMatchObject({ kind: "unacknowledged", status: 502, acknowledged: false, signature_checked: false });
    expect(activities[3]?.requests[0]?.response).toBeNull();
    expect(summary.requests).toEqual({ logged: 4, sent: 2, acknowledged: 0, unacknowledged: 1, not_sent: 1, maybe_sent: 1, discarded: 1 });
  });

  it("attack: an approval link asked over a request without a receipt keeps that request's outcome", () => {
    const [cart] = buildActivity(
      chain([
        ["disclosure", disclosure("createCart", "POST", "/v1/carts", CART)],
        ["unacknowledged", { disclosure_seq: 0, reason: "CloudNetworkError: timeout" }],
        ["approval_pending", { handle: "ap_3", total_minor: 100 }],
      ]),
    ).activities;
    expect(cart).toMatchObject({ action: "cart", outcome: "unacknowledged", facts: { approval_handle: "ap_3" } });
  });

  it("summary: the fields that may have left, and buyer identity found in their values", () => {
    const { summary } = buildActivity(
      chain([
        ["disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", { ...SEARCH, product: "call +1 415 555 2671" }, [...SEARCH_FIELDS, "product"])],
        ["receipt", { disclosure_seq: 0, status: 200, verified: true }],
        ["disclosure", disclosure("createCart", "POST", "/v1/carts", CART, ["offer_handle"])],
        ["unacknowledged", { disclosure_seq: 2, reason: `${NOT_SENT_REASON} (refused)` }],
        ["disclosure", { endpoint: "getApproval", fields: [] }],
        ["receipt", { disclosure_seq: 4, status: 200, verified: true }],
      ]),
    );
    // The cart never left: its offer_handle is not among the fields sent.
    expect(summary.sent_fields).toEqual(["budget_max.amount_minor", "budget_max.currency", "category", "must_haves", "product", "ship_to.country", "ship_to.postal_code"]);
    expect(summary.identity).toEqual({ checked: 1, unchecked: 1, findings: [{ seq: 0, kinds: ["phone"] }] });
  });

  it("attack: a receipt that names no earlier disclosure acknowledges nothing", () => {
    const { activities, summary } = buildActivity(
      chain([
        ["disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH)],
        ["receipt", { disclosure_seq: 7, status: 200, verified: true }],
      ]),
    );
    expect(actions(activities)).toEqual([["search", "maybe_sent", [0]]]);
    expect(summary.requests.acknowledged).toBe(0);
  });

  it("attack: a second follow-up never upgrades a request: the first one recorded is its answer", () => {
    const [search] = buildActivity(
      chain([
        ["disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH)],
        ["unacknowledged", { disclosure_seq: 0, reason: "CloudNetworkError: timeout" }],
        ["receipt", { disclosure_seq: 0, status: 200, verified: true }],
      ]),
    ).activities;
    expect(search?.outcome).toBe("unacknowledged");
  });

  it("attack: a demo session entry that is not the first entry does not make a real chain a demo one", () => {
    expect(buildActivity(chain([["keys", { statement: {} }], ["session", { mode: "demo" }]])).summary.demo).toBe(false);
  });

  it("puts a refused cart, snapshot or proof on the action it refused; a policy block before a send stands alone", () => {
    const { activities, summary } = buildActivity(
      chain([
        ["disclosure", disclosure("createCart", "POST", "/v1/carts", CART)],
        ["receipt", { disclosure_seq: 0, status: 201, verified: true }],
        ["disclosure", disclosure("createApproval", "POST", "/v1/carts/ct_1/approvals", null)],
        ["receipt", { disclosure_seq: 2, status: 201, verified: true }],
        ["block", { endpoint: "createApproval", fields: ["snapshot"], blocked: ["snapshot: total differs from the cart"] }],
        ["disclosure", disclosure("getApproval", "GET", "/v1/approvals/ap_2", null)],
        ["receipt", { disclosure_seq: 5, status: 200, verified: true }],
        ["block", { endpoint: "getApproval", fields: ["proof"], blocked: ["approval_proof: bad signature (Appendix E step 4)"] }],
        ["block", { endpoint: "createCart", fields: ["offer_handle"], blocked: ["offer.price_usd at offer.price"] }],
        ["block", { endpoint: "createCart", fields: ["cart"], blocked: ["cart: merchant differs from the offer"] }],
      ]),
    );
    expect(actions(activities)).toEqual([
      ["cart", "refused", [0, 1, 2, 3, 4, 9]],
      ["status", "refused", [5, 6, 7]],
      ["blocked", "blocked", [8]],
    ]);
    expect(activities[0]?.blocked).toEqual(["snapshot: total differs from the cart", "cart: merchant differs from the offer"]);
    expect(summary.refused).toBe(2);
  });

  it("lists a pin written by approver accept, a flag, a later key refresh and an unreadable line as their own actions", () => {
    const items = chain([
      ["approver_pin", { fingerprint: "bbbb 2222" }],
      ["approver_flag", { fingerprint: "cccc 3333", reason: "sign_count" }],
      ["disclosure", disclosure("getKeyStatement", "GET", "/v1/key-statement", null)],
      ["receipt", { disclosure_seq: 2, status: 200, verified: false }],
      ["keys", { statement: { kid: "cloud-root-1", expires_at: "2027-04-01T00:00:00Z" } }],
      ["keys", { statement: { kid: "cloud-root-1", expires_at: "2027-05-01T00:00:00Z" } }],
    ]);
    items.push("torn");
    const { activities } = buildActivity(items);
    expect(actions(activities)).toEqual([
      ["pin", "pinned", [0]],
      ["flagged", "flagged", [1]],
      ["keys", "acknowledged", [2, 3, 4]],
      ["keys", "recorded", [5]],
      ["unreadable", "unreadable", []],
    ]);
    expect(activities[1]?.facts).toEqual({ fingerprint: "cccc 3333", flag_reason: "sign_count" });
    expect(activities[4]?.facts).toEqual({ line: 7 });
  });

  it("an approval without a new pin carries the pin it was approved under", () => {
    const [approval] = buildActivity(chain([["approver_pin", { fingerprint: PIN }], ["approval", { handle: "ap_9" }]])).activities.slice(1);
    expect(approval?.facts).toEqual({ approval_handle: "ap_9", fingerprint: PIN });
  });

  it("an entry without body bytes (an older chain) has field names and no values", () => {
    const [search] = buildActivity(chain([["disclosure", { endpoint: "searchCatalog", fields: ["category"] }]])).activities;
    expect(search?.requests[0]).toMatchObject({ fields: null, field_names: ["category"], method: null, keyid: null });
    expect(search?.facts).toEqual({});
  });
});

describe("filterActivity", () => {
  const { activities } = buildActivity(chain(FLOW));

  it("keeps the kinds asked for, from a time on, then the last N", () => {
    expect(filterActivity(activities, { actions: new Set(["search", "blocked"]) }).map((a) => a.action)).toEqual(["search", "blocked"]);
    expect(filterActivity(activities, { since: new Date("2026-10-16T10:00:10.000Z") }).map((a) => a.action)).toEqual(["cart", "status", "approval"]);
    expect(filterActivity(activities, { last: 2 }).map((a) => a.action)).toEqual(["status", "approval"]);
    expect(filterActivity(activities, { actions: new Set(["search", "cart", "status"]), last: 2 }).map((a) => a.action)).toEqual(["cart", "status"]);
  });

  it("never hides an unreadable line", () => {
    const items = chain(FLOW);
    items.push("torn");
    const kept = filterActivity(buildActivity(items).activities, { actions: new Set(["search"]), since: new Date("2030-01-01T00:00:00Z") });
    expect(kept.map((a) => a.action)).toEqual(["unreadable"]);
  });
});
