// The policy's USD caps in another currency: each cap × (the currency's ceiling / the USD ceiling), order ceilings for
// per-order and per-day, week ceilings for per-week, floored to a whole minor unit. Expected values are written out
// from Intent Cloud's table, never computed by the code under test. Attack cases: a currency the table lacks, or no
// table at all, refuses the cart (never no limit); spend in one currency never counts against another.
import { describe, expect, it } from "vitest";
import { capsIn, type Ceilings, evaluate, loadPolicy, type Outbound, type Purchase } from "./index.ts";

/** Intent Cloud's currency table (minor units). */
const TABLE: Ceilings = {
  USD: { order: 5000, week: 10_000 },
  CAD: { order: 7000, week: 14_000 },
  GBP: { order: 4000, week: 8000 },
  EUR: { order: 5000, week: 10_000 },
  AUD: { order: 7500, week: 15_000 },
};
const NOW = Date.parse("2026-10-15T12:00:00Z");
const DEFAULTS = loadPolicy("version: 1\napproval: passkey\nspend:\n  per_order_usd: 20\n  per_day_usd: 20\n  per_week_usd: 40\n");
const cart = (price: number, currency?: string): Outbound => ({
  kind: "cart",
  offer: { merchant: "shop.example", category: "home", price_usd: price, quantity: 1, ...(currency === undefined ? {} : { currency }) },
});

describe("the default caps ($20 an order, $40 a week) in each currency", () => {
  it.each([
    ["USD", 2000, 4000],
    ["CAD", 2800, 5600],
    ["GBP", 1600, 3200],
    ["EUR", 2000, 4000],
    ["AUD", 3000, 6000],
  ])("%s: %i per order and per day, %i per week", (currency, order, week) => {
    expect(capsIn(DEFAULTS.spend, currency, TABLE)).toEqual({ per_order_usd: order, per_day_usd: order, per_week_usd: week });
  });

  it("floors to a whole minor unit", () => {
    const odd: Ceilings = { USD: { order: 3000, week: 3000 }, CAD: { order: 1000, week: 2000 } };
    // 2000 × 1000 / 3000 = 666.67 → 666; 4000 × 2000 / 3000 = 2666.67 → 2666.
    expect(capsIn(DEFAULTS.spend, "CAD", odd)).toEqual({ per_order_usd: 666, per_day_usd: 666, per_week_usd: 2666 });
  });

  it("USD needs no table", () => {
    expect(capsIn(DEFAULTS.spend, "USD", null)).toEqual({ per_order_usd: 2000, per_day_usd: 2000, per_week_usd: 4000 });
  });

  it("attack (invariant 1): a table whose ratio to USD is implausible cannot widen a cap: the currency has none", () => {
    // USD.order 1 and CAD.order 1e12 would make $20 a cap of CAD 20 trillion.
    const wide: Ceilings = { USD: { order: 1, week: 10_000 }, CAD: { order: 1e12, week: 14_000 } };
    expect(capsIn(DEFAULTS.spend, "CAD", wide)).toBeNull();
    const d = evaluate(DEFAULTS, cart(1_000_000, "CAD"), [], NOW, wide);
    expect(d.send).toBe(false);
    expect(d.blocked.map((b) => b.rule)).toEqual(["spend.currency"]);
    // Each ratio alone, order or week, at the bounds 0.25 and 4 and just past them.
    const at = (order: number, week: number): Ceilings => ({ USD: { order: 1000, week: 1000 }, CAD: { order, week } });
    expect(capsIn(DEFAULTS.spend, "CAD", at(4000, 250))).not.toBeNull();
    expect(capsIn(DEFAULTS.spend, "CAD", at(4001, 1000))).toBeNull();
    expect(capsIn(DEFAULTS.spend, "CAD", at(1000, 249))).toBeNull();
    expect(capsIn(DEFAULTS.spend, "CAD", at(1000, 4001))).toBeNull();
    expect(capsIn(DEFAULTS.spend, "CAD", at(249, 1000))).toBeNull();
  });

  it("attack: another currency with no table, a table without it, or a zero USD ceiling has no caps", () => {
    expect(capsIn(DEFAULTS.spend, "CAD", null)).toBeNull();
    expect(capsIn(DEFAULTS.spend, "NZD", TABLE)).toBeNull();
    expect(capsIn(DEFAULTS.spend, "CAD", { CAD: { order: 7000, week: 14_000 } })).toBeNull();
    expect(capsIn(DEFAULTS.spend, "CAD", { ...TABLE, USD: { order: 0, week: 0 } })).toBeNull();
  });
});

