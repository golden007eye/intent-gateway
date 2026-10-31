// The free-text rules (invariant 3), run only on what the agent typed into a tool (IdentityOptions.freeText): a whole
// postcode narrows a delivery to a street or a building, and a street named after a delivery phrase is an address
// even with no house number. Merchant text (an offer title, a Shop result, a statement) never meets these rules, so a
// product code that looks like a postcode can only cost an agent one refused search, never a verify failure.
//
// Postcodes. A candidate is found by its written shape, then must be one whole postcode of its country by src/shipto's
// own strict pattern (`coarsen`), so the two never disagree on what a full postcode is. Shapes that product codes
// share ("RX 7900 XT", "1998 VW Golf", "M4 2SB screws", "R35 GTR1") count only within a few characters after a
// delivery phrase or a postcode word ("ship to", "deliver to:", "I live on", "postcode", "zip"):
// - anywhere: ZIP+4 with its hyphen ("94107-1234"), a Canadian postal code ("K1A 0B1"), a UK postcode whose outward
//   code has 3 or 4 characters ("SW1A 1AA", "LS1 1BA"), Portugal's "1000-001";
// - after a delivery phrase only: a UK postcode with a 2-character outward code ("M1 1AE"), a Dutch one ("1012 AB"),
//   an Eircode ("D02 X285"), a ZIP+4 written without its hyphen, Portugal's with a space.
// A bare 4- or 5-digit number is never one (a ZIP the policy may share, or a model number). Not attempted: lookalike
// letters from other scripts, letters spaced out one by one, a postcode split across fields; `intent log` says free
// text is sent as written.
//
// Streets with no house number: street words and a street type right after a delivery phrase ("deliver to Evergreen
// Terrace", "I live on Baker Street", "addr: Abbey Road"), ending the phrase ("…Terrace.", "…Terrace, flat 2"), so
// "shipping to Main Street Coffee" or "square plate" stays clean. With a house number, the UK types Crescent, Close,
// Mews and Gardens count too ("12 Acacia Gardens"). Pure.
import { coarsen } from "../shipto/index.ts";
import { QUANTITY_WORDS, STREET_WORD, SUFFIXES } from "./street.ts";

type FreeTextKind = "postcode" | "street_address";

/** Every dash and minus as "-", curly quotes and guillemets as plain quotes: "94107–1234" is "94107-1234". */
function fold(text: string): string {
  return text
    .replace(/[\p{Pd}−]/gu, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„«»]/g, '"');
}

/** The free-text findings in `text` (already normalised); `isPostcode`: it is the postcode field, so no postcode rule. */
export function freeTextFindings(text: string, isPostcode: boolean): FreeTextKind[] {
  const folded = fold(text);
  const kinds: FreeTextKind[] = [];
  if (hasStreet(folded)) kinds.push("street_address");
  if (!isPostcode && hasPostcode(folded)) kinds.push("postcode");
  return kinds;
}

// ---- delivery phrases ------------------------------------------------------------------------------------------

const VERBS = String.raw`(?:deliver(?:s|ed|ing|y)?|ship(?:s|ped|ping)?|send(?:s|ing)?|sent|mail(?:s|ed|ing)?|post(?:s|ed|ing)?|bring(?:s|ing)?|brought|drop(?:s|ped|ping)?(?:[\s-]+off)?|courier(?:s|ed|ing)?|dispatch(?:es|ed|ing)?)`;
const FILLER = String.raw`(?:\s+(?:it|them|this|these|those|one|please|for\s+me|for\s+us)){0,3}`;
/** A delivery phrase: "ship to", "deliver it to", "drop off at", "deliver to:", "I live on", "addr:", "postcode". */
const DELIVERY = new RegExp(
  [
    String.raw`\b${VERBS}${FILLER}(?:[\s-]+(?:to|at|on)\b\s*[:,]?|\s*:)`,
    String.raw`\b(?:i|we)\s+live\s+(?:on|at|in)\b`,
    String.raw`\bmy\s+flat\s+(?:on|at|in)\b`,
    String.raw`\blocated\s+at\b`,
    String.raw`\b(?:address|addr)(?:\s+is)?\s*[:=]?`,
    String.raw`\b(?:post\s*code|postal\s+code|zip(?:\s*code)?|eircode)(?:\s+is)?\s*[:=]?`,
  ].join("|"),
  "giu",
);

/** Where each delivery phrase in `text` ends. */
function phraseEnds(text: string): number[] {
  return [...text.matchAll(DELIVERY)].map((m) => m.index + m[0].length);
}

/** A delivery phrase ends at most this many characters before `start` ("ship to the flat at SW1A 1AA"). */
const NEAR = 30;

// ---- streets ---------------------------------------------------------------------------------------------------

const UK_STRONG = ["Crescent", "Cres", "Close", "Mews", "Gardens", "Gdns", "Str"];
const UK_WEAK = ["Square", "Sq", "Grove", "Row", "Hill", "Walk"];
const NOT_A_STREET_WORD = ["the", "a", "an", "my", "your", "our", "their", "his", "her", "its", "this", "that", "me", "us", "you", "him", "them", "home", "work", "office"];
const ALL_TYPES = [...SUFFIXES, ...UK_STRONG, ...UK_WEAK].join("|");
/** Street words then a type, ending the phrase: end of text, punctuation, a number, or a unit word. */
const STREET_AFTER_PHRASE = new RegExp(
  String.raw`^(?:the\s+)?(?:(?!(?:${NOT_A_STREET_WORD.join("|")})\b)${STREET_WORD}\s+){1,4}(?:${ALL_TYPES})\b\.?(?=\s*(?:$|[,;:!?)\]"'/]|\d|(?:apt|flat|unit|suite|please|near)\b))`,
  "i",
);
const UK_HOUSE = new RegExp(
  String.raw`(?<![\w-])\d{1,6}[A-Za-z]?\s+(?!(?:${QUANTITY_WORDS.join("|")})\b)(?:${STREET_WORD}\s+){1,4}(?:${UK_STRONG.join("|")})\b`,
  "i",
);

