// The ship-to countries the gateway knows: each one's name, postcode format and coarse postcode rule. The coarse
// postcode is the only part of a postcode the gateway keeps or sends (invariant 3); the full one is dropped as soon as
// it is coarsened. `coarse()` is strict (Appendix A, as Intent Cloud's binding-v2 runs it): ASCII only, spaces and `-`
// removed, upper-cased, then the whole result must be one full postcode of the country, and the coarse part is a
// fixed group of it. An already-coarse value, trailing characters or non-ASCII input has no coarse form. The same
// function reads the developer's postcode and binding check 4's, so the two agree. A country's currency is never kept
// here: it is read only from the `countries` of Intent Cloud's currency table (currencyFor). Which of these countries
// a search may ship to today is that map met with the contract's ship_to country list (the gateway's shipsTo). Pure.

export interface ShipCountry {
  /** ISO 3166-1 alpha-2. */
  readonly code: string;
  /** As it reads inside a sentence: "the US", "Canada". */
  readonly name: string;
  /** The postcode's form, for asking again: "a 5-digit ZIP code, such as 94107". */
  readonly format: string;
  /** A whole folded postcode of this country; group 1 is its coarse part. */
  readonly full: RegExp;
  /** What a coarse postcode of this country looks like (what a submit sends). */
  readonly coarse: RegExp;
}

const EU2 = /^[0-9]{2}$/;

const euro = (code: string, name: string, example: string, full: RegExp): ShipCountry => ({
  code,
  name,
  format: `a postcode such as ${example}`,
  full,
  coarse: EU2,
});
/** DE, FR, ES, IT and FI: 5 digits, the first 2 kept. */
const EU5 = /^([0-9]{2})[0-9]{3}$/;
/** BE and AT: 4 digits, the first 2 kept. */
const EU4 = /^([0-9]{2})[0-9]{2}$/;

const ALL: readonly ShipCountry[] = [
  // The 5-digit ZIP, or ZIP+4.
  { code: "US", name: "the US", format: "a 5-digit ZIP code, such as 94107", full: /^([0-9]{5})(?:[0-9]{4})?$/, coarse: /^[0-9]{5}$/ },
  // The forward sortation area of a whole postal code.
  { code: "CA", name: "Canada", format: "a postal code such as K1A 0B1", full: /^([A-Z][0-9][A-Z])[0-9][A-Z][0-9]$/, coarse: /^[A-Z][0-9][A-Z]$/ },
  { code: "AU", name: "Australia", format: "a 4-digit postcode, such as 2000", full: /^([0-9]{4})$/, coarse: /^[0-9]{4}$/ },
  // The outward code of a whole postcode (outward and inward code), so "SW1A" alone is asked for again.
  { code: "GB", name: "the UK", format: "a full postcode such as SW1A 1AA", full: /^([A-Z]{1,2}[0-9][A-Z0-9]?)[0-9][A-Z]{2}$/, coarse: /^[A-Z]{1,2}[0-9][A-Z0-9]?$/ },
  // The routing key of a whole Eircode.
  {
    code: "IE",
    name: "Ireland",
    format: "a full Eircode such as D02 X285",
    full: /^([AC-FHKNPRTV-Y][0-9]{2}|D6W)[0-9AC-FHKNPRTV-Y]{4}$/,
    coarse: /^(?:[AC-FHKNPRTV-Y][0-9]{2}|D6W)$/,
  },
  euro("DE", "Germany", "10115", EU5),
  euro("FR", "France", "75001", EU5),
  euro("NL", "the Netherlands", "1012 AB", /^([0-9]{2})[0-9]{2}[A-Z]{2}$/),
  euro("ES", "Spain", "28001", EU5),
  euro("IT", "Italy", "00184", EU5),
  euro("BE", "Belgium", "1000", EU4),
  euro("AT", "Austria", "1010", EU4),
  euro("PT", "Portugal", "1000-001", /^([0-9]{2})[0-9]{5}$/),
  euro("FI", "Finland", "00100", EU5),
];

/** Currencies in words, for asking the budget; any other is named by its code. */
const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  USD: "US dollars",
  CAD: "Canadian dollars (CAD)",
  AUD: "Australian dollars (AUD)",
  GBP: "pounds (GBP)",
  EUR: "euros (EUR)",
};

/** A currency for a sentence: "Canadian dollars (CAD)", or its code. */
export function currencyWords(currency: string): string {
  return Object.hasOwn(CURRENCY_WORDS, currency) ? (CURRENCY_WORDS[currency] ?? currency) : currency;
}

/** Every ship-to country the gateway has rules for, by code. */
export const SHIP_COUNTRIES: Readonly<Record<string, ShipCountry>> = Object.freeze(Object.fromEntries(ALL.map((c) => [c.code, c])));

/** The country's rules, or undefined for a country the gateway has none for. */
export function shipCountry(code: string): ShipCountry | undefined {
  return Object.hasOwn(SHIP_COUNTRIES, code) ? SHIP_COUNTRIES[code] : undefined;
}

/**
 * `coarse(country, postcode)`: null for non-ASCII input; else spaces and `-` removed and upper-cased, and the result
 * must be one whole postcode of the country (its `full` pattern), whose coarse group is returned. Null when there is
 * none, including an already-coarse value, trailing characters and a country the gateway has no rule for.
 */
export function coarsen(country: string, postcode: string): string | null {
  const rules = shipCountry(country);
  // eslint-disable-next-line no-control-regex -- ASCII is exactly U+0000 to U+007F.
  if (rules === undefined || !/^[\x00-\x7f]*$/.test(postcode)) return null;
  return rules.full.exec(postcode.replace(/[ -]/g, "").toUpperCase())?.[1] ?? null;
}

/** Whether `code` is already a coarse postcode of `country` (what a policy lets leave the gateway). */
export function isCoarse(country: string, code: string): boolean {
  return shipCountry(country)?.coarse.test(code) ?? false;
}

/** Country names joined for a sentence: "the US, Canada and Australia". */
export function namesText(codes: readonly string[]): string {
  const names = codes.map((c) => shipCountry(c)?.name ?? c);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** What the currency table says about countries (contract 1.7.1): each served country's currency. */
export interface CountryCurrencies {
  readonly countries?: Readonly<Record<string, string>> | undefined;
}

/**
 * The currency a search, its budget and its checkout to `country` are in: the table's `countries` entry, or undefined
 * for a country it leaves out and with no table. The one place a country's currency is read; there is no fallback.
 */
export function currencyFor(country: string, table: CountryCurrencies | null): string | undefined {
  const listed = table?.countries;
  return listed !== undefined && Object.hasOwn(listed, country) ? listed[country] : undefined;
}
