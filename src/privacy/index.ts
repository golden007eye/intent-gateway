// Buyer-identity detection (invariant 3: no buyer identity in the gateway).
//
// findIdentity walks a JSON-like value and reports each place that looks like buyer identity. It runs only on
// OUTBOUND bodies, before the disclosure log append, so it errs on the side of reporting. Heuristics:
// - normalisation: every string and key is scanned after NFKC (full-width "４" and "＠" become "4" and "@"),
//   with format characters (\p{Cf}, e.g. U+200B) removed, every decimal digit (\p{Nd}, e.g. Arabic-Indic) mapped
//   to its ASCII digit, and every space separator (\p{Zs}, e.g. NBSP) turned into a plain space.
// - card: a run of 13–19 digits, alone or in groups split by one to three of space, ".", "/" or "-", that passes
//   the Luhn check. The run may be glued to a prefix of one or two letters ("cc4111…"), but not to a longer
//   word, a digit, "_" or "-" (UUIDs, SKUs like "SKU-4111…-BLK" or "ABC4111…"), and not followed by a letter or
//   digit. Integer numbers are checked as digits.
// - split card: in one array or object, consecutive leaves that are each only digits (a string of digit groups,
//   or a non-negative integer) with at least 3 digits each; any slice of two or more of them whose concatenated
//   digits are 13–19 long and pass Luhn is reported at the container's path (["4111","1111","1111","1111"]).
//   The 3-digit floor keeps lists of small quantities ([1,2,3,4]) clean.
// - email: local@domain.tld, with Unicode letters allowed in the local part and the domain.
// - phone: E.164 ("+" then 8–15 digits, separators allowed), or a US number written with separators
//   ("(415) 555-2671", "415.555.2671", "+1 415 555 2671"); area code and exchange start with 2–9. A bare
//   10-digit run is not a phone (ISBNs and SKUs look like that).
// - street_address: a house number, one to four street-name words, then a street suffix (St, Ave, Rd, Blvd, Ln,
//   Dr, Ct, Way…). "Main Street Coffee Mug" has no house number, so it is clean; a number followed by a quantity
//   word ("4 Wheel Drive", "2 Pack Way") is a quantity, so it is clean too.
// - banned_key: an object key naming identity, compared case-insensitively after splitting into words on "_",
//   "-", spaces and camelCase. Banned: the key "pan", any key starting with "card", and any key containing one
//   of the words name, surname, recipient, address, addr, street, email, phone, card, cvv, cvv2, cvc
//   ("buyerName", "recipient_name", "credit_card", "shipping_address"). The word "name" is allowed only in the
//   product and merchant keys of NAME_ALLOWED (product_name, merchant_name, brand_name, category_name,
//   store_name), which name a thing for sale or its seller, never the buyer.
// A 5-digit ZIP or ZIP+4 alone is not identity: the policy may share a postcode.
//
// Credentials (credentials.ts) are the other thing a logged request must never hold in clear: the disclosure core
// digests them before the log append, and `intent verify` refuses an unredacted one (ADR-0014).
export {
  formatPath,
  isCredentialHeader,
  isSecretKey,
  markerDigest,
  parsePath,
  type PathSegment,
  redactionHeld,
  redactionMarker,
  SECRET_KEYS,
  secretDigest,
  secretQueryKeys,
  unredactedSecrets,
  valueAt,
} from "./credentials.ts";

export type FindingKind = "card" | "email" | "phone" | "street_address" | "banned_key";

export interface Finding {
  /** Where the identity sits, as a JSONPath: `$`, `$.buyer.email`, `$.items[0]`, `$["first name"]`. */
  path: string;
  kind: FindingKind;
}

export interface IdentityOptions {
  /**
   * Exempt an MCP tool name: drops only the banned_key finding at exactly `$.params.name`, and only when the
   * top-level `method` is `tools/call` and that name matches MCP_TOOL_NAME. Its value is still scanned. For bodies
   * to MCP destinations (a wallet), never Intent Cloud.
   */
  mcpToolName?: boolean;
}

/** An MCP tool name the identity check lets through under `$.params.name` (IdentityOptions.mcpToolName). */
export const MCP_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function findIdentity(value: unknown, options: IdentityOptions = {}): Finding[] {
  const findings: Finding[] = [];
  walk(value, "$", findings);
  if (options.mcpToolName !== true || !isToolCall(value)) return findings;
  return findings.filter((f) => !(f.kind === "banned_key" && f.path === "$.params.name"));
}

function isToolCall(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { method, params } = value as { method?: unknown; params?: unknown };
  if (method !== "tools/call" || typeof params !== "object" || params === null || Array.isArray(params)) return false;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && MCP_TOOL_NAME.test(name);
}

