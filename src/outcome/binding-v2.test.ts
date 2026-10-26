// binding-v2 (contract 1.7.1, Appendix G) replayed from vector o6. Expected values come from Intent Cloud's vector,
// never from this implementation; the vector is read with parseIntegerJson like every wire input.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Binding, coarsePostcode, SnapshotV4 } from "../contract/index.ts";
import { parseIntegerJson } from "../jcs/index.ts";
import { BindingError, bindingV2, type BindingContext, type ObservedOrderV2 } from "./index.ts";

const O6 = parseIntegerJson(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "o6-binding-v2.json"), "utf8")) as {
  snapshot: unknown;
  cases: { name: string; input: { observed: ObservedOrderV2; context: BindingContext; snapshot?: unknown }; expected: Binding }[];
};
const snapshot = SnapshotV4.parse(O6.snapshot);

describe("vector o6: binding-v2, every case", () => {
  it("holds the 32 contract cases: 13 to the US, 19 to other countries (1.7.1)", () => {
    expect(O6.cases.length).toBe(32);
    expect(O6.cases.filter((c) => c.input.snapshot !== undefined)).toHaveLength(19);
  });

  // A case's own snapshot (1.7.1: another country) when it has one, else the vector's US snapshot.
  it.each(O6.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const s = c.input.snapshot === undefined ? snapshot : SnapshotV4.parse(c.input.snapshot);
    expect(bindingV2(s, c.input.observed, c.input.context)).toEqual(c.expected);
  });

  // What the gateway's chain records in place of the full postcode (its coarse form, taken in memory) must give the
  // same verdict as the full postcode, so `intent verify` can re-run it; the full code is never recorded.
  it.each(O6.cases.filter((c) => typeof c.input.observed.ship_to_postal_code === "string").map((c) => [c.name, c] as const))(
    "recorded coarse code gives the same verdict: %s",
    (_name, c) => {
      const s = c.input.snapshot === undefined ? snapshot : SnapshotV4.parse(c.input.snapshot);
      const { ship_to_postal_code: full, ...rest } = c.input.observed;
      const recorded = { ...rest, ship_to_postal_code_coarse: coarsePostcode(s.ship_to.country, full as string) ?? "" };
      expect(bindingV2(s, recorded, c.input.context)).toEqual(c.expected);
    },
  );

  it("attack (security review): an observed postcode without its country is unknown, never match", () => {
    const gb = SnapshotV4.parse(O6.cases.find((c) => c.name.startsWith("GB SW1A"))?.input.snapshot);
    const base = { mode: "shop_agent", ship_to_optional: false } as const;
    expect(bindingV2(gb, { ship_to_postal_code: "SW1A 1AA" }, base).checks.ship_to).toBe("unknown");
    expect(bindingV2(gb, { ship_to_postal_code_coarse: "SW1A" }, base).checks.ship_to).toBe("unknown");
    expect(bindingV2(gb, { ship_to_country: "IE", ship_to_postal_code: "SW1A 1AA" }, base).checks.ship_to).toBe("differs");
  });

  it("attack: a recorded coarse code is compared as it is, never coarsened again, and an empty one differs", () => {
    const gb = SnapshotV4.parse(O6.cases.find((c) => c.name.startsWith("GB SW1A"))?.input.snapshot);
    const base = { mode: "shop_agent", ship_to_optional: false } as const;
    expect(bindingV2(gb, { ship_to_country: "GB", ship_to_postal_code_coarse: "SW1A" }, base).checks.ship_to).toBe("match");
    expect(bindingV2(gb, { ship_to_country: "GB", ship_to_postal_code_coarse: "" }, base).checks.ship_to).toBe("differs");
    expect(bindingV2(gb, { ship_to_country: "GB", ship_to_postal_code_coarse: "SW1" }, base).checks.ship_to).toBe("differs");
    // The full postcode wins when both are given: an already coarse "SW1A" as the full code has no coarse form.
    expect(bindingV2(gb, { ship_to_country: "GB", ship_to_postal_code: "SW1A", ship_to_postal_code_coarse: "SW1A" }, base).checks.ship_to).toBe("differs");
  });

  it("attack: a mode outside the contract is an error, not a result", () => {
    expect(() => bindingV2(snapshot, {}, { mode: "gift_card", ship_to_optional: false })).toThrow(BindingError);
  });

  it("attack: the checkout ref hash the chain records stands for the raw id, and another one differs", () => {
    const base = { mode: "shop_agent", ship_to_optional: false } as const;
    expect(bindingV2(snapshot, { checkout_ref_hash: snapshot.checkout_ref_hash }, base).checks.checkout_ref).toBe("match");
    expect(bindingV2(snapshot, { checkout_ref_hash: `sha256:${"0".repeat(64)}` }, base).checks.checkout_ref).toBe("differs");
  });
});

describe("binding-v2 check 4 outside the US: the observed postcode coarsened by the snapshot country's rule", () => {
  const base = { mode: "shop_agent", ship_to_optional: false } as const;
  it.each([
    ["CA", "K1A", "K1A 0B1", "K1B 0B1"],
    ["AU", "2000", "2000", "2001"],
  ])("%s: the same area matches, another area or country differs", (country, coarse, same, other) => {
    const s = SnapshotV4.parse({ ...(O6.snapshot as object), ship_to: { country, postal_code_coarse: coarse }, currency: country === "CA" ? "CAD" : "AUD" });
    expect(bindingV2(s, { ship_to_country: country, ship_to_postal_code: same }, base).checks.ship_to).toBe("match");
    expect(bindingV2(s, { ship_to_country: country, ship_to_postal_code: other }, base).checks.ship_to).toBe("differs");
    expect(bindingV2(s, { ship_to_country: "US", ship_to_postal_code: same }, base).checks.ship_to).toBe("differs");
    // The total in the snapshot's currency only: the same integer in USD differs.
    expect(bindingV2(s, { final_total: { amount_minor: s.totals.total, currency: s.currency } }, base).checks.total).toBe("match");
    expect(bindingV2(s, { final_total: { amount_minor: s.totals.total, currency: "USD" } }, base).checks.total).toBe("differs");
  });
});
