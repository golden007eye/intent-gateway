// A full postcode inside free text (invariant 3): the whole postcode narrows a delivery to a street or a building, so
// only its coarse part may leave the gateway, and only from the postcode field, coarsened (src/shipto). A candidate
// is found by its written shape, then must be one whole postcode of its country by src/shipto's own strict pattern
// (`coarsen`), so the two never disagree on what a full postcode is.
//
// Left alone on purpose: a bare run of 4 or 5 digits (a US ZIP, an AU, BE, AT, DE, FR, ES, IT or FI postcode) is
// also a model number, a size or a year ("RTX 4090", "size 10", "2024"), and the policy may share a 5-digit ZIP; the
// coarse parts alone ("SW1A", "K1A", "D02") are what the policy shares anyway. Each other shape carries a guard
// against product text, written next to it.
import { coarsen } from "../shipto/index.ts";

// A candidate stands alone: start or whitespace or an opening mark before it, end or whitespace or punctuation after
// it, so a slice of a handle, a UUID or a base64 value (letters, digits, "-", "_", "+", "/", "=") is never one.
const BEFORE = String.raw`(?<![^\s,;:(\["'])`;
const AFTER = String.raw`(?![^\s,.;:!?)\]"'])`;

/** The UK postcode areas (the letters before the first digit). "PS5 2TB" and "RX7 1AB" name none. */
const GB_AREAS = new Set(
  (
    "AB AL B BA BB BD BH BL BN BR BS BT CA CB CF CH CM CO CR CT CV CW DA DD DE DG DH DL DN DT DY E EC EH EN EX FK FY G " +
    "GL GU GY HA HD HG HP HR HS HU HX IG IM IP IV JE KA KT KW KY L LA LD LE LL LN LS LU M ME MK ML N NE NG NN NP NR NW " +
    "OL OX PA PE PH PL PO PR RG RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TD TF TN TQ TR TS TW UB W WA WC WD " +
    "WF WN WR WS WV YO ZE"
  ).split(" "),
);
/**
 * Inward-code letters that are a unit or an ordinal in product text: "M2 2TB", "S24 1TB", "B12 3HP", "E3 1LB",
 * "N1 2ND". A real postcode ending in one of them is missed: the price of not refusing every storage size.
 */
const GB_UNIT_INWARD = new Set(["TB", "GB", "LB", "FT", "HP", "ST", "ND", "RD", "TH"]);
/**
 * Upper-case letter pairs after 4 digits that are a unit in product text ("1080 TI", "2000 MB", "1500 ML", "1230 PM").
 * The Dutch postcode is matched upper-case only, so lower-case words ("1000 in", "2000 or") are never one.
 */
const NL_UNIT_LETTERS = new Set(
  "AH AM CC CL CM CT DB DL FT GB GT HD HP HZ IN KB KG KM KW LB LM MB MG ML MM MP MW NM OZ PB PC PK PM PS PX RS SA SD SE SQ SS ST TB TI VA XL XS YD".split(" "),
);
const IE_CHARS = "0-9AC-FHKNPRTV-Y";

interface Shape {
  readonly country: string;
  readonly pattern: RegExp;
  /** A further guard on the match (upper-cased, as written); absent when the shape alone is enough. */
  readonly keep?: (match: string, raw: string) => boolean;
}

const SHAPES: readonly Shape[] = [
  // ZIP+4 written with its hyphen; a bare 9-digit run is a part number as often as a ZIP.
  { country: "US", pattern: new RegExp(String.raw`${BEFORE}\d{5}-\d{4}${AFTER}`, "g") },
  // Letter, digit, letter, then digit, letter, digit: the letters D F I O Q U never appear in one.
  { country: "CA", pattern: new RegExp(String.raw`${BEFORE}[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d${AFTER}`, "gi") },
  {
    country: "GB",
    pattern: new RegExp(String.raw`${BEFORE}([A-Z]{1,2})\d[A-Z\d]?[ -]?\d([A-Z]{2})${AFTER}`, "gi"),
    keep: (match) => {
      const parts = /^([A-Z]{1,2})\d.*\d([A-Z]{2})$/.exec(match);
      return parts !== null && GB_AREAS.has(parts[1] ?? "") && !GB_UNIT_INWARD.has(parts[2] ?? "");
    },
  },
  {
    // A routing key, then the 4-character unique identifier. The identifier must hold a letter ("A15 2024" is a phone
    // and a year); written in lower case it must hold a digit too ("h12 deck" is not an Eircode).
    country: "IE",
    pattern: new RegExp(String.raw`${BEFORE}(?:[AC-FHKNPRTV-Y]\d{2}|D6W)[ -]?[${IE_CHARS}]{4}${AFTER}`, "gi"),
    keep: (match, raw) => {
      const id = match.slice(-4);
      if (!/[A-Z]/.test(id)) return false;
      return raw === raw.toUpperCase() || /\d/.test(id);
    },
  },
  // 4 digits then 2 capital letters ("1012 AB"); see NL_UNIT_LETTERS.
  { country: "NL", pattern: new RegExp(String.raw`${BEFORE}[1-9]\d{3} ?[A-Z]{2}${AFTER}`, "g"), keep: (match) => !NL_UNIT_LETTERS.has(match.slice(-2)) },
  // Portugal's 4 digits, a hyphen, 3 digits ("1000-001").
  { country: "PT", pattern: new RegExp(String.raw`${BEFORE}[1-9]\d{3}-\d{3}${AFTER}`, "g") },
];

/** Whether `text` (already normalised) holds a whole postcode of a ship-to country, beyond what a ZIP alone is. */
export function hasFullPostcode(text: string): boolean {
  for (const shape of SHAPES) {
    for (const [raw] of text.matchAll(shape.pattern)) {
      const match = raw.toUpperCase();
      if (coarsen(shape.country, match) !== null && (shape.keep?.(match.replace(/[ -]/g, ""), raw) ?? true)) return true;
    }
  }
  return false;
}
