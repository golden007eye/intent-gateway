// Appendix E step 7 for v2 snapshots (contract 1.6.0): vector e2-snapshot-v2-request.json replayed case by case, with
// the refused fields in its order; then what the vector cannot show: every field at once, a v1 snapshot, and expiry
// times that name no real instant (fail closed).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotV1, SnapshotV2 } from "../contract/index.ts";
import { instant, SENT_FIELDS, SentPurchase, sentProblems } from "./index.ts";

interface E2 {
  snapshot: unknown;
  cases: { name: string; input: unknown; expected: { valid: boolean; refused: string[] } }[];
}
const e2 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "e2-snapshot-v2-request.json"), "utf8")) as E2;
const snapshot = SnapshotV2.parse(e2.snapshot);
const base = SentPurchase.parse(e2.cases.find((c) => c.expected.valid)?.input);
const without = <T extends object>(value: T, keys: readonly string[]): T => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;

describe("vector e2: Appendix E step 7", () => {
  it("has 11 cases, one of them valid", () => {
    expect(e2.cases).toHaveLength(11);
    expect(e2.cases.filter((c) => c.expected.valid)).toHaveLength(1);
  });

  it.each(e2.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const refused = sentProblems(snapshot, SentPurchase.parse(c.input));
    expect(refused).toEqual(c.expected.refused);
    expect(refused.length === 0).toBe(c.expected.valid);
  });

  it("lists every refused field at once, in e2's order", () => {
    const all = SentPurchase.parse({
      cart_request: { ...base.cart_request, quantity: 2, ship_to: { country: "US", postal_code: "94111" }, completer_keyid: "gw-Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc", completion_accepts: ["handoff"] },
      offer: { ...base.offer, variant_ref: "gid://shopify/ProductVariant/1002" },
      cart: { ...base.cart, merchant_origin: "https://other.example", total: { amount_minor: 1, currency: "USD" }, expires_at: "2026-10-16T12:00:00Z" },
    });
    expect(sentProblems(snapshot, all)).toEqual([...SENT_FIELDS]);
  });

  it("refuses a v1 snapshot whatever was sent", () => {
    const rest = without(snapshot, ["merchant_origin", "variant_ref", "checkout_ref_hash", "completion_mode", "completer_keyid", "total_estimated"]);
    expect(sentProblems(SnapshotV1.parse({ ...rest, v: 1, ship_to: { country: "US", postal_prefix: "941" } }), base)).toEqual(["snapshot_version"]);
  });

  // Attack cases: a cart expiry that names no real instant cannot let the snapshot outlive the cart.
  it.each(["2026-02-30T12:15:00Z", "2026-10-16T24:00:00Z", "2026-13-01T00:00:00Z"])("a cart expires_at of %s fails closed", (bad) => {
    expect(sentProblems(snapshot, { ...base, cart: { ...base.cart, expires_at: bad } })).toEqual(["expires_at"]);
  });

  it("instant parses a real Timestamp and refuses every other text", () => {
    expect(instant("2026-10-16T12:15:00Z")).toBe(Date.parse("2026-10-16T12:15:00Z"));
    for (const bad of ["2026-02-29T00:00:00Z", "2026-10-16T12:15:00.000Z", "2026-10-16 12:15:00Z", "2026-10-16T12:15:00+00:00", ""]) {
      expect(instant(bad), bad).toBeNaN();
    }
  });
});
