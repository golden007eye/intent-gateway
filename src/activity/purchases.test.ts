// Purchases from the activity model: a cart joined to the search before it, the status checks and the approval for
// its handle; the state says only what the chain holds (an approval counts only once it is verified and chained).
import { describe, expect, it } from "vitest";
import { buildActivity, buildPurchases } from "./index.ts";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
type Spec = [kind: string, body: Record<string, unknown>];
const chain = (specs: readonly Spec[]) =>
  specs.map(([kind, body], seq) => ({ seq, prev: "", ts: `2026-10-16T10:00:${String(seq).padStart(2, "0")}.000Z`, kind, body, hash: "" }));
const disclosure = (endpoint: string, path: string, body: unknown) => ({ endpoint, method: "POST", path, fields: [], body_b64: body === null ? "" : b64(body) });
const receipt = (seq: number) => ["receipt", { disclosure_seq: seq, status: 200, verified: true }] as Spec;

const SEARCH: Spec = ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", { category: "socks" })];
const cart = (from: number, handle: string, expires = "2026-10-16T10:15:00Z"): Spec[] => [
  ["disclosure", disclosure("createCart", "/v1/carts", { offer_handle: `of_${handle}`, quantity: 1 })],
  receipt(from),
  ["disclosure", disclosure("createApproval", "/v1/carts/ct/approvals", null)],
  receipt(from + 2),
  ["approval_pending", { handle, approval_url: "http://127.0.0.1:8788/confirm/c/x", total_minor: 1800, expires_at: expires }],
];
const NOW = Date.parse("2026-10-16T10:05:00Z");

describe("buildPurchases", () => {
  it("joins search, cart, status checks and the approval by handle; approved only once the approval is chained", () => {
    const items = chain([
      SEARCH,
      receipt(0),
      ...cart(2, "ap_1"),
      ["disclosure", disclosure("getApproval", "/v1/approvals/ap_1", null)],
      receipt(7),
      ["approval", { handle: "ap_1" }],
      ...cart(10, "ap_2"),
      ["disclosure", disclosure("getApproval", "/v1/approvals/ap_2", null)],
      receipt(15),
    ]);
    const [first, second] = buildPurchases(buildActivity(items).activities, NOW);
    expect(first).toMatchObject({ seq: 2, state: "approved" });
    expect(first?.search?.seq).toBe(0);
    expect(first?.checks.map((c) => c.seq)).toEqual([7]);
    expect(first?.approval?.facts.approval_handle).toBe("ap_1");
    // A status check that came back is not an approval: no approval entry, so it is still waiting.
    expect(second).toMatchObject({ seq: 10, state: "waiting", approval: null });
    expect(second?.checks.map((c) => c.seq)).toEqual([15]);
  });

  it("an approval past its expiry with none chained is expired", () => {
    const items = chain([...cart(0, "ap_1", "2026-10-16T10:01:00Z")]);
    expect(buildPurchases(buildActivity(items).activities, NOW)[0]?.state).toBe("expired");
  });

  it("a cart whose answer the gateway refused is refused, even with an approval asked for", () => {
    const items = chain([...cart(0, "ap_1"), ["block", { endpoint: "createApproval", fields: ["snapshot"], blocked: ["snapshot: total differs"] }]]);
    const [p] = buildPurchases(buildActivity(items).activities, NOW);
    expect(p?.state).toBe("refused");
  });

  it("a cart with no answer recorded is maybe sent, never acknowledged; one that never left is not sent", () => {
    const unanswered = chain([["disclosure", disclosure("createCart", "/v1/carts", { offer_handle: "of_1" })]]);
    expect(buildPurchases(buildActivity(unanswered).activities, NOW)[0]?.state).toBe("maybe_sent");
    const neverLeft = chain([
      ["disclosure", disclosure("createCart", "/v1/carts", { offer_handle: "of_1" })],
      ["unacknowledged", { disclosure_seq: 0, reason: "CloudNetworkError: not sent (connection refused)" }],
    ]);
    expect(buildPurchases(buildActivity(neverLeft).activities, NOW)[0]?.state).toBe("not_sent");
  });

  it("a chain with no cart has no purchases", () => {
    expect(buildPurchases(buildActivity(chain([SEARCH, receipt(0)])).activities, NOW)).toEqual([]);
  });
});
