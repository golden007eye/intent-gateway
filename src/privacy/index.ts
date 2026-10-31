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
//   digit. Integer numbers are checked as digits. A string whose whole value is a canonical UUID (8-4-4-4-12 ASCII
//   hex) is never a card: its all-digit groups can form a Luhn-valid run by chance (an idempotency key). Nor is a
//   Shopify order reference (SHOPIFY_ORDER_GID, the whole ASCII value), but only at a path the caller names from
//   ORDER_REF_AT (IdentityOptions.orderRefAt): about one 14-digit order number in ten passes Luhn (ADR-0019).
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
// - free text (IdentityOptions.freeText, freetext.ts), on the agent's tool input only: a whole postcode of a ship-to
//   country (`postcode`), a street with no house number after a delivery phrase, and a house-number range
//   ("12-14 Baker Street") (`street_address`), in each value and from a delivery phrase ending one value into the next
//   (reported at `$`); a soft hyphen between digits counts as a hyphen there. Never run
//   on what a destination returned or by `intent verify`, so merchant text ("AMD Radeon RX 7900 XT") cannot trip them.
// - banned_key: an object key naming identity, compared case-insensitively after splitting into words on "_",
//   "-", spaces and camelCase. Banned: the key "pan", any key starting with "card", and any key containing one
//   of the words name, surname, recipient, address, addr, street, email, phone, card, cvv, cvv2, cvc
//   ("buyerName", "recipient_name", "credit_card", "shipping_address"). The word "name" is allowed only in the
//   product and merchant keys of NAME_ALLOWED (product_name, merchant_name, brand_name, category_name,
//   store_name), which name a thing for sale or its seller, never the buyer. The key "address_country" is allowed
//   at one path only, `$.params.arguments.catalog.context.address_country` of an MCP `search_catalog` call
//   (IdentityOptions.mcpEnvelope, Shop's search context, G5), and only while its value is a two-letter upper-case
//   country code: a country is no more than the policy already shares. Anywhere else, or with any other value, it
//   is still a banned key, so the key cannot carry text two letters at a time.
// A bare 4- or 5-digit number (a 5-digit ZIP among them) is not identity: the policy may share a ZIP, and products have
// numbers. A coarse postcode alone ("SW1A", "K1A") is what the policy shares.
//
// Credentials (credentials.ts) are the other thing a logged request must never hold in clear: the disclosure core
// digests them before the log append, and `intent verify` refuses an unredacted one (ADR-0014).
export {
  bodyText,
  bodyValue,
  CLOUD_SECRET_PATHS,
  cloudRedactionsAllowed,
  FORM_CONTENT_TYPE,
  formatPath,
  holdsNestedSecret,
  isFormBody,
  isCredentialHeader,
  isSecretKey,
  markerDigest,
  nestedSecrets,
  parsePath,
  type PathSegment,
  redactionHeld,
  redactionMarker,
  SCAN_DEPTH,
  SECRET_KEYS,
  secretDigest,
  secretQueryKeys,
  unredactedSecrets,
  valueAt,
} from "./credentials.ts";
import { SCAN_DEPTH } from "./credentials.ts";
import { acrossFields, freeTextFindings } from "./freetext.ts";
import { QUANTITY_WORDS, STREET_WORD, SUFFIXES } from "./street.ts";

/** `too_deep`: a value nested deeper than SCAN_DEPTH, not walked (so it cannot exhaust the stack) and so not cleared. */
export type FindingKind = "card" | "email" | "phone" | "street_address" | "postcode" | "banned_key" | "too_deep";

export interface Finding {
  /** Where the identity sits, as a JSONPath: `$`, `$.buyer.email`, `$.items[0]`, `$["first name"]`. */
  path: string;
  kind: FindingKind;
}

