// binding-v1 (Appendix G) replayed from vector o1 of the amended contract 1.6.0. Expected values come from Intent
// Cloud's vector, never from this implementation. The checkout ref hash covers the id up to its first "?", the context
// carries recorded_checkout_ref_hash and bound_elsewhere, and three cases pin integer-only inputs, so the vector is
// read with parseIntegerJson.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Binding, checkoutRefHash, SnapshotV2 } from "../contract/index.ts";
import { parseIntegerJson } from "../jcs/index.ts";
import { BindingError, bindingResult, bindingV1, type BindingContext, normaliseOrigin, type ObservedOrder, totalMatches } from "./index.ts";

interface O1Case {
  name: string;
  input: { snapshot: unknown; observed: ObservedOrder; context: BindingContext };
  expected: Binding;
}
const root = join(import.meta.dirname, "..", "..");
const load = (path: string): { cases: O1Case[] } => parseIntegerJson(readFileSync(join(root, path), "utf8")) as { cases: O1Case[] };
const O1 = load("contract/vectors/o1-binding.json");

describe("vector o1: every case", () => {
  it("holds the 21 contract cases, the origin grammar, the integer-only types and the one-order rule", () => {
    expect(O1.cases.length).toBe(39);
    expect(O1.cases.filter((c) => c.name.startsWith("type:")).map((c) => c.name)).toEqual(['type: quantity 1.0', 'type: quantity "1"', "type: quantity true"]);
  });
  it.each(O1.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(bindingV1(SnapshotV2.parse(c.input.snapshot), c.input.observed, c.input.context)).toEqual(c.expected);
  });
});

describe("binding-v1: rules no vector case pins yet", () => {
  const base = O1.cases[0] as O1Case;
  const s = SnapshotV2.parse(base.input.snapshot);
  const run = (observed: Partial<ObservedOrder>, context: Partial<BindingContext> = {}) =>
    bindingV1(s, { ...base.input.observed, ...observed }, { ...base.input.context, ...context });

  it("an id whose part before '?' is empty has no checkout ref hash: differs, in both modes (Update 2 item 7)", () => {
    expect(run({ checkout_ref: "?key=TESTKEY0001" }).checks.checkout_ref).toBe("differs");
    expect(run({ checkout_ref: "" }).checks.checkout_ref).toBe("differs");
    const recorded = checkoutRefHash("gid://shopify/Checkout/SHOP0001");
    expect(run({ checkout_ref: "?x" }, { mode: "shop_agent", recorded_checkout_ref_hash: recorded }).checks.checkout_ref).toBe("differs");
  });

  it("re-runs from a recorded checkout ref hash when the raw id is not kept", () => {
    const hash = checkoutRefHash(String(base.input.observed.checkout_ref));
    const observed = { ...base.input.observed, checkout_ref: undefined };
    expect(bindingV1(s, { ...observed, checkout_ref_hash: hash }, base.input.context).result).toBe("ok");
    expect(bindingV1(s, { ...observed, checkout_ref_hash: "sha256:nothex" }, base.input.context).checks.checkout_ref).toBe("differs");
  });

  it("shop_agent without a recorded checkout is unknown, so incomplete, never ok", () => {
    expect(run({}, { mode: "shop_agent" })).toMatchObject({ result: "incomplete", checks: { checkout_ref: "unknown" } });
  });

  it("values of the wrong type differ, never convert", () => {
    expect(run({ merchant_origin: 7 }).checks.merchant_origin).toBe("differs");
    expect(run({ checkout_ref: 7 }).checks.checkout_ref).toBe("differs");
    expect(run({ ship_to_postal_code: 94110 }).checks.ship_to).toBe("differs");
    expect(run({ ship_to_postal_code: "" }).checks.ship_to).toBe("differs");
    expect(run({ lines: "one" }).checks.line).toBe("differs");
    expect(run({ lines: [null] }).checks.line).toBe("differs");
    expect(run({ final_total: { amount_minor: "12500", currency: "USD" } }).checks.total).toBe("differs");
    expect(run({ final_total: { amount_minor: -1, currency: "USD" } }).checks.total).toBe("differs");
    expect(run({ final_total: null }).checks.total).toBe("differs");
  });

  it("null reads as absent", () => {
    expect(run({ merchant_origin: null, ship_to_postal_code: null })).toMatchObject({ result: "incomplete", checks: { merchant_origin: "unknown", ship_to: "unknown" } });
  });

  it("an unknown mode is an error, not a check result", () => {
    expect(() => run({}, { mode: "pickup" as never })).toThrow(BindingError);
  });

  it("origin: a host over 253 characters differs", () => {
    const long = `https://${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}`;
    expect(normaliseOrigin(long)).toBeNull();
    expect(normaliseOrigin("https://shop.example")).toBe("https://shop.example");
  });

  it("the result rule and rule 25 in integers", () => {
    const all = { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "unknown", total: "match" } as const;
    expect(bindingResult(all, false)).toBe("incomplete");
    expect(bindingResult(all, true)).toBe("ok");
    expect(bindingResult({ ...all, line: "differs" }, true)).toBe("mismatch");
    expect(totalMatches(1001, { amount_minor: 801, currency: "USD" })).toBe(true);
    expect(totalMatches(1001, { amount_minor: 800, currency: "USD" })).toBe(false);
    expect(totalMatches(1001, { amount_minor: 801.5, currency: "USD" })).toBe(false);
  });
});