function hasStreet(text: string): boolean {
  if (UK_HOUSE.test(text)) return true;
  return phraseEnds(text).some((end) => STREET_AFTER_PHRASE.test(text.slice(end).trimStart()));
}

// ---- postcodes -------------------------------------------------------------------------------------------------

// A candidate stands alone: no letter, digit, "_" or "-" before it (so never a slice of a handle or a UUID), no letter
// or digit after it. Between its two halves: any run of spaces, tabs and the marks people type there.
const BEFORE = String.raw`(?<![\p{L}\p{N}_-])`;
const AFTER = String.raw`(?![\p{L}\p{N}])`;
const SEP = String.raw`[\s\-._/·,]*`;

/** The UK postcode areas (the letters before the first digit). "PS5 2TB" and "RX7 1AB" name none. */
const GB_AREAS = new Set(
  (
    "AB AL B BA BB BD BH BL BN BR BS BT CA CB CF CH CM CO CR CT CV CW DA DD DE DG DH DL DN DT DY E EC EH EN EX FK FY G " +
    "GL GU GY HA HD HG HP HR HS HU HX IG IM IP IV JE KA KT KW KY L LA LD LE LL LN LS LU M ME MK ML N NE NG NN NP NR NW " +
    "OL OX PA PE PH PL PO PR RG RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TD TF TN TQ TR TS TW UB W WA WC WD " +
    "WF WN WR WS WV YO ZE"
  ).split(" "),
);
/** Inward-code letters that are a unit or an ordinal in product text: "S24 1TB", "B12 3HP", "E3 1LB", "N1 2ND". */
const GB_UNIT_INWARD = new Set(["TB", "GB", "LB", "FT", "HP", "ST", "ND", "RD", "TH"]);
/** The inward code: a digit, then two letters other than C I K M O V. */
const GB_INWARD = String.raw`\d[ABD-HJLNP-UW-Z]{2}`;

interface Shape {
  readonly country: string;
  readonly pattern: RegExp;
  /** Counts only near the end of a delivery phrase. */
  readonly needsPhrase: boolean;
  /** A further guard on the match (upper-cased, separators removed). */
  readonly keep?: (folded: string) => boolean;
}

const gbKeep = (code: string): boolean => {
  const parts = /^([A-Z]{1,2})\d.*\d([A-Z]{2})$/.exec(code);
  return parts !== null && GB_AREAS.has(parts[1] ?? "") && !GB_UNIT_INWARD.has(parts[2] ?? "");
};

const SHAPES: readonly Shape[] = [
  { country: "US", pattern: new RegExp(String.raw`${BEFORE}\d{5}\s*-\s*\d{4}${AFTER}`, "gu"), needsPhrase: false },
  { country: "US", pattern: new RegExp(String.raw`${BEFORE}\d{5}[\s./]*\d{4}${AFTER}`, "gu"), needsPhrase: true },
  // Letter, digit, letter, then digit, letter, digit: the letters D F I O Q U never appear in one.
  { country: "CA", pattern: new RegExp(String.raw`${BEFORE}[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]${SEP}\d[ABCEGHJ-NPRSTV-Z]\d${AFTER}`, "giu"), needsPhrase: false },
  {
    country: "GB",
    pattern: new RegExp(String.raw`${BEFORE}(?:[A-Z]{2}\d[A-Z\d]?|[A-Z]\d[A-Z\d])${SEP}${GB_INWARD}${AFTER}`, "giu"),
    needsPhrase: false,
    keep: gbKeep,
  },
  { country: "GB", pattern: new RegExp(String.raw`${BEFORE}[A-Z]\d${SEP}${GB_INWARD}${AFTER}`, "giu"), needsPhrase: true, keep: gbKeep },
  // The letters SA, SD and SS are never used in a Dutch postcode.
  { country: "NL", pattern: new RegExp(String.raw`${BEFORE}[1-9]\d{3}${SEP}[A-Z]{2}${AFTER}`, "giu"), needsPhrase: true, keep: (c) => !["SA", "SD", "SS"].includes(c.slice(-2)) },
  { country: "IE", pattern: new RegExp(String.raw`${BEFORE}(?:[AC-FHKNPRTV-Y]\d{2}|D6W)${SEP}[0-9AC-FHKNPRTV-Y]{4}${AFTER}`, "giu"), needsPhrase: true },
  { country: "PT", pattern: new RegExp(String.raw`${BEFORE}[1-9]\d{3}\s*-\s*\d{3}${AFTER}`, "gu"), needsPhrase: false },
  { country: "PT", pattern: new RegExp(String.raw`${BEFORE}[1-9]\d{3}\s+\d{3}${AFTER}`, "gu"), needsPhrase: true },
];

function hasPostcode(text: string): boolean {
  let ends: number[] | null = null;
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      const code = match[0].toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (coarsen(shape.country, code) === null || !(shape.keep?.(code) ?? true)) continue;
      if (!shape.needsPhrase) return true;
      ends ??= phraseEnds(text);
      if (ends.some((end) => end <= match.index && match.index - end <= NEAR)) return true;
    }
  }
  return false;
}
