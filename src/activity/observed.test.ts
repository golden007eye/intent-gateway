// Observations in the activity model: an `observed` entry joins the action of the request it names and adds what
// Intent Cloud returned (offer count, title, merchant, total, approval state); a rejected or expired status becomes
// the outcome. An observation of a request without a receipt, a malformed one or a second one is left out, and a
// chain without observations reads as before (backward compatible).
import { describe, expect, it } from "vitest";
import { buildActivity } from "./index.ts";

type Spec = [kind: string, body: Record<string, unknown>];
const chain = (specs: readonly Spec[]): unknown[] =>
  specs.map(([kind, body], seq) => ({ seq, prev: "", ts: `2026-10-16T10:00:${String(seq).padStart(2, "0")}.000Z`, kind, body, hash: "" }));
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const disclosure = (endpoint: string, path: string, body: unknown = null) => ({ endpoint, method: "POST", path, fields: [], body_b64: body === null ? "" : b64(body), content_digest: "sha-256=:x:", keyid: "gw-k" });
const receipt = (seq: number, status = 200) => ({ disclosure_seq: seq, status, verified: true });
const OFFER = { offer_handle: "of_aaaaaaaaaaaaaaaaaaaa", title: "Budget Running Shoe", merchant: "Resale Hub", price_minor: 3999, shipping_minor: 199, currency: "USD" };
const SEARCH = { category: "running shoes", budget_max: { amount_minor: 12000, currency: "USD" }, ship_to: { country: "US", postal_code: "94103" } };
const searched = (seq: number, count = 3) => ({ disclosure_seq: seq, endpoint: "searchCatalog", offers_count: count, offers_hidden: 1, offers: [OFFER] });
const cartSeen = (seq: number) => ({ disclosure_seq: seq, endpoint: "createCart", title: "Budget Running Shoe", merchant: "Resale Hub", quantity: 1, total_minor: 4198, currency: "USD" });
const statusSeen = (seq: number, state: string) => ({ disclosure_seq: seq, endpoint: "getApproval", approval_handle: "ap_1", state, title: "Budget Running Shoe", merchant: "Resale Hub", total_minor: 4198, currency: "USD" });

describe("observations in the activity model", () => {
  it("a search's observation adds the offer count, the hidden count and the offers, and joins its seqs", () => {
    const [search] = buildActivity(chain([["disclosure", disclosure("searchCatalog", "/v1/catalog/search", SEARCH)], ["receipt", receipt(0)], ["observed", searched(0)]])).activities;
    expect(search).toMatchObject({ action: "search", seqs: [0, 1, 2], outcome: "acknowledged", facts: { category: "running shoes", offers_count: 3, offers_hidden: 1, offers: [OFFER] } });
    expect(search?.requests[0]?.observed).toEqual({ seq: 2, ...searched(0) });
  });

  it("a cart's observation adds title, merchant and total; a later rejected status is the status's outcome and the cart's state", () => {
    const { activities } = buildActivity(
      chain([
        ["disclosure", disclosure("createCart", "/v1/carts", { offer_handle: "of_x", quantity: 1 })],
        ["receipt", receipt(0, 201)],
        ["observed", cartSeen(0)],
        ["disclosure", disclosure("createApproval", "/v1/carts/ct_1/approvals")],
        ["receipt", receipt(3, 201)],
        ["approval_pending", { handle: "ap_1", approval_url: "http://127.0.0.1:8788/confirm/c/x", total_minor: 4198 }],
        ["disclosure", { ...disclosure("getApproval", "/v1/approvals/ap_1"), method: "GET" }],
        ["receipt", receipt(6)],
        ["observed", statusSeen(6, "rejected")],
      ]),
    );
    expect(activities.map((a) => [a.action, a.outcome])).toEqual([
      ["cart", "approval_asked"],
      ["status", "rejected"],
    ]);
    expect(activities[0]?.facts).toMatchObject({ title: "Budget Running Shoe", merchant: "Resale Hub", total_minor: 4198, approval_handle: "ap_1", approval_state: "rejected" });
    expect(activities[1]?.facts).toMatchObject({ approval_handle: "ap_1", approval_state: "rejected", title: "Budget Running Shoe" });
  });

  it("an expired status is the outcome too; a pending or approved one keeps the delivery outcome", () => {
    const status = (state: string) =>
      buildActivity(chain([["disclosure", disclosure("getApproval", "/v1/approvals/ap_1")], ["receipt", receipt(0)], ["observed", statusSeen(0, state)]])).activities[0];
    expect(status("expired")?.outcome).toBe("expired");
    expect(status("pending")).toMatchObject({ outcome: "acknowledged", facts: { approval_state: "pending" } });
    expect(status("approved")).toMatchObject({ outcome: "acknowledged", facts: { approval_state: "approved" } });
  });

  it("invariant 5: an observation of a request with no receipt, a malformed one, another endpoint's or a second one is left out", () => {
    const { activities } = buildActivity(
      chain([
        ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", SEARCH)],
        ["observed", searched(0)],
        ["unacknowledged", { disclosure_seq: 0, reason: "CloudNetworkError: timeout" }],
        ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", SEARCH)],
        ["receipt", receipt(3)],
        ["observed", { ...searched(3), buyer: "x" }],
        ["observed", cartSeen(3)],
        ["observed", searched(3, 5)],
        ["observed", searched(3, 9)],
      ]),
    );
    const [first, second] = activities;
    expect(first).toMatchObject({ outcome: "unacknowledged", seqs: [0, 2] });
    expect(first?.facts.offers_count).toBeUndefined();
    expect(first?.requests[0]?.observed).toBeNull();
    expect(second).toMatchObject({ seqs: [3, 4, 7], facts: { offers_count: 5 } });
  });

  it("a block's held value is a fact; a chain without observations or held values reads as before", () => {
    const { activities } = buildActivity(
      chain([
        ["block", { endpoint: "searchCatalog", fields: ["category"], blocked: ["categories.block at category"], held: { category: "alcohol" } }],
        ["block", { endpoint: "searchCatalog", fields: ["category"], blocked: ["categories.block at category"] }],
        ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", SEARCH)],
        ["receipt", receipt(2)],
      ]),
    );
    expect(activities[0]?.facts.held).toEqual({ category: "alcohol" });
    expect(activities[1]?.facts).not.toHaveProperty("held");
    expect(activities[2]?.facts).toEqual({ category: "running shoes", budget_minor: 12000, currency: "USD", zip: "94103", country: "US" });
    expect(activities[2]?.requests[0]?.observed).toBeNull();
  });
});
