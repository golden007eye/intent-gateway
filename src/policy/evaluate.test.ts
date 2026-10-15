import { describe, expect, it } from "vitest";
import { evaluate, loadPolicy, type Offer, type Outbound, type Purchase } from "./index.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const policy = (body: string) => loadPolicy(`version: 1\napproval: passkey\n${body}`);
const cart = (offer: Partial<Offer> = {}): Outbound => ({
  kind: "cart",
  offer: { merchant: "shop.example", category: "home", price_usd: 20, quantity: 1, ...offer },
});
const rules = (p: ReturnType<typeof policy>, o: Outbound, h: readonly Purchase[] = []) =>
  evaluate(p, o, h, NOW).blocked.map((b) => b.rule);

describe("evaluate: carts", () => {
  it("sends an offer the policy allows", () => {
    expect(evaluate(policy(""), cart(), [], NOW)).toEqual({ send: true, blocked: [] });
  });

  it("blocks a blocked merchant and its subdomains", () => {
    const p = policy("merchants: {block: [dropship.example]}\n");
    const d = evaluate(p, cart({ merchant: "Store.Dropship.example" }), [], NOW);
    expect(d.send).toBe(false);
    expect(d.blocked).toEqual([
      { path: "offer.merchant", rule: "merchants.block", reason: 'merchant "Store.Dropship.example" is blocked' },
    ]);
    expect(rules(p, cart({ merchant: "notdropship.example" }))).toEqual([]);
  });

  it("blocks a merchant outside the allow-list", () => {
    const p = policy("merchants: {allow: [shop.example]}\n");
    expect(rules(p, cart({ merchant: "other.example" }))).toEqual(["merchants.allow"]);
    expect(rules(p, cart())).toEqual([]);
  });

  it("blocks a policy category and its subcategories, and every excluded category without any policy", () => {
    expect(rules(policy("categories: {block: [electronics]}\n"), cart({ category: "Electronics/Phones" }))).toEqual([
      "categories.block",
    ]);
    expect(rules(policy(""), cart({ category: "Gift Cards" }))).toEqual(["categories.block"]);
    expect(rules(policy(""), cart({ category: "health/vitamins" }))).toEqual(["categories.block"]);
  });

  it("enforces the per-order cap on price × quantity", () => {
    const p = policy("spend: {per_order_usd: 60}\n");
    expect(rules(p, cart({ price_usd: 60 }))).toEqual([]);
    expect(rules(p, cart({ price_usd: 60.01 }))).toEqual(["spend.per_order_usd"]);
    expect(rules(p, cart({ price_usd: 25, quantity: 3 }))).toEqual(["spend.per_order_usd"]);
  });

  it("enforces the weekly cap from the purchase history", () => {
    const p = policy("spend: {per_week_usd: 150}\n");
    const history: Purchase[] = [
      { at: NOW - 2 * DAY, total_usd: 70 },
      { at: NOW - 6 * DAY, total_usd: 60.1 },
      { at: NOW - 8 * DAY, total_usd: 500 },
    ];
    expect(rules(p, cart({ price_usd: 19.9 }), history)).toEqual([]);
    expect(rules(p, cart({ price_usd: 20 }), history)).toEqual(["spend.per_week_usd"]);
    expect(rules(p, cart({ price_usd: 20 }), history.slice(0, 1))).toEqual([]);
  });

  it("enforces the daily cap over the last 24 hours", () => {
    const p = policy("spend: {per_day_usd: 40}\n");
    expect(rules(p, cart({ price_usd: 20 }), [{ at: NOW - DAY + 1, total_usd: 20.01 }])).toEqual(["spend.per_day_usd"]);
    expect(rules(p, cart({ price_usd: 20 }), [{ at: NOW - DAY, total_usd: 39 }])).toEqual([]);
  });

  it("compares money in cents", () => {
    const p = policy("spend: {per_day_usd: 1}\n");
    expect(rules(p, cart({ price_usd: 0.3 }), [{ at: NOW, total_usd: 0.1 }, { at: NOW, total_usd: 0.6 }])).toEqual([]);
  });

  it("blocks quantities above the policy and Cloud maximum, and invalid quantities", () => {
    expect(rules(policy("quantity: {max: 1}\n"), cart({ quantity: 2 }))).toEqual(["quantity.max"]);
    expect(rules(policy(""), cart({ quantity: 4 }))).toEqual(["quantity.max"]);
    expect(rules(policy(""), cart({ quantity: 0 }))).toEqual(["quantity.max"]);
    expect(rules(policy(""), cart({ quantity: 1.5 }))).toEqual(["quantity.max"]);
  });

  it("blocks a price that is not a finite amount", () => {
    expect(rules(policy("spend: {per_order_usd: 10}\n"), cart({ price_usd: Number.NaN }))).toEqual(["offer.price_usd"]);
    expect(rules(policy(""), cart({ price_usd: -1 }))).toEqual(["offer.price_usd"]);
  });

  it("uses the current time when none is given", () => {
    const p = policy("spend: {per_day_usd: 10}\n");
    expect(evaluate(p, cart({ price_usd: 5 }), [{ at: Date.now(), total_usd: 6 }]).send).toBe(false);
  });
});

describe("evaluate: searches", () => {
  const search = (fields: Omit<Extract<Outbound, { kind: "search" }>, "kind">): Outbound => ({ kind: "search", ...fields });

  it("sends a US ZIP under ship_to: postcode_only", () => {
    expect(evaluate(policy("share: {ship_to: postcode_only}\n"), search({ ship_to_zip: "94110" }), [], NOW).send).toBe(
      true,
    );
  });

  it("blocks anything but a 5-digit US ZIP under postcode_only", () => {
    const p = policy("");
    for (const zip of ["94110-1234", "SW1A 1AA", "9411", "94110 Main St"]) {
      expect(evaluate(p, search({ ship_to_zip: zip }), [], NOW).blocked).toEqual([
        { path: "ship_to_zip", rule: "share.ship_to", reason: "only a 5-digit US ZIP may be shared" },
      ]);
    }
  });

  it("blocks any ship-to under ship_to: none and sends the search without one", () => {
    const p = policy("share: {ship_to: none}\n");
    expect(rules(p, search({ ship_to_zip: "94110" }))).toEqual(["share.ship_to"]);
    expect(rules(p, search({ category: "home", must_haves: ["blue"], budget_usd: 50 }))).toEqual([]);
  });

  it("blocks a blocked category and any history", () => {
    expect(rules(policy(""), search({ category: "alcohol" }))).toEqual(["categories.block"]);
    expect(rules(policy(""), search({ history: [{ item: "lamp" }] }))).toEqual(["share.history"]);
    expect(rules(policy(""), search({ history: [] }))).toEqual([]);
  });
});
