// Observations are built from Intent Cloud's answers, hold no buyer identity (invariant 3), and observationProblem
// refuses any body that is not one, whatever wrote it.
import { describe, expect, it } from "vitest";
import type { ApprovalStatus, Cart, Offer } from "../contract/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { observationProblem, observeCart, observeSearch, observeStatus, OBSERVED_OFFERS_MAX, WITHHELD } from "./index.ts";

const money = (amount_minor: number) => ({ amount_minor, currency: "USD" as const });
const offer = (n: number, title = "Budget Running Shoe"): Offer => ({
  offer_handle: `of_${String(n).padStart(20, "x")}`,
  merchant: { name: "Resale Hub", domain: "resale.example" },
  title,
  variant: "Size 10",
  price: money(3999),
  shipping: money(199),
  total_kind: "exact",
  availability: "in_stock",
});

describe("observeSearch", () => {
  it("keeps the count, the hidden count and the first offers' handle, title, merchant name, price and shipping", () => {
    const body = observeSearch(4, { offers: [offer(1), offer(2)] }, 1);
    expect(body).toEqual({
      disclosure_seq: 4,
      endpoint: "searchCatalog",
      offers_count: 2,
      offers_hidden: 1,
      offers: [1, 2].map((n) => ({ offer_handle: offer(n).offer_handle, title: "Budget Running Shoe", merchant: "Resale Hub", price_minor: 3999, shipping_minor: 199, currency: "USD" })),
    });
    expect(observationProblem(body)).toBeNull();
  });

  it("caps the list, never the count", () => {
    const body = observeSearch(4, { offers: Array.from({ length: 20 }, (_, i) => offer(i)) }, 0);
    expect(body).toMatchObject({ offers_count: 20 });
    expect(body.endpoint === "searchCatalog" ? body.offers : []).toHaveLength(OBSERVED_OFFERS_MAX);
  });

  it("invariant 3: withholds a title that looks like an email, a phone, a card or an address, and lists where", () => {
    for (const title of ["mail jane@mail.example", "call (415) 555-2671", "4111 1111 1111 1111", "1600 Pennsylvania Ave"]) {
      const body = observeSearch(4, { offers: [offer(1, title), offer(2)] }, 0);
      expect(findIdentity(body)).toEqual([]);
      expect(body).toMatchObject({ withheld: ["$.offers[0].title"], offers: [{ title: WITHHELD }, { title: "Budget Running Shoe" }] });
      expect(observationProblem(body)).toBeNull();
    }
  });
});

describe("observeCart and observeStatus", () => {
  const cart: Cart = {
    cart_handle: "ct_xxxxxxxxxxxxxxxxxxxx",
    merchant: { name: "Resale Hub", domain: "resale.example" },
    item: { title: "Budget Running Shoe", variant: "Size 10" },
    quantity: 1,
    unit_price: money(3999),
    shipping: money(199),
    total: money(4198),
    total_kind: "exact",
    expires_at: "2026-10-16T12:15:00Z",
  };

  it("a cart keeps the title, merchant name, quantity and total; nothing about the buyer", () => {
    expect(observeCart(6, cart)).toEqual({ disclosure_seq: 6, endpoint: "createCart", title: "Budget Running Shoe", merchant: "Resale Hub", quantity: 1, total_minor: 4198, currency: "USD" });
  });

  it("a status keeps the state Intent Cloud returned and what it displays", () => {
    const status: ApprovalStatus = { state: "rejected", display: { merchant: "Resale Hub", title: "Budget Running Shoe", total: money(4198) } };
    expect(observeStatus(9, "ap_x", status)).toEqual({
      disclosure_seq: 9,
      endpoint: "getApproval",
      approval_handle: "ap_x",
      state: "rejected",
      title: "Budget Running Shoe",
      merchant: "Resale Hub",
      total_minor: 4198,
      currency: "USD",
    });
  });

  it("an outcome's Shopify order gid that passes Luhn is kept whole; a card anywhere else is still withheld (ADR-0019)", () => {
    // Fixed: a 14-digit order number that passes Luhn, so the card check alone reads the gid as a card.
    const gid = "gid://shopify/Order/12345678901237";
    const status = (orderRef: string, title = "Budget Running Shoe"): ApprovalStatus => ({
      state: "approved",
      display: { merchant: "Resale Hub", title, total: money(4198) },
      outcome: { state: "ordered", source: "shop_api", assurance: "verified", order_ref: orderRef, observed_at: "2026-10-16T12:00:00Z" },
    });
    const kept = observeStatus(9, "ap_x", status(gid));
    expect(kept).toMatchObject({ outcome: { order_ref: gid } });
    expect(kept.withheld).toBeUndefined();
    expect(observationProblem(kept)).toBeNull();
    // Attack: the same digits bare at the order path, or the gid shape at another path, are withheld.
    expect(observeStatus(9, "ap_x", status("12345678901237")).withheld).toEqual(["$.outcome.order_ref"]);
    expect(observeStatus(9, "ap_x", status(gid, gid)).withheld).toEqual(["$.title"]);
  });
});

describe("observationProblem", () => {
  const good = observeCart(6, {
    cart_handle: "ct_xxxxxxxxxxxxxxxxxxxx",
    merchant: { name: "Resale Hub", domain: "resale.example" },
    item: { title: "Budget Running Shoe", variant: "Size 10" },
    quantity: 1,
    unit_price: money(3999),
    shipping: money(199),
    total: money(4198),
    total_kind: "exact",
    expires_at: "2026-10-16T12:15:00Z",
  });

  it.each([
    ["an unknown endpoint", { ...good, endpoint: "deleteEverything" }],
    ["an extra field (a buyer field smuggled in)", { ...good, buyer: "Jane" }],
    ["a missing field", { disclosure_seq: 6, endpoint: "createCart" }],
    ["a negative reference", { ...good, disclosure_seq: -1 }],
    ["not an object", "observed"],
  ])("refuses %s", (_name, body) => {
    expect(observationProblem(body)).toMatch(/^is not an observation/);
  });

  it("attack: refuses a well-shaped body that holds buyer identity", () => {
    expect(observationProblem({ ...good, title: "ship to jane@mail.example" })).toMatch(/buyer identity \(email at \$\.title\)/);
  });
});