function walk(value: unknown, path: string, out: Finding[]): void {
  if (typeof value === "string") {
    for (const kind of scanText(normalize(value))) out.push({ path, kind });
  } else if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
    if (isCardDigits(value.toString())) out.push({ path, kind: "card" });
  } else if (Array.isArray(value)) {
    const items: unknown[] = value;
    items.forEach((item, i) => {
      walk(item, `${path}[${String(i)}]`, out);
    });
    if (hasSplitCard(items)) out.push({ path, kind: "card" });
  } else if (typeof value === "object" && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);
    for (const [key, item] of entries) {
      const keyPath = path + (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
      const normalKey = normalize(key);
      if (isBannedKey(normalKey)) out.push({ path: keyPath, kind: "banned_key" });
      for (const kind of scanText(normalKey)) out.push({ path: keyPath, kind });
      walk(item, keyPath, out);
    }
    if (hasSplitCard(entries.map(([, item]) => item))) out.push({ path, kind: "card" });
  }
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Nd}/gu, asciiDigit)
    .replace(/\p{Zs}/gu, " ");
}

// Unicode encodes every set of decimal digits as ten consecutive code points, 0 to 9, so a digit's value is the
// count of decimal digits just before it, modulo 10.
function asciiDigit(digit: string): string {
  const code = digit.codePointAt(0) ?? 0;
  let before = 0;
  while (code - before - 1 >= 0 && /\p{Nd}/u.test(String.fromCodePoint(code - before - 1))) before++;
  return String(before % 10);
}

function scanText(text: string): FindingKind[] {
  const kinds: FindingKind[] = [];
  if (hasCard(text)) kinds.push("card");
  if (EMAIL.test(text)) kinds.push("email");
  if (E164.test(text) || US_PHONE.test(text)) kinds.push("phone");
  if (STREET.test(text)) kinds.push("street_address");
  return kinds;
}

const EMAIL = /[\p{L}\p{M}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*\.\p{L}{2,}/u;
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

const SEPARATOR = String.raw`[\s./-]{1,3}`;
// A maximal run of digit groups joined by separators. It starts at a word start, or right after a one- or
// two-letter prefix that starts a word ("cc4111…"); it never follows "_" or "-", and never touches a letter or
// digit at its end.
const DIGIT_RUN = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}_-])|(?<=(?<![\p{L}\p{N}_-])\p{L}{1,2}))\d+(?:${SEPARATOR}\d+)*(?![\p{L}\p{N}_])`,
  "gu",
);
const GROUPS_ONLY = new RegExp(String.raw`^\s*\d+(?:${SEPARATOR}\d+)*\s*$`);
const SEPARATORS = new RegExp(SEPARATOR);

function hasCard(text: string): boolean {
  for (const [run] of text.matchAll(DIGIT_RUN)) {
    // Any contiguous slice of groups can be the card ("4111 1111 1111 1111 12 25" ends with an expiry date).
    if (hasCardSlice(run.split(SEPARATORS), 1)) return true;
  }
  return false;
}

// True when some slice of at least `minParts` consecutive parts concatenates to a Luhn-valid 13–19 digit run.
function hasCardSlice(parts: string[], minParts: number): boolean {
  for (let start = 0; start < parts.length; start++) {
    let digits = "";
    for (let end = start; end < parts.length; end++) {
      digits += parts[end] ?? "";
      if (digits.length > 19) break;
      if (end - start + 1 >= minParts && isCardDigits(digits)) return true;
    }
  }
  return false;
}

// Split cards: consecutive digit-only leaves of one container (each 3+ digits), checked as one digit run.
function hasSplitCard(items: unknown[]): boolean {
  let parts: string[] = [];
  for (const item of items) {
    const digits = leafDigits(item);
    if (digits !== undefined && digits.length >= 3) {
      parts.push(digits);
      continue;
    }
    if (hasCardSlice(parts, 2)) return true;
    parts = [];
  }
  return hasCardSlice(parts, 2);
}

function leafDigits(item: unknown): string | undefined {
  if (typeof item === "bigint") return item >= 0n ? item.toString() : undefined;
  if (typeof item === "number") return Number.isSafeInteger(item) && item >= 0 ? item.toString() : undefined;
  if (typeof item !== "string") return undefined;
  const text = normalize(item);
  return GROUPS_ONLY.test(text) ? text.replace(/\D/g, "") : undefined;
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

const BANNED_WORDS = new Set([
  "name", "surname", "recipient", "address", "addr", "street", "email", "phone", "card", "cvv", "cvv2", "cvc",
]);
// Keys where the word "name" names a product or its seller, never the buyer.
const NAME_ALLOWED = new Set(["product_name", "merchant_name", "brand_name", "category_name", "store_name"]);

function isBannedKey(key: string): boolean {
  const words = key
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((w) => w !== "");
  if (words.length === 0) return false;
  const joined = words.join("_");
  if (joined === "pan" || joined.startsWith("card")) return true;
  return words.some((w) => BANNED_WORDS.has(w) && !(w === "name" && NAME_ALLOWED.has(joined)));
}