export interface IdentityOptions {
  /**
   * Exempt the two names an MCP request envelope carries, for bodies to MCP destinations (a wallet), never Intent
   * Cloud. Each drops only the banned_key finding at exactly its path; its value is still scanned:
   * - the tool name at `$.params.name`, when the top-level `method` is `tools/call` and the name matches MCP_TOOL_NAME;
   * - the client's own name at `$.params._meta["io.modelcontextprotocol/clientInfo"].name` (MCP 2026-07-28 carries
   *   it on every request), when the top-level `jsonrpc` is "2.0" and the name is exactly MCP_CLIENT_NAME.
   */
  mcpEnvelope?: boolean;
  /**
   * JSONPaths (findIdentity's own format, from ORDER_REF_AT) where an order reference lives in this value. A string at
   * exactly one of them whose whole raw value matches SHOPIFY_ORDER_GID is not scanned for a card; every other check
   * still runs on it, and any other value at that path (a bare digit string, a number, a gid with extra text) and every
   * other path are scanned as usual. A split card across neighbouring fields is still found: a gid is never a digit leaf.
   */
  orderRefAt?: readonly string[];
  /**
   * The value is what the agent typed into a tool (the gateway's input screen, and `intent log` reading a search sent to
   * Intent Cloud): the free-text rules (freetext.ts) run too. Never for what came back from a destination (observations,
   * Shop's results, statements) or for `intent verify`: merchant text is not the agent's free text.
   */
  freeText?: boolean;
  /**
   * With freeText, JSONPaths where a whole postcode is expected (the tool's own `postcode` field, TOOL_POSTCODE_AT): the
   * postcode rule does not run on the string at exactly one of them; every other check does, and every other path gets all.
   */
  postcodeAt?: readonly string[];
}

/** The postcode field of the gateway's own tool input (find_offers), coarsened by the gateway before any send. */
export const TOOL_POSTCODE_AT: readonly string[] = ["$.postcode"];

/**
 * A Shopify order reference, as the whole string value: `gid://shopify/Order/` and 1 to 20 ASCII digits (ADR-0019).
 * About one 14-digit order number in ten passes Luhn, so the card check would read the gid as a card number.
 */
export const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[0-9]{1,20}$/;

/**
 * The exact paths where an order reference lives, by what is scanned; the one exemption the projection, the outbound
 * disclosure scan, the observation and statement checks, `intent verify` and `--evidence` share (IdentityOptions.orderRefAt).
 */
export const ORDER_REF_AT = {
  /** The Shop checkout projection's scan of the completed order's id, a lone string. */
  projection: ["$"],
  /** An outcome report body (endpoint reportOutcome, to Intent Cloud), as sent and as its disclosure entry logs it. */
  outcomeReport: ["$.order_ref"],
  /** An `observed` entry: the outcome summary a getApproval answer carried. */
  observation: ["$.outcome.order_ref"],
  /** Intent Cloud's signed outcome statement: the order it states and the one the gateway reported. */
  statement: ["$.outcome.order_ref", "$.outcome.reported.order_ref"],
} as const satisfies Record<string, readonly string[]>;

/**
 * The order-reference paths of a body sent to `endpoint`: ORDER_REF_AT.outcomeReport for an outcome report to Intent
 * Cloud, none for any other request. The disclosure core, `intent verify --evidence` and the activity view all ask here.
 */
export function sentOrderRefAt(endpoint: unknown, toIntentCloud: boolean): readonly string[] {
  return toIntentCloud && endpoint === "reportOutcome" ? ORDER_REF_AT.outcomeReport : [];
}

/** An MCP tool name the identity check lets through under `$.params.name` (IdentityOptions.mcpEnvelope). */
export const MCP_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The gateway's own MCP client name, the only one let through under a request's clientInfo (IdentityOptions.mcpEnvelope). */
export const MCP_CLIENT_NAME = "intent-gateway";
const CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const CLIENT_NAME_PATH = `$.params._meta[${JSON.stringify(CLIENT_INFO)}].name`;

export function findIdentity(value: unknown, options: IdentityOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const freeText = options.freeText === true;
  const texts: string[] = [];
  walk(value, "$", findings, { orderRefAt: new Set(options.orderRefAt ?? []), freeText, postcodeAt: new Set(freeText ? (options.postcodeAt ?? []) : []), texts });
  // A delivery phrase ending one field, and a street or postcode starting the next ("lamp, deliver to", then "Evergreen Terrace").
  for (const kind of acrossFields(texts)) if (!findings.some((f) => f.kind === kind)) findings.push({ path: "$", kind });
  if (options.mcpEnvelope !== true) return findings;
  const toolName = isToolCall(value);
  const clientName = isClientNamed(value);
  const country = isCatalogCountry(value);
  return findings.filter(
    (f) =>
      !(
        f.kind === "banned_key" &&
        ((toolName && f.path === "$.params.name") || (clientName && f.path === CLIENT_NAME_PATH) || (country && f.path === CATALOG_COUNTRY_PATH))
      ),
  );
}

