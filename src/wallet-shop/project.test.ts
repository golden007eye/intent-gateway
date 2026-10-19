// The allow-list projection of Shop's answers (plan G7a): only named fields come out, a ZIP only as a verdict, and
// an error only as a status, a code and a fixed label; Shop's own words never do. Inputs have the shapes the S1 spike
// captured (2026-10-18), filled with made-up values only.
import { describe, expect, it } from "vitest";
import { WalletRailError } from "../wallet/index.ts";
import { createHash } from "node:crypto";
import { findIdentity } from "../privacy/index.ts";
import {
  asksForAddressFields,
  budgetInstrument,
  checkoutRefOf,
  ORDERS_PAGE,
  projectAccount,
  projectCheckout,
  projectOrders,
  readToolAnswer,
} from "./project.ts";

const json = (value: unknown, status = 200, type = "application/json") => ({
  status,
  headers: [["content-type", type]] as [string, string][],
  body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8"),
});
const IDENTITY = "Jane Doe <jane@buyer.example>, 123 Main St";
const PII = {
  name: "Jane Doe-Fakename",
  email: "jane.doe@buyer.example",
  phone: "+1 415 555 2671",
  street: "123 Main St",
  city: "Springfield",
  picture: "https://cdn.shop.example/b/user-content/jane.jpg",
  cardToken: "spt_SECRET_CARD_TOKEN_1234",
};
/** A saved address as S1 saw one. */
const address = {
  first_name: "Jane",
  last_name: "Doe-Fakename",
  street_address: PII.street,
  extended_address: "Apt 4",
  address_locality: PII.city,
  address_region: "CA",
  address_country: "US",
  postal_code: "94107",
  phone_number: PII.phone,
};

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe("readToolAnswer", () => {
  it("reads structuredContent, a text copy, and a streamed (SSE) answer", () => {
    expect(readToolAnswer(json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { a: 1 } } }))).toEqual({ content: { a: 1 }, isError: false, railCode: null });
    expect(readToolAnswer(json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"b":2}' }], isError: true } }))).toEqual({
      content: { b: 2 },
      isError: true,
      railCode: null,
    });
    const sse = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"c":3}}}\n\n`;
    expect(readToolAnswer(json(sse, 200, "text/event-stream")).content).toEqual({ c: 3 });
  });

  it("a tool error as S1 saw it (HTTP 200, isError, ucp.status error, messages[{code, severity}]): an error with the code only, never the message", () => {
    const content = {
      ucp: { version: "2026-08-25", status: "error" },
      messages: [{ type: "error", content_type: "plain", code: "invalid_checkout_id", content: IDENTITY, severity: "unrecoverable" }],
    };
    expect(readToolAnswer(json({ jsonrpc: "2.0", id: 1, result: { structuredContent: content, isError: true } }))).toMatchObject({ isError: true, railCode: "invalid_checkout_id" });
    // ucp.status error alone marks it an error too; a code with text in it is not kept.
    const quiet = readToolAnswer(json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ...content, messages: [{ type: "error", code: IDENTITY }] } } }));
    expect(quiet).toMatchObject({ isError: true, railCode: null });
  });

  it("keeps only the code and a fixed label of an error; Shop's message never comes out", () => {
    const cases: [ReturnType<typeof json>, number, number | null][] = [
      [json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: IDENTITY, data: { email: "jane@buyer.example" } } }), 200, -32602],
      // S1 step 8: a schema error and an unknown tool are HTTP 400 with JSON-RPC -32602.
      [json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "$.id: required property missing" } }, 400), 400, -32602],
      [json({ jsonrpc: "2.0", id: 1, error: { code: "weird", message: IDENTITY } }), 200, null],
      [json({ error: "invalid_token", error_description: IDENTITY }, 401), 401, null],
      [json(IDENTITY, 500, "text/plain"), 500, null],
      [json(`not json ${IDENTITY}`), 200, null],
    ];
    for (const [response, status, code] of cases) {
      const error = thrown(() => readToolAnswer(response));
      expect(error).toBeInstanceOf(WalletRailError);
      expect(error).toMatchObject({ httpStatus: status, code });
      expect(JSON.stringify(error) + (error as Error).message).not.toMatch(/Jane|jane@|Main St/);
    }
  });
});

describe("projectAccount (S1 step 4 shape)", () => {
  const account = (patch: Record<string, unknown> = {}) => ({
    ucp: { version: "2026-08-25" },
    signed_in: true,
    buyer: { email: PII.email },
    picture: { type: "image", url: PII.picture },
    addresses: [{ type: "shipping_address", id: "6f9c1e2a-0b7d-4c3e-9a51-2d8e4f7a1b30", ...address }],
    preferred_address_id: "6f9c1e2a-0b7d-4c3e-9a51-2d8e4f7a1b30",
    currency: "USD",
    payment: { instruments: [{ handler_id: "shop_pay", type: "shop_pay", display: { limit: 1500, remaining_amount: 1200, renewal_type: "monthly", renews_at: "2026-11-01T00:00:00Z" } }] },
    selectable_instruments: [
      {
        id: "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40",
        handler_id: "shop_pay",
        type: "shop_pay",
        display: { funding_instrument: { type: "card", brand: "visa", last_digits: "4242", name: PII.name, description: "Visa •••• 4242" } },
        credential: { type: "shop_token", token: PII.cardToken },
      },
    ],
    links: [{ type: "manage_connection", url: "https://shop.app/account/connections", title: "Manage connected apps" }],
    messages: [],
    ...patch,
  });

  it("attack: keeps the budget left and connected only; email, picture, names, addresses, card digits and the credential are dropped", () => {
    const projected = projectAccount(account());
    expect(projected).toEqual({
      budgetRemaining: { amountMinor: 1200, currency: "USD" },
      budgetLimit: { amount: { amountMinor: 1500, currency: "USD" }, renewal: "monthly", renewsAt: "2026-11-01T00:00:00Z" },
      manageUrl: "https://shop.app/account/connections",
      connected: true,
    });
    const text = JSON.stringify(projected);
    for (const value of [...Object.values(PII), "4242", "Apt 4", "6f9c1e2a"]) expect(text).not.toContain(value);
  });

  it("no budget, an odd one, several or a missing currency: null (unknown, never assumed)", () => {
    expect(projectAccount(account({ payment: { instruments: [] } })).budgetRemaining).toBeNull();
    expect(projectAccount(account({ currency: undefined })).budgetRemaining).toBeNull();
    expect(projectAccount(account({ payment: { instruments: [{ display: { remaining_amount: 1.5 } }] } })).budgetRemaining).toBeNull();
    expect(projectAccount(account({ payment: { instruments: [{ display: { remaining_amount: -1 } }] } })).budgetRemaining).toBeNull();
    expect(projectAccount(account({ payment: { instruments: [{ display: { remaining_amount: 100 } }, { display: { remaining_amount: 200 } }] } })).budgetRemaining).toBeNull();
    // The old guess (budget.remaining) is not read.
    expect(projectAccount({ currency: "USD", budget: { remaining: { amount: 1500, currency: "USD" } } }).budgetRemaining).toBeNull();
    expect(projectAccount(account({ currency: "CAD" })).budgetRemaining).toEqual({ amountMinor: 1200, currency: "CAD" });
  });

  it("the connection removed in the Shop app (S1 step 12b warnings): not connected, no budget", () => {
    for (const code of ["claims_unavailable", "addresses_unavailable", "budget_unavailable", "payment_instruments_unavailable"]) {
      expect(projectAccount(account({ messages: [{ type: "warning", code, content: IDENTITY }] }))).toEqual({ budgetRemaining: null, budgetLimit: null, manageUrl: "https://shop.app/account/connections", connected: false });
    }
    expect(projectAccount(account({ messages: [{ type: "warning", code: "something_else" }] })).connected).toBe(true);
  });

  it("the limit: kept with a known renewal word only; none without a positive integer limit", () => {
    const display = (d: Record<string, unknown>) => account({ payment: { instruments: [{ type: "shop_pay", display: { remaining_amount: 900, ...d } }] } });
    expect(projectAccount(display({ limit: 4000, renewal_type: "weekly" })).budgetLimit).toEqual({ amount: { amountMinor: 4000, currency: "USD" }, renewal: "weekly", renewsAt: null });
    expect(projectAccount(display({ limit: 4000, renewal_type: "every full moon" })).budgetLimit).toEqual({ amount: { amountMinor: 4000, currency: "USD" }, renewal: null, renewsAt: null });
    expect(projectAccount(display({ limit: 4000 })).budgetLimit?.renewal).toBeNull();
    // renews_at only as an ISO 8601 UTC instant: anything else (a local time, text that would be printed) is dropped.
    expect(projectAccount(display({ limit: 4000, renews_at: "2026-11-01T00:00:00Z" })).budgetLimit?.renewsAt).toBe("2026-11-01T00:00:00Z");
    for (const renewsAt of ["2026-11-01", "2026-11-01T00:00:00+02:00", "2026-13-45T99:99:99Z", "soon\nintent: ok", 1793491200]) {
      expect(projectAccount(display({ limit: 4000, renews_at: renewsAt })).budgetLimit?.renewsAt).toBeNull();
    }
    for (const limit of [undefined, 0, -5, 12.5, "4000"]) expect(projectAccount(display({ limit })).budgetLimit).toBeNull();
  });

  it("attack: the connections page is Shop's manage_connection link only when https on shop.app with nothing extra; S1's page when there is none", () => {
    const linked = (url: unknown) => projectAccount(account({ links: [{ type: "manage_connection", url }] })).manageUrl;
    expect(linked("https://shop.app/account/connections")).toBe("https://shop.app/account/connections");
    for (const url of [
      "http://shop.app/account/connections",
      "https://shop.app.evil.example/account/connections",
      "https://evil.example/shop.app",
      "https://user:pw@shop.app/account/connections",
      "https://shop.app:8443/account/connections",
      "https://shop.app/account/connections?next=https://evil.example",
      "https://shop.app/account/connections#x",
      "javascript:alert(1)",
      42,
    ]) {
      expect(linked(url)).toBeNull();
    }
    expect(linked(undefined)).toBeNull();
    // No manage_connection link at all: S1's page; never another link type's URL.
    expect(projectAccount(account({ links: [{ type: "account", url: "https://evil.example/account" }] })).manageUrl).toBe("https://shop.app/account/connections");
    expect(projectAccount(account({ links: undefined })).manageUrl).toBe("https://shop.app/account/connections");
  });
});

describe("projectCheckout (S1 step 6 shape)", () => {
  const card = { id: "card-1", handler_id: "shop_pay", type: "shop_pay", selected: false, credential: { type: "x", token: PII.cardToken }, display: { brand: "visa", last_digits: "4242" } };
  const budget = { id: "shop_abcDEF123", handler_id: "shop_pay", type: "delegated_budget", selected: true, credential: { type: "x" }, display: { remaining_amount: 1500, limit: 1500 } };
  const base = {
    ucp: { version: "2026-08-25" },
    id: "gid://shopify/Checkout/abc",
    status: "ready_for_complete",
    currency: "USD",
    buyer: { email: PII.email, phone_number: PII.phone, consent: {} },
    line_items: [{ id: "gid://shopify/CartLine/1?cart=x", item: { id: "gid://shopify/ProductVariant/1", title: "Sticker", price: 1000 }, quantity: 2 }],
    totals: [
      { type: "subtotal", amount: 1000 },
      { type: "total", amount: 1399 },
    ],
    fulfillment: { methods: [{ id: "m", type: "shipping", selected_destination_id: "d1", destinations: [{ ...address, postal_code: "94107-1234", id: "d1" }] }] },
    payment: { instruments: [card, budget] },
    messages: [],
  };

  it("attack: keeps the named fields only (no merchant field: the requested store), compares the ZIP in memory, drops buyer, address and card", () => {
    const { checkout: projected, checkoutId } = projectCheckout(base, "asked.myshopify.com", "94107");
    expect(checkoutId).toBe("gid://shopify/Checkout/abc");
    expect(projected).toEqual({
      checkoutRef: checkoutRefOf("gid://shopify/Checkout/abc") ?? "",
      storeDomain: "asked.myshopify.com",
      status: "open",
      merchantOrigin: null,
      lines: [{ variantRef: "gid://shopify/ProductVariant/1", quantity: 2, title: "Sticker" }],
      total: { amountMinor: 1399, currency: "USD" },
      shipTo: "match",
      orderRef: null,
      budgetOffered: true,
      // 1000 + nothing is not 1399: totals that do not add up are never guessed (contract 1.7.0 CheckoutTotals).
      totals: null,
      // Only the coarse postcode crosses the port (contract 1.7.0): 94107, never 94107-1234.
      shipToArea: { country: "US", postalCodeCoarse: "94107" },
      continueUrl: null,
    });
    const text = JSON.stringify(projected);
    for (const value of [...Object.values(PII), "Jane", "94107-1234", "1234", "Checkout/abc", "4242"]) expect(text).not.toContain(value);
    expect(projectCheckout(base, "asked.myshopify.com", "10001").checkout.shipTo).toBe("differs");
  });

  it("budgetInstrument: the delegated_budget instrument only, never the card; none or two: none", () => {
    expect(budgetInstrument(base)).toBe(budget);
    expect(budgetInstrument({ payment: { instruments: [{ ...card, selected: true }] } })).toBeNull();
    expect(budgetInstrument({ payment: { instruments: [budget, { ...budget, id: "shop_other" }] } })).toBeNull();
    expect(budgetInstrument({ payment: { instruments: [{ ...budget, id: "" }] } })).toBeNull();
    expect(projectCheckout({ ...base, payment: { instruments: [card] } }, "asked.myshopify.com", undefined).checkout.budgetOffered).toBe(false);
  });

  it("completed (S1 step 9): the order id, and the store from the order permalink's myshopify host", () => {
    const completed = {
      ...base,
      status: "completed",
      payment: { instruments: [] },
      order: { id: "gid://shopify/Order/9", label: "ABC", permalink_url: "https://real-store.myshopify.com/checkouts/cn/x/thank_you?key=SECRET" },
    };
    expect(projectCheckout(completed, "asked.myshopify.com", undefined).checkout).toMatchObject({
      status: "completed",
      orderRef: "gid://shopify/Order/9",
      storeDomain: "real-store.myshopify.com",
      budgetOffered: false,
    });
    // A permalink on a storefront domain is not a store name: the requested store stays.
    const other = { ...completed, order: { ...completed.order, permalink_url: "https://stickers.example/x" } };
    expect(projectCheckout(other, "asked.myshopify.com", undefined).checkout.storeDomain).toBe("asked.myshopify.com");
  });

  it("names a checkout whose id carries a ?key= credential only by the sha256 of the part before `?` (amendment L1)", () => {
    const id = "gid://shopify/Checkout/abc?key=SECRET-CHECKOUT-KEY";
    const { checkout, checkoutId } = projectCheckout({ ...base, id }, "asked.myshopify.com", undefined);
    expect(checkoutId).toBe(id);
    expect(checkout.checkoutRef).toBe(`sha256:${createHash("sha256").update("gid://shopify/Checkout/abc", "utf8").digest("hex")}`);
    // Another read of the same checkout with another key names the same checkout.
    expect(projectCheckout({ ...base, id: "gid://shopify/Checkout/abc?key=OTHER" }, "asked.myshopify.com", undefined).checkout.checkoutRef).toBe(checkout.checkoutRef);
    expect(JSON.stringify(checkout)).not.toContain("SECRET");
  });

  it("refuses a checkout id with nothing before its `?`: it has no checkout ref", () => {
    expect(() => projectCheckout({ ...base, id: "?key=SECRET" }, "asked.myshopify.com", undefined)).toThrow("no usable id");
  });

  it("maps statuses, reads an unknown one as processing, and drops what reads as identity, a query or is not https", () => {
    const read = (patch: Record<string, unknown>) => projectCheckout({ ...base, ...patch }, "asked.myshopify.com", undefined).checkout;
    expect(read({ status: "completed", order: { id: "gid://shopify/Order/9" } })).toMatchObject({ status: "completed", orderRef: "gid://shopify/Order/9" });
    expect(read({ status: "completed", order: { id: "gid://shopify/Order/9?key=SECRET" } }).orderRef).toBeNull();
    // A 14-digit order number that passes Luhn (fixed) is kept as the order's ref (ADR-0019, ORDER_REF_AT.projection) ...
    expect(read({ status: "completed", order: { id: "gid://shopify/Order/12345678901237" } }).orderRef).toBe("gid://shopify/Order/12345678901237");
    // ... but not the same digits bare, nor in any other gid shape: those read as a card and are dropped.
    for (const id of ["12345678901237", "4111111111111111", "gid://shopify/Checkout/4111111111111111", "gid://shopify/Order/4111111111111111/x", "x/gid://shopify/Order/4111111111111111"]) {
      expect(read({ status: "completed", order: { id } }).orderRef, id).toBeNull();
    }
    expect(read({ line_items: [{ item: { id: "gid://shopify/ProductVariant/1?key=SECRET" }, quantity: 1 }] }).lines).toEqual([]);
    expect(read({ status: "requires_escalation" }).status).toBe("buyer_review");
    expect(read({ status: "canceled" }).status).toBe("failed");
    expect(read({ status: "something_new" }).status).toBe("processing");
    expect(read({ merchant: { domain: "stickers.example", url: "http://stickers.example" } })).toMatchObject({ storeDomain: "asked.myshopify.com", merchantOrigin: null });
    expect(read({ merchant: { url: "https://stickers.example/path" } }).merchantOrigin).toBe("https://stickers.example");
    expect(read({ line_items: [{ item: { id: "gid://shopify/ProductVariant/1", title: "Engraved for jane@buyer.example" }, quantity: 1 }] }).lines[0]?.title).toBe("");
    expect(() => read({ id: "jane@buyer.example" })).toThrow(WalletRailError);
  });
});

describe("asksForAddressFields", () => {
  it("is true for an error message about the destination or an address, false otherwise", () => {
    expect(asksForAddressFields({ messages: [{ type: "error", code: "missing", path: "$.checkout.fulfillment.methods[0].destinations[0].street_address" }] })).toBe(true);
    expect(asksForAddressFields({ checkout: { messages: [{ type: "error", code: "address_required" }] } })).toBe(true);
    expect(asksForAddressFields({ messages: [{ type: "warning", path: "$.fulfillment" }, { type: "error", code: "out_of_stock", path: "$.line_items[0]" }] })).toBe(false);
    expect(asksForAddressFields({ messages: [{ type: "error", code: "checkout_completion_ineligible", severity: "requires_buyer_review" }] })).toBe(false);
  });
});

describe("projectOrders (plan G12; S1 step 10 shape)", () => {
  /** An order as S1 saw one, with identity in fields the gateway does not keep. */
  const order = (patch: Record<string, unknown> = {}) => ({
    id: "0a0b0c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
    label: `Engraved for ${PII.name}`,
    placed_at: "2026-10-12T09:30:00-07:00",
    status: "paid",
    source: "shopify",
    seller: { name: `${PII.name}'s favourite shop`, domain: "stickers.example", myshopify_domain: "sticker-store.myshopify.com", shopify_shop_id: "10000000001" },
    line_items: [{ id: "x", item: { id: "gid://shopify/ProductVariant/1", title: `Engraved: ${PII.name}, ${PII.street}` }, quantity: { total: 1, fulfilled: 0 } }],
    fulfillment: { expectations: [{ destination: { address_locality: PII.city, address_country: "US" } }] },
    checkout_id: "https://stickers.example/10000000001/orders/abc/authenticate?key=SECRET-ORDER-KEY",
    permalink_url: "https://stickers.example/10000000001/orders/abc/authenticate?key=SECRET-ORDER-KEY",
    payment_status: "paid",
    shopify_order_id: "1001",
    totals: [{ type: "total", amount: 899 }],
    currency: "USD",
    customer: { email: PII.email, phone: PII.phone },
    ...patch,
  });

  it("attack: keeps only {order_ref (gid from shopify_order_id), total, merchant_origin (seller.domain), created_at}; identity and checkout_id dropped", () => {
    const projected = projectOrders({ orders: [order()], buyer: { ...PII }, pagination: { has_next_page: false, cursor: "abc" } });
    expect(projected).toEqual({
      orders: [{ orderRef: "gid://shopify/Order/1001", total: { amountMinor: 899, currency: "USD" }, merchantOrigin: "https://stickers.example", createdAt: "2026-10-12T16:30:00.000Z" }],
      complete: true,
    });
    expect(findIdentity(projected)).toEqual([]);
    const text = JSON.stringify(projected);
    for (const value of [...Object.values(PII), "Jane", "SECRET-ORDER-KEY", "0a0b0c0d", "authenticate"]) expect(text).not.toContain(value);
  });

  it("a 14-digit shopify_order_id that passes Luhn is still the order's ref (built from digits, not scanned as a card)", () => {
    const luhn = (n: string): boolean =>
      n
        .split("")
        .reverse()
        .map(Number)
        .map((d, i) => (i % 2 === 1 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d))
        .reduce((a, b) => a + b, 0) %
        10 ===
      0;
    const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => `1234567890123${d}`).find(luhn) ?? "";
    // The very case: the identity scan reads it as a card number.
    expect(findIdentity({ order_ref: `gid://shopify/Order/${digits}` }).map((f) => f.kind)).toContain("card");
    expect(projectOrders({ orders: [order({ shopify_order_id: digits })] }).orders[0]?.orderRef).toBe(`gid://shopify/Order/${digits}`);
  });

  it("an order Shop read from an email (no shopify_order_id, no seller domain) keeps Shop's id; a hostile id is dropped whole", () => {
    const email = order({ shopify_order_id: undefined, seller: { name: "Some Store" }, source: "email" });
    expect(projectOrders({ orders: [email] }).orders[0]).toMatchObject({ orderRef: "0a0b0c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", merchantOrigin: null });
    const projected = projectOrders({
      orders: [
        order({ shopify_order_id: "1?key=secret", id: "gid://shopify/Order/1?key=secret" }),
        order({ shopify_order_id: undefined, id: PII.email }),
        order({ shopify_order_id: undefined, id: 42 }),
        order({ shopify_order_id: "2" }),
      ],
    });
    expect(projected.orders.map((o) => o.orderRef)).toEqual(["gid://shopify/Order/2"]);
  });

  it("a missing or odd total, origin or time becomes null, never a guess", () => {
    const [o] = projectOrders({
      orders: [order({ totals: [{ type: "total", amount: -5 }], seller: { domain: "not a host" }, placed_at: "yesterday" })],
    }).orders;
    expect(o).toEqual({ orderRef: "gid://shopify/Order/1001", total: null, merchantOrigin: null, createdAt: null });
  });

  it("is incomplete when Shop says another page exists, or returned a full page", () => {
    expect(projectOrders({ orders: [], pagination: { has_next_page: true } }).complete).toBe(false);
    expect(projectOrders({ orders: Array.from({ length: ORDERS_PAGE }, (_, i) => order({ shopify_order_id: String(i) })) }).complete).toBe(false);
    expect(projectOrders({})).toEqual({ orders: [], complete: true });
  });
});
