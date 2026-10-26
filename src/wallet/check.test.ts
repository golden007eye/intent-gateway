// The out-of-band check (plan G12): which reported orders no chained outcome names, the counts and total chained,
// and the exact shape `intent verify` holds a `checked` entry to.
import { describe, expect, it } from "vitest";
import { chainedOrderRefs, checkedEntry, checkOrders, walletEntryProblem, type WalletOrder } from "./index.ts";

const SINCE = new Date("2026-10-10T00:00:00.000Z");
const order = (n: number, createdAt: string | null, amountMinor: number | null = 1000, currency = "USD"): WalletOrder => ({
  orderRef: `gid://shopify/Order/${String(n)}`,
  total: amountMinor === null ? null : { amountMinor, currency },
  merchantOrigin: "https://stickers.example",
  createdAt,
});

describe("chainedOrderRefs", () => {
  it("collects order_ref from outcome entries only, at any shallow depth", () => {
    const refs = chainedOrderRefs([
      { kind: "outcome", body: { handle: "ap_1", order_ref: "gid://shopify/Order/1" } },
      { kind: "outcome", body: { handle: "ap_2", cloud: { state: "ordered", order_ref: "gid://shopify/Order/2" } } },
      { kind: "outcome", body: { handle: "ap_3", wallet: { reading: { order_ref: "gid://shopify/Order/3" } } } },
      // Not an outcome: a disclosure or an observation naming an order does not make it a gateway purchase.
      { kind: "observed", body: { order_ref: "gid://shopify/Order/4" } },
      { kind: "disclosure", body: { order_ref: "gid://shopify/Order/5" } },
      { kind: "outcome", body: { handle: "ap_6", order_ref: 6 } },
    ]);
    expect([...refs].sort()).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/2", "gid://shopify/Order/3"]);
  });
});

describe("checkOrders", () => {
  it("3 orders, 1 named by an outcome: 2 unmatched, totalled in USD, oldest first", () => {
    const check = checkOrders(
      { orders: [order(3, "2026-10-15T09:00:00.000Z", 1250), order(1, "2026-10-11T09:00:00.000Z", 899), order(2, "2026-10-12T09:00:00.000Z", 4000)], complete: true },
      new Set(["gid://shopify/Order/2"]),
      SINCE,
    );
    expect(check.orders.map((o) => o.orderRef)).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/2", "gid://shopify/Order/3"]);
    expect(check.unmatched.map((o) => o.orderRef)).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/3"]);
    expect(check.unmatchedTotalMinor).toBe(899 + 1250);
    expect(check.unmatchedUntotalled).toBe(0);
  });

  it("every order matched: none unmatched, total 0", () => {
    const check = checkOrders({ orders: [order(1, "2026-10-11T00:00:00.000Z")], complete: true }, new Set(["gid://shopify/Order/1"]), SINCE);
    expect(check.unmatched).toEqual([]);
    expect(check.unmatchedTotalMinor).toBe(0);
  });

  it("drops orders before the period, keeps one with no time (its period cannot be told)", () => {
    const check = checkOrders({ orders: [order(1, "2026-10-09T23:59:59.000Z"), order(2, null), order(3, "2026-10-10T00:00:00.000Z")], complete: true }, new Set(), SINCE);
    expect(check.orders.map((o) => o.orderRef)).toEqual(["gid://shopify/Order/2", "gid://shopify/Order/3"]);
  });

  it("sums unmatched totals per currency, never across them; an order with no total is in no sum", () => {
    const check = checkOrders(
      { orders: [order(1, "2026-10-11T00:00:00.000Z", null), order(2, "2026-10-11T00:00:00.000Z", 700, "CAD"), order(3, "2026-10-11T00:00:00.000Z", 500)], complete: false },
      new Set(),
      SINCE,
    );
    expect(check.unmatched).toHaveLength(3);
    expect(check.unmatchedTotalMinor).toBe(500);
    expect(check.unmatchedTotals).toEqual({ CAD: 700, USD: 500 });
    expect(check.unmatchedUntotalled).toBe(1);
    expect(check.complete).toBe(false);
  });
});

describe("the checked entry", () => {
  const check = checkOrders({ orders: [order(1, "2026-10-11T00:00:00.000Z", 899), order(2, "2026-10-12T00:00:00.000Z")], complete: true }, new Set(["gid://shopify/Order/2"]), SINCE);
  const body = checkedEntry("shop", check);

  it("holds counts and a total only: no order reference, merchant or time of an order", () => {
    expect(body).toEqual({ rail: "shop", action: "checked", since: "2026-10-10T00:00:00.000Z", order_count: 2, unmatched_count: 1, unmatched_total_minor: 899, complete: true });
    expect(JSON.stringify(body)).not.toContain("gid://");
    expect(JSON.stringify(body)).not.toContain("stickers");
    expect(walletEntryProblem(body)).toBeNull();
  });

  it.each([
    ["an extra key (an order list)", { ...body, orders: ["gid://shopify/Order/1"] }, "holds fields a wallet entry never has (orders)"],
    ["an extra key (an email)", { ...body, email: "jane@buyer.example" }, "holds fields a wallet entry never has (email)"],
    ["revoked, which a check never has", { ...body, revoked: false }, "holds fields a wallet entry never has (revoked)"],
    ["a key set to undefined", { ...body, complete: undefined }, "no boolean complete"],
    ["a deleted key", Object.fromEntries(Object.entries(body).filter(([k]) => k !== "complete")), "no boolean complete"],
    ["a deleted count", Object.fromEntries(Object.entries(body).filter(([k]) => k !== "unmatched_count")), "not non-negative integers"],
    ["a since that is not a UTC instant", { ...body, since: "last week" }, "no ISO 8601 UTC since"],
    ["a negative total", { ...body, unmatched_total_minor: -1 }, "not non-negative integers"],
    ["a fractional count", { ...body, order_count: 1.5 }, "not non-negative integers"],
    ["more unmatched than orders", { ...body, unmatched_count: 3 }, "more unmatched orders than orders"],
  ])("is refused with %s", (_name, bad, said) => {
    expect(walletEntryProblem(bad)).toContain(said);
  });

  it("a linked or unlinked entry may not borrow a check's keys", () => {
    expect(walletEntryProblem({ rail: "shop", action: "linked", revoked: false, order_count: 2 })).toContain("(order_count)");
  });
});
