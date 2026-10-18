import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodyText,
  bodyValue,
  findIdentity,
  type Finding,
  type FindingKind,
  holdsNestedSecret,
  isSecretKey,
  nestedSecrets,
  ORDER_REF_AT,
  SCAN_DEPTH,
  SHOPIFY_ORDER_GID,
} from "./index.ts";

// Invariant 3 (no buyer identity in the gateway): each positive is identity an agent might try to send out.
const positives: [label: string, body: unknown, expected: Finding][] = [
  ["PAN with spaces", { query: "4111 1111 1111 1111" }, { path: "$.query", kind: "card" }],
  ["PAN with dashes", { note: "pay with 5500-0000-0000-0004" }, { path: "$.note", kind: "card" }],
  ["PAN as a number", { ref: 4111111111111111 }, { path: "$.ref", kind: "card" }],
  ["PAN as a bigint", { ref: 4111111111111111n }, { path: "$.ref", kind: "card" }],
  ["15-digit Amex", ["378282246310005"], { path: "$[0]", kind: "card" }],
  ["PAN followed by expiry", { q: "card 4111 1111 1111 1111 12 25" }, { path: "$.q", kind: "card" }],
  ["PAN in a sentence", { q: "use 4242424242424242 please" }, { path: "$.q", kind: "card" }],
  ["email", { q: "ship to jane.doe@example.com" }, { path: "$.q", kind: "email" }],
  ["email with plus tag", { contact: { v: "a+b@mail.example" } }, { path: "$.contact.v", kind: "email" }],
  ["US phone with parens", { q: "call (415) 555-2671" }, { path: "$.q", kind: "phone" }],
  ["US phone with dashes", { q: "415-555-2671" }, { path: "$.q", kind: "phone" }],
  ["US phone with dots and +1", { q: "+1 415.555.2671" }, { path: "$.q", kind: "phone" }],
  ["E.164 compact", { q: "+14155552671" }, { path: "$.q", kind: "phone" }],
  ["E.164 UK", { q: "+44 20 7946 0958" }, { path: "$.q", kind: "phone" }],
  ["street St", { q: "123 Main St" }, { path: "$.q", kind: "street_address" }],
  ["street Avenue with unit", { q: "42 Oak Avenue Apt 4" }, { path: "$.q", kind: "street_address" }],
  ["street Blvd, two words", { q: "deliver to 1600 Sunset Park Blvd." }, { path: "$.q", kind: "street_address" }],
  ["street ordinal", { q: "77 W 5th Ave, Suite 2" }, { path: "$.q", kind: "street_address" }],
  ["street lowercase Ln", { q: "9 elm ln" }, { path: "$.q", kind: "street_address" }],
  ["street Way", { q: "500 Harbor Way" }, { path: "$.q", kind: "street_address" }],
  ["key name", { name: "x" }, { path: "$.name", kind: "banned_key" }],
  ["key full_name nested", { a: { b: { full_name: "x" } } }, { path: "$.a.b.full_name", kind: "banned_key" }],
  ["key firstName camelCase", { buyer: { firstName: "x" } }, { path: "$.buyer.firstName", kind: "banned_key" }],
  ["key LAST-NAME", { "LAST-NAME": "x" }, { path: '$["LAST-NAME"]', kind: "banned_key" }],
  ["key address_line1 in array", { items: [{ address_line1: "x" }] }, { path: "$.items[0].address_line1", kind: "banned_key" }],
  ["key shippingAddress", { shippingAddress: {} }, { path: "$.shippingAddress", kind: "banned_key" }],
  ["key street", { street: "x" }, { path: "$.street", kind: "banned_key" }],
  ["key cardNumber", { cardNumber: "x" }, { path: "$.cardNumber", kind: "banned_key" }],
  ["key card_holder", { card_holder: "x" }, { path: "$.card_holder", kind: "banned_key" }],
  ["key pan", { PAN: "x" }, { path: "$.PAN", kind: "banned_key" }],
  ["key cvv", { cvv: 123 }, { path: "$.cvv", kind: "banned_key" }],
  ["key CVC", { CVC: 123 }, { path: "$.CVC", kind: "banned_key" }],
  ["key phone_number", { phone_number: "x" }, { path: "$.phone_number", kind: "banned_key" }],
  ["key Email", { Email: "x" }, { path: "$.Email", kind: "banned_key" }],
  ["identity in a key", { "jane@example.com": true }, { path: '$["jane@example.com"]', kind: "email" }],
  // Unicode and separator forms (review finding 2): each must normalise to a detected card, email or phone.
  ["full-width PAN", { q: "４１１１１１１１１１１１１１１１" }, { path: "$.q", kind: "card" }],
  ["Arabic-Indic PAN", { q: "٤١١١١١١١١١١١١١١١" }, { path: "$.q", kind: "card" }],
  ["Devanagari PAN with spaces", { q: "४१११ १११११ ११११ १११" }, { path: "$.q", kind: "card" }],
  ["PAN with dots", { q: "4111.1111.1111.1111" }, { path: "$.q", kind: "card" }],
  ["PAN with slashes", { q: "4111/1111/1111/1111" }, { path: "$.q", kind: "card" }],
  ["PAN with double spaces", { q: "4111  1111  1111  1111" }, { path: "$.q", kind: "card" }],
  ["PAN with NBSP", { q: "4111\u00a01111\u00a01111\u00a01111" }, { path: "$.q", kind: "card" }],
  ["PAN with narrow NBSP", { q: "4111\u202f1111\u202f1111\u202f1111" }, { path: "$.q", kind: "card" }],
  ["PAN with zero-width spaces", { q: "4111\u200b1111\u200b1111\u200b1111" }, { path: "$.q", kind: "card" }],
  ["PAN with soft hyphens", { q: "4111\u00ad1111\u00ad1111\u00ad1111" }, { path: "$.q", kind: "card" }],
  ["PAN glued to a short prefix", { q: "cc4111111111111111" }, { path: "$.q", kind: "card" }],
  ["PAN split across array items", { must_haves: ["4111", "1111", "1111", "1111"] }, { path: "$.must_haves", kind: "card" }],
  ["PAN split across sibling fields", { a: "4111", b: "1111", c: "1111", d: "1111" }, { path: "$", kind: "card" }],
  ["PAN split into numbers", { parts: [4111, 1111, 1111, 1111] }, { path: "$.parts", kind: "card" }],
  ["Amex split 4-6-5 after a word", { tags: ["red", "3782", "822463", "10005"] }, { path: "$.tags", kind: "card" }],
  ["PAN split, full-width", { must_haves: ["４１１１", "１１１１", "１１１１", "１１１１"] }, { path: "$.must_haves", kind: "card" }],
  ["email with Unicode domain", { q: "jane@exämple.com" }, { path: "$.q", kind: "email" }],
  ["email with Unicode local part", { q: "josé@example.com" }, { path: "$.q", kind: "email" }],
  ["email with full-width at", { q: "jane＠example.com" }, { path: "$.q", kind: "email" }],
  ["email with zero-width space", { q: "jane\u200b@example.com" }, { path: "$.q", kind: "email" }],
  ["full-width US phone", { q: "４１５-５５５-２６７１" }, { path: "$.q", kind: "phone" }],
  ["key buyerName", { buyerName: "x" }, { path: "$.buyerName", kind: "banned_key" }],
  ["key recipient", { recipient: "x" }, { path: "$.recipient", kind: "banned_key" }],
  ["key recipient_name", { recipient_name: "x" }, { path: "$.recipient_name", kind: "banned_key" }],
  ["key surname", { surname: "x" }, { path: "$.surname", kind: "banned_key" }],
  ["key credit_card", { credit_card: "x" }, { path: "$.credit_card", kind: "banned_key" }],
  ["key cvv2", { cvv2: 123 }, { path: "$.cvv2", kind: "banned_key" }],
  ["key addr", { addr: "x" }, { path: "$.addr", kind: "banned_key" }],
  ["key full-width name", { "ｎａｍｅ": "x" }, { path: '$["ｎａｍｅ"]', kind: "banned_key" }],
  ["key with a zero-width space", { "e\u200bmail": "x" }, { path: '$["e\u200bmail"]', kind: "banned_key" }],
  ["key customer_name", { customer_name: "x" }, { path: "$.customer_name", kind: "banned_key" }],
  ["key address_country holding a street", { address_country: "123 Main St" }, { path: "$.address_country", kind: "banned_key" }],
  ["key address_country holding an object", { address_country: { line1: "x" } }, { path: "$.address_country", kind: "banned_key" }],
  ["key address_country lower case", { address_country: "us" }, { path: "$.address_country", kind: "banned_key" }],
  ["key shipping_address_country", { shipping_address_country: "US" }, { path: "$.shipping_address_country", kind: "banned_key" }],
  ["key AddressCountry", { AddressCountry: "US" }, { path: "$.AddressCountry", kind: "banned_key" }],
];

