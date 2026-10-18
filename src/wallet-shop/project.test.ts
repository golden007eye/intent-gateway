// The allow-list projection of Shop's answers (plan G7a): only named fields come out, a ZIP only as a verdict, and
// an error only as a status, a code and a fixed label; Shop's own words never do.
import { describe, expect, it } from "vitest";
import { WalletRailError } from "../wallet/index.ts";
import { createHash } from "node:crypto";
import { findIdentity } from "../privacy/index.ts";
import { asksForAddressFields, checkoutRefOf, ORDERS_PAGE, projectAccount, projectCheckout, projectOrders, readToolAnswer } from "./project.ts";

const json = (value: unknown, status = 200, type = "application/json") => ({
  status,
  headers: [["content-type", type]] as [string, string][],
  body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8"),
});
const IDENTITY = "Jane Doe <jane@buyer.example>, 123 Main St";

describe("readToolAnswer", () => {
  it("reads structuredContent, a text copy, and a streamed (SSE) answer", () => {
    expect(readToolAnswer(json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { a: 1 } } }))).toEqual({ content: { a: 1 }, isError: false });
    expect(readToolAnswer(json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"b":2}' }], isError: true } }))).toEqual({ content: { b: 2 }, isError: true });
    const sse = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"c":3}}}\n\n`;
    expect(readToolAnswer(json(sse, 200, "text/event-stream")).content).toEqual({ c: 3 });
  });

  it("keeps only the code and a fixed label of an error; Shop's message never comes out", () => {
    const cases: [ReturnType<typeof json>, number, number | null][] = [
      [json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: IDENTITY, data: { email: "jane@buyer.example" } } }), 200, -32602],
      [json({ jsonrpc: "2.0", id: 1, error: { code: "weird", message: IDENTITY } }), 200, null],
      [json({ error: "invalid_token", error_description: IDENTITY }, 401), 401, null],
      [json(IDENTITY, 500, "text/plain"), 500, null],
      [json(`not json ${IDENTITY}`), 200, null],
    ];
    for (const [response, status, code] of cases) {
      const error = (() => {
        try {
          readToolAnswer(response);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(WalletRailError);
      expect(error).toMatchObject({ httpStatus: status, code });
      expect(JSON.stringify(error) + (error as Error).message).not.toMatch(/Jane|jane@|Main St/);
    }
  });
});

describe("projectAccount", () => {
  it("keeps the budget left and a gid saved-address id; name, email, phone, address fields, orders and cards are dropped", () => {
    const projected = projectAccount({
      account: {
        name: "Jane Doe",
        email: "jane@buyer.example",
        budget: { remaining: { amount: 1500, currency: "USD" } },
        preferred_address_id: "gid://shopify/MailingAddress/42",
        addresses: [{ id: "gid://shopify/MailingAddress/42", address1: "123 Main St", zip: "94107" }],
        orders: [{ id: "gid://shopify/Order/1" }],
        payment: { card_number: "4111 1111 1111 1111" },
      },
    });
    expect(projected).toEqual({ account: { budgetRemaining: { amountMinor: 1500, currency: "USD" } }, savedAddressId: "gid://shopify/MailingAddress/42" });
  });

  it("has no saved-address id unless one is an opaque gid: an address text or a free-form id is never used", () => {
    expect(projectAccount({ addresses: [{ address1: "123 Main St" }] }).savedAddressId).toBeNull();
    expect(projectAccount({ preferred_address_id: "123 Main St", addresses: [{ id: "home" }] }).savedAddressId).toBeNull();
    expect(projectAccount({ addresses: [{ id: "gid://shopify/MailingAddress/7" }] }).savedAddressId).toBe("gid://shopify/MailingAddress/7");
    expect(projectAccount({}).account.budgetRemaining).toBeNull();
    expect(projectAccount({ budget: { remaining: { amount: 1.5, currency: "USD" } } }).account.budgetRemaining).toBeNull();
  });
});

describe("projectCheckout", () => {
  const base = {
    id: "gid://shopify/Checkout/abc",
    status: "ready_for_complete",
    currency: "USD",
    line_items: [{ item: { id: "gid://shopify/ProductVariant/1", title: "Sticker" }, quantity: 2 }],
    totals: [{ type: "total", amount: 1399 }],
    merchant: { domain: "real-store.myshopify.com", url: "https://stickers.example/path" },
    fulfillment: { methods: [{ destinations: [{ id: "d1", first_name: "Jane", postal_code: "94107-1234" }], selected_destination_id: "d1" }] },
    buyer: { email: "jane@buyer.example" },
  };

  it("keeps the named fields only and compares the ZIP in memory", () => {
    const { checkout: projected, checkoutId } = projectCheckout({ checkout: base }, "asked.myshopify.com", "94107");
    expect(checkoutId).toBe("gid://shopify/Checkout/abc");
    expect(projected).toEqual({
      checkoutRef: checkoutRefOf("gid://shopify/Checkout/abc") ?? "",
      storeDomain: "real-store.myshopify.com",
      status: "open",
      merchantOrigin: "https://stickers.example",
      lines: [{ variantRef: "gid://shopify/ProductVariant/1", quantity: 2, title: "Sticker" }],
      total: { amountMinor: 1399, currency: "USD" },
      shipTo: "match",
      orderRef: null,
    });
    expect(JSON.stringify(projected)).not.toMatch(/Jane|jane@|94107|Checkout\/abc/);
    expect(projectCheckout({ checkout: base }, "asked.myshopify.com", "10001").checkout.shipTo).toBe("differs");
  });

  it("names a checkout whose id carries a ?key= credential only by the sha256 of the part before `?` (amendment L1)", () => {
    const id = "gid://shopify/Checkout/abc?key=SECRET-CHECKOUT-KEY";
    const { checkout, checkoutId } = projectCheckout({ checkout: { ...base, id } }, "asked.myshopify.com", undefined);
    expect(checkoutId).toBe(id);
    expect(checkout.checkoutRef).toBe(`sha256:${createHash("sha256").update("gid://shopify/Checkout/abc", "utf8").digest("hex")}`);
    // Another read of the same checkout with another key names the same checkout.
    expect(projectCheckout({ checkout: { ...base, id: "gid://shopify/Checkout/abc?key=OTHER" } }, "asked.myshopify.com", undefined).checkout.checkoutRef).toBe(checkout.checkoutRef);
    expect(JSON.stringify(checkout)).not.toContain("SECRET");
  });

  it("refuses a checkout id with nothing before its `?`: it has no checkout ref", () => {
    expect(() => projectCheckout({ checkout: { ...base, id: "?key=SECRET" } }, "asked.myshopify.com", undefined)).toThrow("no usable id");
  });

  it("maps statuses, reads an unknown one as processing, and drops what reads as identity, a query or is not https", () => {
    const read = (patch: Record<string, unknown>) => projectCheckout({ ...base, ...patch }, "asked.myshopify.com", undefined).checkout;
    expect(read({ status: "completed", order: { id: "gid://shopify/Order/9" } })).toMatchObject({ status: "completed", orderRef: "gid://shopify/Order/9" });
    expect(read({ status: "completed", order: { id: "gid://shopify/Order/9?key=SECRET" } }).orderRef).toBeNull();
    expect(read({ line_items: [{ item: { id: "gid://shopify/ProductVariant/1?key=SECRET" }, quantity: 1 }] }).lines).toEqual([]);
    expect(read({ status: "requires_escalation" }).status).toBe("buyer_review");
    expect(read({ status: "canceled" }).status).toBe("failed");
    expect(read({ status: "something_new" }).status).toBe("processing");
    expect(read({ merchant: { domain: "stickers.example", url: "http://stickers.example" } })).toMatchObject({ storeDomain: "asked.myshopify.com", merchantOrigin: null });
    expect(read({ line_items: [{ item: { id: "gid://shopify/ProductVariant/1", title: "Engraved for jane@buyer.example" }, quantity: 1 }] }).lines[0]?.title).toBe("");
    expect(() => read({ id: "jane@buyer.example" })).toThrow(WalletRailError);
  });
});

describe("asksForAddressFields", () => {
  it("is true for an error message about the destination or an address, false otherwise", () => {
    expect(asksForAddressFields({ messages: [{ type: "error", code: "missing", path: "$.checkout.fulfillment.methods[0].destinations[0].address1" }] })).toBe(true);
    expect(asksForAddressFields({ checkout: { messages: [{ type: "error", code: "address_required" }] } })).toBe(true);
    expect(asksForAddressFields({ messages: [{ type: "warning", path: "$.fulfillment" }, { type: "error", code: "out_of_stock", path: "$.line_items[0]" }] })).toBe(false);
  });
});

describe("projectOrders (plan G12)", () => {
  const PII = {
    name: "Jane Doe-Fakename",
    email: "jane.doe@buyer.example",
    phone: "+1 415 555 2671",
    address1: "123 Main St",
    city: "Springfield",
  };
  const address = { first_name: "Jane", last_name: "Doe-Fakename", address1: PII.address1, city: PII.city, postal_code: "94107", phone: PII.phone };
  /** An order as Shop's history might hold it: identity in every field the gateway does not keep, and in some it does. */
  const hostile = (id: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    name: `#1001 for ${PII.name}`,
    created_at: "2026-10-12T09:30:00-07:00",
    currency: "USD",
    totals: [
      { type: "subtotal", amount: 500 },
      { type: "total", amount: 899 },
    ],
    merchant: { domain: "sticker-store.myshopify.com", url: `https://stickers.example/account?email=${PII.email}`, name: `${PII.name}'s favourite shop` },
    customer: { first_name: "Jane", last_name: "Doe-Fakename", email: PII.email, phone: PII.phone },
    email: PII.email,
    phone: PII.phone,
    shipping_address: address,
    billing_address: address,
    line_items: [{ item: { id: "gid://shopify/ProductVariant/1", title: `Engraved: ${PII.name}, ${PII.address1}` }, quantity: 1 }],
    note: `Call ${PII.phone}`,
    ...extra,
  });

  it("attack: keeps only {order_ref, total, merchant_origin, created_at}; every identity string is dropped", () => {
    const projected = projectOrders({ orders: [hostile("gid://shopify/Order/1001")], buyer: { ...PII }, pagination: { has_next_page: false } });
    expect(projected).toEqual({
      orders: [{ orderRef: "gid://shopify/Order/1001", total: { amountMinor: 899, currency: "USD" }, merchantOrigin: "https://stickers.example", createdAt: "2026-10-12T16:30:00.000Z" }],
      complete: true,
    });
    expect(findIdentity(projected)).toEqual([]);
    const text = JSON.stringify(projected);
    for (const value of [...Object.values(PII), "Jane", "94107"]) expect(text).not.toContain(value);
  });

  it("attack: an order whose id is not a plain reference (a query, an email) is dropped whole", () => {
    const projected = projectOrders({ orders: [hostile("gid://shopify/Order/1?key=secret"), hostile(PII.email), hostile(42), hostile("gid://shopify/Order/2")] });
    expect(projected.orders.map((o) => o.orderRef)).toEqual(["gid://shopify/Order/2"]);
  });

  it("a missing or odd total, origin or time becomes null, never a guess", () => {
    const [o] = projectOrders({
      orders: [hostile("gid://shopify/Order/3", { totals: [{ type: "total", amount: -5 }], merchant: { url: "http://plain.example" }, created_at: "yesterday" })],
    }).orders;
    expect(o).toEqual({ orderRef: "gid://shopify/Order/3", total: null, merchantOrigin: null, createdAt: null });
  });

  it("is incomplete when Shop says another page exists, or returned a full page", () => {
    expect(projectOrders({ orders: [], pagination: { has_next_page: true } }).complete).toBe(false);
    expect(projectOrders({ orders: Array.from({ length: ORDERS_PAGE }, (_, i) => hostile(`gid://shopify/Order/${String(i)}`)) }).complete).toBe(false);
    expect(projectOrders({})).toEqual({ orders: [], complete: true });
  });
});