describe("evaluate in another currency", () => {
  it("compares a cart with the caps in its own currency, and names them so", () => {
    expect(evaluate(DEFAULTS, cart(28, "CAD"), [], NOW, TABLE).send).toBe(true);
    const over = evaluate(DEFAULTS, cart(28.01, "CAD"), [], NOW, TABLE);
    expect(over.blocked.map((b) => b.reason)).toEqual(["over the CAD 28 per order limit", "over the CAD 28 per day limit"]);
  });

  it("attack: caps that cannot be put in the currency refuse the cart, never let it through", () => {
    for (const ceilings of [null, { USD: TABLE.USD } as Ceilings]) {
      const d = evaluate(DEFAULTS, cart(1, "CAD"), [], NOW, ceilings);
      expect(d.send).toBe(false);
      expect(d.blocked.map((b) => b.rule)).toEqual(["spend.currency"]);
    }
    // A policy with no caps has nothing to put in another currency.
    expect(evaluate(loadPolicy("version: 1\napproval: passkey\n"), cart(1, "CAD"), [], NOW, null).send).toBe(true);
  });

  it("counts only same-currency spend in the windows, as Intent Cloud counts its week; an entry with no currency is USD", () => {
    const weekly = loadPolicy("version: 1\napproval: passkey\nspend:\n  per_week_usd: 40\n");
    const usd: Purchase[] = [{ at: NOW - 1000, total_usd: 39 }];
    // $39 spent in USD leaves the CAD week (CAD 56) untouched.
    expect(evaluate(weekly, cart(56, "CAD"), usd, NOW, TABLE).send).toBe(true);
    expect(evaluate(weekly, cart(2, "USD"), usd, NOW, TABLE).blocked.map((b) => b.rule)).toEqual(["spend.per_week_usd"]);
    const cad: Purchase[] = [{ at: NOW - 1000, total_usd: 50, currency: "CAD" }];
    expect(evaluate(weekly, cart(6.01, "CAD"), cad, NOW, TABLE).blocked.map((b) => b.reason)).toEqual(["over the CAD 56 per week limit"]);
    expect(evaluate(weekly, cart(40), cad, NOW, TABLE).send).toBe(true);
  });

  it("attack: a purchase whose currency is not a code is bad history, which refuses the cart", () => {
    const d = evaluate(DEFAULTS, cart(1, "CAD"), [{ at: NOW - 1000, total_usd: 1, currency: "" }], NOW, TABLE);
    expect(d.blocked.map((b) => b.rule)).toEqual(["history_invalid"]);
  });
});

describe("evaluate: a search's coarse postcode in another country", () => {
  const search = (zip: string, country?: string): Outbound => ({ kind: "search", category: "home", ship_to_zip: zip, ...(country === undefined ? {} : { ship_to_country: country }) });
  it("shares a coarse postcode of the country, never a full one", () => {
    expect(evaluate(DEFAULTS, search("K1A", "CA"), [], NOW).send).toBe(true);
    expect(evaluate(DEFAULTS, search("K1A 0B1", "CA"), [], NOW).blocked).toEqual([
      { path: "ship_to_zip", rule: "share.ship_to", reason: "only the coarse part of a CA postcode may be shared" },
    ]);
    expect(evaluate(DEFAULTS, search("94107-1234"), [], NOW).blocked.map((b) => b.reason)).toEqual(["only a 5-digit US ZIP may be shared"]);
  });
});