// Product, slug and search content that must pass (false positives would block ordinary searches).
const negatives: [label: string, body: unknown][] = [
  ["slug", { slug: "trail-runner-10" }],
  ["size", { must_have: ["size-10", "size 10.5"] }],
  ["SKU failing Luhn", { sku: "4111111111111112" }],
  ["SKU with letters", { sku: "SKU-4111111111111111-BLK" }],
  ["SKU groups failing Luhn", { sku: "1234 5678 9012 3456" }],
  ["price_cents", { price_cents: 4999 }],
  ["big integer failing Luhn", { offer_id: 1234567890123456 }],
  ["float", { weight_kg: 4111111111111.111 }],
  ["ZIP", { zip: "94110" }],
  ["ZIP as number", { zip: 94110 }],
  ["ZIP+4", { postcode: "94110-1234" }],
  ["postcode_only policy field", { postcode_only: true }],
  ["ISO date", { since: "2026-10-15" }],
  ["ISO timestamp", { at: "2026-10-15T10:30:00.123Z" }],
  ["UUID", { id: "550e8400-e29b-41d4-a716-446655440000" }],
  ["street words in a product title", { title: "Main Street Coffee Mug" }],
  ["quantity before a suffix word", { q: "4 Wheel Drive RC Truck, 2 Pack Way Cool Socks" }],
  ["count abbreviation", { title: "Vitamin D3 Gummies, 60 Ct" }],
  ["ISBN-10", { q: "ISBN 0306406152" }],
  ["UPC-A", { gtin: "036000291452" }],
  ["model number", { q: "Model 1080 v13 running shoe" }],
  ["budget", { budget: { max_cents: 15000, currency: "USD" } }],
  ["dimensions", { q: "desk 120 x 60 cm, 75 cm tall" }],
  ["product keys", { product_name: "x", brand: "y", category: "z", quantity: 2, offer_handle: "oh_123" }],
  ["URL without email", { url: "https://intentai.shop/developers?ref=10" }],
  ["primitives", [true, false, null, 0, -1, 3.14, ""]],
  ["handle", { username: "@runner42" }],
  ["small quantities", { quantities: [1, 2, 3, 4] }],
  ["many small quantities", { quantities: [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7] }],
  ["sizes as strings", { sizes: ["9", "9.5", "10", "10.5", "11"] }],
  ["two-digit split", { parts: ["41", "11", "11", "11", "11", "11", "11", "11"] }],
  ["price list failing Luhn", { prices_cents: [4999, 1999, 2999, 3998] }],
  ["year range", { years: ["2019", "2020", "2021"] }],
  ["dotted version", { q: "firmware 1.2.3.4" }],
  ["price with dot", { q: "under 149.99 dollars" }],
  ["US date with slashes", { q: "deliver by 10/15/2026" }],
  ["SKU with a long glued prefix", { sku: "ABC4111111111111111" }],
  ["SKU with an underscore", { sku: "x_4111111111111111" }],
  ["full-width ZIP", { zip: "９４１１０" }],
  ["full-width date", { since: "２０２６-１０-１５" }],
  ["product and merchant name keys", { product_name: "x", merchant_name: "y", brand_name: "z", category_name: "w", store_name: "v" }],
  ["NBSP in a product title", { title: "4\u00a0Wheel Drive RC Truck" }],
  ["Unicode word without at", { q: "café crème" }],
];

