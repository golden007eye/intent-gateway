// Appendix E step 7 for v2 snapshots (contract 1.6.0 hardening amendment H2). The eight cases are vector
// e2-snapshot-v2-request.json as the platform built it (provisional amendment hash bf8b65a4…b178): transcribed here
// until the amended tree is vendored, when this test reads the vector file instead. Its snapshot is a3's shop_agent one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CartRequest, Snapshot, SnapshotV2 } from "../contract/index.ts";
import { SENT_FIELDS, sentProblems } from "./index.ts";

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
const cart = (over: Partial<{ merchant_origin: string; variant_ref: string }> = {}) => ({ merchant_origin: "https://shop.example", variant_ref: V1001, ...over });
const without = <T extends object>(value: T, keys: readonly string[]): T => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;
const withoutAccepts = without(request(), ["completion_accepts"]);

const E2: [name: string, sent: Parameters<typeof sentProblems>[1], refused: string[]][] = [
  ["the gateway's own request", { cart_request: request(), offer: { variant_ref: V1001 }, cart: cart() }, []],
  ["quantity 2 requested, 1 approved", { cart_request: request({ quantity: 2 }), offer: { variant_ref: V1001 }, cart: cart() }, ["quantity"]],
  ["another ZIP requested", { cart_request: request({ ship_to: { country: "US", postal_code: "94111" } }), offer: { variant_ref: V1001 }, cart: cart() }, ["ship_to"]],
  ["another completer key", { cart_request: request({ completer_keyid: OTHER_KEY }), offer: { variant_ref: V1001 }, cart: cart() }, ["completer_keyid"]],
  ["shop_agent approved, only handoff accepted", { cart_request: request({ completion_accepts: ["handoff"] }), offer: { variant_ref: V1001 }, cart: cart() }, ["completion_mode"]],
  ["shop_agent approved, completion_accepts absent (= [handoff])", { cart_request: withoutAccepts, offer: { variant_ref: V1001 }, cart: cart() }, ["completion_mode"]],
  ["another variant offered", { cart_request: request(), offer: { variant_ref: "gid://shopify/ProductVariant/1002" }, cart: cart() }, ["variant_ref"]],
  ["another merchant origin on the cart", { cart_request: request(), offer: { variant_ref: V1001 }, cart: cart({ merchant_origin: "https://other.example" }) }, ["merchant_origin"]],
];

describe("Appendix E step 7 (vector e2, 8 cases)", () => {
  it.each(E2)("%s", (_name, sent, refused) => {
    expect(sentProblems(snapshot, sent)).toEqual(refused);
  });

  it("lists every refused field, in e2's order", () => {
    const all = {
      cart_request: request({ quantity: 2, ship_to: { country: "US", postal_code: "94111" }, completer_keyid: OTHER_KEY, completion_accepts: ["handoff"] }),
      offer: { variant_ref: "gid://shopify/ProductVariant/1002" },
      cart: cart({ merchant_origin: "https://other.example" }),
    };
    expect(sentProblems(snapshot, all)).toEqual([...SENT_FIELDS]);
  });

  it("refuses a v1 snapshot whatever was sent", () => {
    const rest = without(snapshot, ["merchant_origin", "variant_ref", "checkout_ref_hash", "completion_mode", "completer_keyid", "total_estimated"]);
    const v1 = { ...rest, v: 1 as const, ship_to: { country: "US" as const, postal_prefix: "941" } };
    expect(sentProblems(Snapshot.parse(v1), { cart_request: request(), offer: { variant_ref: V1001 }, cart: cart() })).toEqual(["snapshot_version"]);
  });
});
