import { describe, expect, it } from "vitest";
import { findIdentity, type Finding, type FindingKind } from "./index.ts";

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