describe("findIdentity positives", () => {
  it("has at least 20 cases", () => {
    expect(positives.length).toBeGreaterThanOrEqual(20);
  });
  it.each(positives)("finds %s", (_label, body, expected) => {
    expect(findIdentity(body)).toContainEqual(expected);
  });
});

describe("findIdentity negatives", () => {
  it("has at least 20 cases", () => {
    expect(negatives.length).toBeGreaterThanOrEqual(20);
  });
  it.each(negatives)("leaves %s clean", (_label, body) => {
    expect(findIdentity(body)).toEqual([]);
  });
});

describe("findIdentity address_country (Shop search_catalog, G5)", () => {
  const call = (catalog: unknown, name = "search_catalog"): unknown => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { catalog } } });
  const PATH = "$.params.arguments.catalog.context.address_country";
  it("lets a two-letter country through at the search_catalog context path", () => {
    expect(findIdentity(call({ query: "mug", context: { address_country: "US", currency: "USD" } }), { mcpEnvelope: true })).toEqual([]);
  });
  it.each([
    ["without the MCP envelope option", call({ context: { address_country: "US" } }), {}, PATH],
    ["in another tool's call", call({ context: { address_country: "US" } }, "create_checkout"), { mcpEnvelope: true }, PATH],
    ["lower case", call({ context: { address_country: "us" } }), { mcpEnvelope: true }, PATH],
    ["a postcode", call({ context: { address_country: "94110" } }), { mcpEnvelope: true }, PATH],
    ["at another path", call({ filters: { address_country: "US" } }), { mcpEnvelope: true }, "$.params.arguments.catalog.filters.address_country"],
    ["at the top of a plain body", { address_country: "US" }, {}, "$.address_country"],
    ["nested in an order", { order: { address_country: "US" } }, {}, "$.order.address_country"],
    ["two letters at a time in an array", { x: [{ address_country: "JO" }, { address_country: "HN" }] }, {}, "$.x[0].address_country"],
  ])("still bans it %s", (_label, body, options, path) => {
    expect(findIdentity(body, options)).toContainEqual({ path, kind: "banned_key" });
  });
});

