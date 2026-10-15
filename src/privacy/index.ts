// Buyer-identity detection (invariant 3: no buyer identity in the gateway).
//
// findIdentity walks a JSON-like value and reports each place that looks like buyer identity. It runs only on
// OUTBOUND bodies, before the disclosure log append, so it errs on the side of reporting. Heuristics:
// - card: a run of 13–19 digits, alone or in groups split by single spaces or dashes, that passes the Luhn check.
//   Digit runs glued to letters (UUIDs, SKUs like "AB1234…") are not cards. Integer numbers are checked as digits.
// - email: local@domain.tld.
// - phone: E.164 ("+" then 8–15 digits, separators allowed), or a US number written with separators
//   ("(415) 555-2671", "415.555.2671", "+1 415 555 2671"); area code and exchange start with 2–9. A bare
//   10-digit run is not a phone (ISBNs and SKUs look like that).
// - street_address: a house number, one to four street-name words, then a street suffix (St, Ave, Rd, Blvd, Ln,
//   Dr, Ct, Way…). "Main Street Coffee Mug" has no house number, so it is clean; a number followed by a quantity
//   word ("4 Wheel Drive", "2 Pack Way") is a quantity, so it is clean too.
// - banned_key: an object key naming identity (name, full_name, first_name, last_name, address*, street, card*,
//   pan, cvv, cvc, phone, email), compared case-insensitively after splitting on "_", "-", spaces and camelCase.
//   A key containing the word address, street, email, phone, cvv or cvc is banned too ("shipping_address").
// A 5-digit ZIP or ZIP+4 alone is not identity: the policy may share a postcode.

export type FindingKind = "card" | "email" | "phone" | "street_address" | "banned_key";

export interface Finding {
  /** Where the identity sits, as a JSONPath: `$`, `$.buyer.email`, `$.items[0]`, `$["first name"]`. */
  path: string;
  kind: FindingKind;
}

export function findIdentity(value: unknown): Finding[] {
  const findings: Finding[] = [];
  walk(value, "$", findings);
  return findings;
}

function walk(value: unknown, path: string, out: Finding[]): void {
  if (typeof value === "string") {
    for (const kind of scanText(value)) out.push({ path, kind });
  } else if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
    if (isCardDigits(value.toString())) out.push({ path, kind: "card" });
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walk(item, `${path}[${String(i)}]`, out);
    });
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const keyPath = path + (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
      if (isBannedKey(key)) out.push({ path: keyPath, kind: "banned_key" });
      for (const kind of scanText(key)) out.push({ path: keyPath, kind });
      walk(item, keyPath, out);
    }
  }
}

function scanText(text: string): FindingKind[] {
  const kinds: FindingKind[] = [];
  if (hasCard(text)) kinds.push("card");
  if (EMAIL.test(text)) kinds.push("email");
  if (E164.test(text) || US_PHONE.test(text)) kinds.push("phone");
  if (STREET.test(text)) kinds.push("street_address");
  return kinds;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const E164 = /(?<![\w+])\+[1-9](?:[ .()-]{0,2}\d){7,14}(?!\d)/;
const US_PHONE = /(?<![\w+])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\) ?|[2-9]\d{2}[ .-])[2-9]\d{2}[ .-]\d{4}(?![\w])/;
const SUFFIXES = [
  "St", "Street", "Ave", "Av", "Avenue", "Rd", "Road", "Blvd", "Boulevard", "Ln", "Lane", "Dr", "Drive",
  "Ct", "Court", "Way", "Pl", "Place", "Ter", "Terrace", "Pkwy", "Parkway", "Hwy", "Highway", "Cir", "Circle",
];
const STREET_WORD = String.raw`(?:[A-Za-z][A-Za-z'.-]*|\d+(?:st|nd|rd|th))`;
// A number followed by a quantity word ("4 Wheel Drive", "2 Pack Way") is a quantity, not a house number.
const QUANTITY_WORDS = ["wheel", "pack", "piece", "pc", "pcs", "count", "ct", "inch", "in", "ft", "oz", "lb", "x"];
const STREET = new RegExp(
  String.raw`(?<![\w-])\d{1,6}[A-Za-z]?\s+(?!(?:${QUANTITY_WORDS.join("|")})\b)(?:${STREET_WORD}\s+){1,4}(?:${SUFFIXES.join("|")})\b`,
  "i",
);

// A maximal run of digit groups joined by single spaces or dashes, not touching a letter, digit or underscore.
const DIGIT_RUN = /(?<![\w-])\d+(?:[ -]\d+)*(?![\w])/g;

function hasCard(text: string): boolean {
  for (const [run] of text.matchAll(DIGIT_RUN)) {
    const groups = run.split(/[ -]/);
    // Any contiguous slice of groups can be the card ("4111 1111 1111 1111 12 25" ends with an expiry date).
    for (let start = 0; start < groups.length; start++) {
      let digits = "";
      for (const group of groups.slice(start)) {
        digits += group;
        if (digits.length > 19) break;
        if (isCardDigits(digits)) return true;
      }
    }
  }
  return false;
}

function isCardDigits(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const BANNED_EXACT = new Set(["name", "full_name", "first_name", "last_name", "pan"]);
const BANNED_WORDS = new Set(["address", "street", "email", "phone", "cvv", "cvc"]);

function isBannedKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((w) => w !== "");
  if (words.length === 0) return false;
  const joined = words.join("_");
  return BANNED_EXACT.has(joined) || joined.startsWith("card") || words.some((w) => BANNED_WORDS.has(w));
}
