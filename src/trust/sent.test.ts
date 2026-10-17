// Appendix E step 7 for v2 snapshots (contract 1.6.0 hardening amendment H2). The eleven cases are vector
// e2-snapshot-v2-request.json as the platform built it (provisional amendment hash 2459425d…c8c): transcribed here
// until the amended tree is vendored, when this test reads the vector file instead. Its snapshot is a3's shop_agent one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CartRequest, Snapshot, SnapshotV2 } from "../contract/index.ts";
import { SENT_FIELDS, type SentPurchase, sentProblems } from "./index.ts";

const a3 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "a3-snapshot-v2.json"), "utf8")) as {
  cases: { name: string; input: { snapshot: unknown } }[];
};
const snapshot = SnapshotV2.parse(a3.cases.find((c) => c.name === "shop_agent snapshot")?.input.snapshot);

// e2's two completer keyids are a3's (public keys of published test seeds), read from the vector, not written out.
const KEY = snapshot.completer_keyid;
const OTHER_KEY = SnapshotV2.parse(a3.cases.find((c) => c.name === "handoff snapshot")?.input.snapshot).completer_keyid;
const V1001 = "gid://shopify/ProductVariant/1001";
const request = (over: Partial<CartRequest> = {}): CartRequest => ({
  offer_handle: "of_TEST0001",
  quantity: 1,
  ship_to: { country: "US", postal_code: "94110" },
  completer_keyid: KEY,
  completion_accepts: ["shop_agent", "handoff"],
  ...over,
});
const offer = (over: Partial<SentPurchase["offer"]> = {}): SentPurchase["offer"] => ({
  variant_ref: V1001,
  merchant: { name: "Test Shop", domain: "shop.example" },
  ...over,
});
const cart = (over: Partial<SentPurchase["cart"]> = {}): SentPurchase["cart"] => ({
  merchant_origin: "https://shop.example",
  variant_ref: V1001,
  total: { amount_minor: 13600, currency: "USD" },
  expires_at: "2026-10-16T12:15:00Z",
  ...over,
});
const without = <T extends object>(value: T, keys: readonly string[]): T => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;
const sent = (over: Partial<SentPurchase> = {}): SentPurchase => ({ cart_request: request(), offer: offer(), cart: cart(), ...over });

const E2: [name: string, sent: SentPurchase, refused: string[]][] = [
  ["the gateway's own request", sent(), []],
  ["quantity 2 requested, 1 approved", sent({ cart_request: request({ quantity: 2 }) }), ["quantity"]],
  ["another ZIP requested", sent({ cart_request: request({ ship_to: { country: "US", postal_code: "94111" } }) }), ["ship_to"]],
  ["another completer key", sent({ cart_request: request({ completer_keyid: OTHER_KEY }) }), ["completer_keyid"]],
  ["shop_agent approved, only handoff accepted", sent({ cart_request: request({ completion_accepts: ["handoff"] }) }), ["completion_mode"]],
  ["shop_agent approved, completion_accepts absent (= [handoff])", sent({ cart_request: without(request(), ["completion_accepts"]) }), ["completion_mode"]],
  ["another variant offered", sent({ offer: offer({ variant_ref: "gid://shopify/ProductVariant/1002" }) }), ["variant_ref"]],
  ["the offer the agent picked is another merchant", sent({ offer: offer({ merchant: { name: "Other", domain: "other.example" } }) }), ["merchant_origin"]],
  ["another total on the cart", sent({ cart: cart({ total: { amount_minor: 13500, currency: "USD" } }) }), ["total"]],
  ["the snapshot outlives the cart", sent({ cart: cart({ expires_at: "2026-10-16T12:10:00Z" }) }), ["expires_at"]],
  ["another merchant origin on the cart", sent({ cart: cart({ merchant_origin: "https://other.example" }) }), ["merchant_origin"]],
];

describe("Appendix E step 7 (vector e2, 11 cases)", () => {
  it("has e2's 11 cases", () => {
    expect(E2).toHaveLength(11);
  });

  it.each(E2)("%s", (_name, input, refused) => {
    expect(sentProblems(snapshot, input)).toEqual(refused);
  });

  it("lists every refused field, in e2's order", () => {
    const all = sent({
      cart_request: request({ quantity: 2, ship_to: { country: "US", postal_code: "94111" }, completer_keyid: OTHER_KEY, completion_accepts: ["handoff"] }),
      offer: offer({ variant_ref: "gid://shopify/ProductVariant/1002" }),
      cart: cart({ merchant_origin: "https://other.example", total: { amount_minor: 1, currency: "USD" }, expires_at: "2026-10-16T12:00:00Z" }),
    });
    expect(sentProblems(snapshot, all)).toEqual([...SENT_FIELDS]);
  });

  it("a snapshot that expires with the cart, or before it, passes", () => {
    expect(sentProblems(snapshot, sent({ cart: cart({ expires_at: "2026-10-16T13:00:00Z" }) }))).toEqual([]);
  });

  it("refuses a v1 snapshot whatever was sent", () => {
    const rest = without(snapshot, ["merchant_origin", "variant_ref", "checkout_ref_hash", "completion_mode", "completer_keyid", "total_estimated"]);
    const v1 = { ...rest, v: 1 as const, ship_to: { country: "US" as const, postal_prefix: "941" } };
    expect(sentProblems(Snapshot.parse(v1), sent())).toEqual(["snapshot_version"]);
  });
});