describe("findIdentity reporting", () => {
  it("reports every finding in one body, each with its path", () => {
    const body = {
      query: "trail shoes",
      zip: "94110",
      buyer: { email: "jane@example.com", notes: ["leave at 123 Main St", "call 415-555-2671"] },
    };
    const kinds = (path: string): FindingKind[] =>
      findIdentity(body)
        .filter((f) => f.path === path)
        .map((f) => f.kind);
    expect(kinds("$.buyer.email")).toEqual(["banned_key", "email"]);
    expect(kinds("$.buyer.notes[0]")).toEqual(["street_address"]);
    expect(kinds("$.buyer.notes[1]")).toEqual(["phone"]);
    expect(findIdentity(body)).toHaveLength(4);
  });

  it("scans a bare top-level string at $", () => {
    expect(findIdentity("4111-1111-1111-1111")).toEqual([{ path: "$", kind: "card" }]);
  });
});

describe("credentials (ADR-0014, widened by ADR-0017)", () => {
  it("treats a key whose last word is token or bearer as secret, and keeps hints and counts readable", () => {
    for (const key of ["token", "session_token", "authToken", "Shop-Access-Token", "bearer", "x_bearer", "refresh_token"]) expect(isSecretKey(key)).toBe(true);
    for (const key of ["token_type_hint", "token_type", "tokens", "idempotency-key", "bearer_type", "code"]) expect(isSecretKey(key)).toBe(false);
  });

  it("reads a form body by its content-type and writes it back the same way", () => {
    const headers: [string, string][] = [["Content-Type", "application/x-www-form-urlencoded; charset=utf-8"]];
    const bytes = Buffer.from("token=a%2Bb&client_id=gw", "utf8");
    expect(bodyValue(headers, bytes)).toEqual({ token: "a+b", client_id: "gw" });
    expect(bodyText(bodyValue(headers, bytes), true)).toBe("token=a%2Bb&client_id=gw");
    expect(bodyValue([["content-type", "application/json"]], Buffer.from('{"a":1}'))).toEqual({ a: 1 });
    expect(bodyValue(headers, new Uint8Array(0))).toBeNull();
  });
});