function isClientNamed(value: unknown): boolean {
  const top = record(value);
  if (top?.jsonrpc !== "2.0") return false;
  const name = record(record(record(top.params)?._meta)?.[CLIENT_INFO])?.name;
  return name === MCP_CLIENT_NAME;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isToolCall(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { method, params } = value as { method?: unknown; params?: unknown };
  if (method !== "tools/call" || typeof params !== "object" || params === null || Array.isArray(params)) return false;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && MCP_TOOL_NAME.test(name);
}

interface Exempt {
  readonly orderRefAt: ReadonlySet<string>;
  readonly freeText: boolean;
  readonly postcodeAt: ReadonlySet<string>;
  /** With freeText, every string value outside postcodeAt, in walk order, for the joined screen. */
  readonly texts: string[];
}

function walk(value: unknown, path: string, out: Finding[], exempt: Exempt, depth = 0): void {
  if (depth > SCAN_DEPTH && typeof value === "object" && value !== null) {
    out.push({ path, kind: "too_deep" });
  } else if (typeof value === "string") {
    const notCard = isUuid(value) || (exempt.orderRefAt.has(path) && SHOPIFY_ORDER_GID.test(value));
    const isPostcode = exempt.postcodeAt.has(path);
    for (const kind of scanText(value, notCard, exempt.freeText, isPostcode)) out.push({ path, kind });
    if (exempt.freeText && !isPostcode) exempt.texts.push(freeTextNormal(value));
  } else if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
    if (isCardDigits(value.toString())) out.push({ path, kind: "card" });
  } else if (Array.isArray(value)) {
    const items: unknown[] = value;
    items.forEach((item, i) => {
      walk(item, `${path}[${String(i)}]`, out, exempt, depth + 1);
    });
    if (hasSplitCard(items)) out.push({ path, kind: "card" });
  } else if (typeof value === "object" && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);
    for (const [key, item] of entries) {
      const keyPath = path + (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
      const normalKey = normalize(key);
      if (isBannedKey(normalKey)) out.push({ path: keyPath, kind: "banned_key" });
      for (const kind of scanText(key, isUuid(key), exempt.freeText)) out.push({ path: keyPath, kind });
      walk(item, keyPath, out, exempt, depth + 1);
    }
    if (hasSplitCard(entries.map(([, item]) => item))) out.push({ path, kind: "card" });
  }
}

/** As `normalize`, but a soft hyphen (U+00AD, a format character) between digits is a hyphen: "94107\u00AD1234" is a ZIP+4. */
function freeTextNormal(text: string): string {
  return normalize(text.replace(/(?<=\p{Nd})\u00AD+(?=\p{Nd})/gu, "-"));
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

// A whole value in canonical UUID form (8-4-4-4-12 ASCII hex): an idempotency key or another id. Its all-digit groups
// can join into a Luhn-valid 13-19 digit run by chance, so it is never read as a card; every other check still runs.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(raw: string): boolean {
  return UUID.test(raw);
}

/**
 * `notCard`: the raw value is a canonical UUID or an exempt order gid, so it is not scanned for a card. `freeText`: the
 * value is the agent's tool input (IdentityOptions.freeText), so the free-text rules run too; `isPostcode`: it sits in
 * the postcode field (IdentityOptions.postcodeAt), so it is not scanned for a whole postcode.
 */
function scanText(raw: string, notCard: boolean, freeText = false, isPostcode = false): FindingKind[] {
  const text = normalize(raw);
  const kinds: FindingKind[] = [];
  if (!notCard && hasCard(text)) kinds.push("card");
  if (EMAIL.test(text)) kinds.push("email");
  if (E164.test(text) || US_PHONE.test(text)) kinds.push("phone");
  if (STREET.test(text)) kinds.push("street_address");
  if (freeText) for (const kind of freeTextFindings(freeTextNormal(raw), isPostcode)) if (!kinds.includes(kind)) kinds.push(kind);
  return kinds;
}

const EMAIL = /[\p{L}\p{M}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*\.\p{L}{2,}/u;
const E164 = /(?<![\w+])\+[1-9](?:[ .()-]{0,2}\d){7,14}(?!\d)/;
const US_PHONE = /(?<![\w+])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\) ?|[2-9]\d{2}[ .-])[2-9]\d{2}[ .-]\d{4}(?![\w])/;
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
  if (typeof item !== "string" || isUuid(item)) return undefined;
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

const CATALOG_COUNTRY_PATH = "$.params.arguments.catalog.context.address_country";

/** An MCP `search_catalog` call whose context names the country as an ISO 3166-1 alpha-2 code, as Shop's search does. */
function isCatalogCountry(value: unknown): boolean {
  const params = record(record(value)?.params);
  if (record(value)?.method !== "tools/call" || params?.name !== "search_catalog") return false;
  const country = record(record(record(params.arguments)?.catalog)?.context)?.address_country;
  return typeof country === "string" && /^[A-Z]{2}$/.test(country);
}

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