describe("a canonical UUID is never a card (an idempotency key)", () => {
  // Their leading all-digit groups join into a Luhn-valid 16-digit run: in free text they read as a card.
  const tripping = [
    "52738107-9017-4321-abcd-ef0123456789",
    "52738115-9017-4321-ABCD-EF0123456789",
    "87654321-1002-4000-8000-0000000000ab",
    "87654321-1010-4000-8000-0000000000ab",
  ];

  it.each(tripping)("%s alone is clean, as a value, a key and in a list", (uuid) => {
    expect(findIdentity(`ref ${uuid}`).map((f) => f.kind)).toContain("card");
    expect(findIdentity(uuid)).toEqual([]);
    expect(findIdentity({ meta: { "idempotency-key": uuid } })).toEqual([]);
    expect(findIdentity({ [uuid]: 1 })).toEqual([]);
    expect(findIdentity([uuid, uuid])).toEqual([]);
  });

  it("still finds a card that is not a whole canonical UUID", () => {
    expect(findIdentity("4111-1111-1111-1111")).toEqual([{ path: "$", kind: "card" }]);
    expect(findIdentity({ q: "pay with 4111-1111-1111-1111 please" })).toEqual([{ path: "$.q", kind: "card" }]);
    // UUID-like but not canonical: a PAN with a UUID-shaped tail, an extra group, or a missing group.
    expect(findIdentity(`${tripping[0] ?? ""}-1`).map((f) => f.kind)).toContain("card");
    expect(findIdentity("52738107-9017-4321-abcd").map((f) => f.kind)).toContain("card");
    expect(findIdentity({ parts: ["4111", "1111", "1111", "1111"] })).toEqual([{ path: "$.parts", kind: "card" }]);
  });

  it("never finds a card in 20 000 random UUIDs", () => {
    for (let i = 0; i < 20_000; i++) {
      const uuid = randomUUID();
      expect(findIdentity(uuid), uuid).toEqual([]);
    }
  });
});

describe("credentials inside JSON text and the scan depth (ADR-0014)", () => {
  const MARK = `[redacted sha256:${"a".repeat(64)}]`;
  it("finds a secret key in JSON text, in JSON text inside it and in an array; a marker or no secret key is not one", () => {
    expect(holdsNestedSecret('{"access_token":"t"}')).toBe(true);
    expect(holdsNestedSecret(' [{"auth":{"sessionToken":"t"}}]')).toBe(true);
    expect(holdsNestedSecret(JSON.stringify({ inner: JSON.stringify({ refresh_token: "t" }) }))).toBe(true);
    expect(holdsNestedSecret(JSON.stringify({ token: MARK }))).toBe(false);
    expect(holdsNestedSecret('{"note":"Bearer x"}')).toBe(false);
    expect(holdsNestedSecret("not json {")).toBe(false);
    expect(nestedSecrets({ a: [{ s: '{"password":"p"}' }], b: "plain" })).toEqual(["body.a[0].s"]);
  });

  it("stops at SCAN_DEPTH: deeper JSON text counts as holding a credential, and findIdentity reports too_deep without overflowing", () => {
    const deepText = `${"[".repeat(SCAN_DEPTH + 5)}${"]".repeat(SCAN_DEPTH + 5)}`;
    expect(holdsNestedSecret(deepText)).toBe(true);
    let deep: unknown = "x";
    for (let i = 0; i < 50_000; i += 1) deep = [deep];
    const findings = findIdentity({ q: deep });
    expect(findings.map((f) => f.kind)).toEqual(["too_deep"]);
    expect(findIdentity({ q: [[["lamp"]]] })).toEqual([]);
  });
});

describe("a Shopify order gid at an order path is not a card (ADR-0019)", () => {
  // Fixed values: a 14-digit Shopify order number and a test PAN, each Luhn-valid, so either reads as a card in a gid.
  const ORDER = "gid://shopify/Order/12345678901237";
  const PAN_GID = "gid://shopify/Order/4111111111111111";
  const report = { orderRefAt: ORDER_REF_AT.outcomeReport };

  it("the whole gid, at exactly a named path, is clean; without the option it is a card", () => {
    expect(findIdentity({ order_ref: ORDER })).toEqual([{ path: "$.order_ref", kind: "card" }]);
    expect(findIdentity({ order_ref: ORDER }, report)).toEqual([]);
    expect(findIdentity({ order_ref: PAN_GID }, report)).toEqual([]);
    expect(findIdentity(ORDER, { orderRefAt: ORDER_REF_AT.projection })).toEqual([]);
    expect(findIdentity({ outcome: { order_ref: ORDER, reported: { order_ref: ORDER } } }, { orderRefAt: ORDER_REF_AT.statement })).toEqual([]);
    expect(findIdentity({ outcome: { order_ref: ORDER } }, { orderRefAt: ORDER_REF_AT.observation })).toEqual([]);
    expect(SHOPIFY_ORDER_GID.test(ORDER)).toBe(true);
  });

  it("attack: a card in the gid shape at any other path is still a card", () => {
    expect(findIdentity({ note: PAN_GID }, report)).toEqual([{ path: "$.note", kind: "card" }]);
    expect(findIdentity({ items: [{ order_ref: PAN_GID }] }, report)).toEqual([{ path: "$.items[0].order_ref", kind: "card" }]);
    expect(findIdentity({ outcome: { order_ref: PAN_GID } }, report)).toEqual([{ path: "$.outcome.order_ref", kind: "card" }]);
    expect(findIdentity({ order_ref: PAN_GID }, { orderRefAt: ORDER_REF_AT.statement })).toEqual([{ path: "$.order_ref", kind: "card" }]);
    // As a key, never exempt.
    expect(findIdentity({ [PAN_GID]: 1 }, report)).toEqual([{ path: `$[${JSON.stringify(PAN_GID)}]`, kind: "card" }]);
  });

  it("attack: the same digits at the order path without the exact gid shape are a card", () => {
    for (const value of [
      "4111111111111111",
      "12345678901237",
      `${PAN_GID} x`,
      `x ${PAN_GID}`,
      `${PAN_GID}\n`,
      "gid://shopify/Order/4111 1111 1111 1111",
      "gid://shopify/Checkout/4111111111111111",
      "GID://shopify/Order/4111111111111111",
      "gid://shopify/Order/４１１１１１１１１１１１１１１１",
    ]) {
      expect(findIdentity({ order_ref: value }, report), value).toEqual([{ path: "$.order_ref", kind: "card" }]);
    }
    expect(findIdentity({ order_ref: 4111111111111111 }, report)).toEqual([{ path: "$.order_ref", kind: "card" }]);
  });

  it("attack: a card split across fields beside an exempt gid is still caught", () => {
    expect(findIdentity({ order_ref: ORDER, a: "4111", b: "1111", c: "1111", d: "1111" }, report)).toEqual([{ path: "$", kind: "card" }]);
    expect(findIdentity({ parts: ["4111", "1111", "1111", "1111"], order_ref: ORDER }, report)).toEqual([{ path: "$.parts", kind: "card" }]);
  });

  it("only the card check is skipped: every other finding at the path stays", () => {
    expect(findIdentity({ order_ref: "jane@example.com" }, report)).toEqual([{ path: "$.order_ref", kind: "email" }]);
  });
});
