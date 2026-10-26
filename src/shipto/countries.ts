// The ship-to countries the gateway knows: each one's name, currency, postcode format and coarse postcode rule. The
// coarse postcode is the only part of a postcode the gateway keeps or sends (invariant 3); the full one is dropped as
// soon as it is coarsened. Every rule first removes spaces and `-` and upper-cases, then cuts. Which of these
// countries a search may ship to today is the contract's ship_to country list met with Intent Cloud's currency table
// (the gateway's shipsTo). Pure.

export interface ShipCountry {
  /** ISO 3166-1 alpha-2. */
  readonly code: string;
  /** As it reads inside a sentence: "the US", "Canada". */
  readonly name: string;
  /** ISO 4217: the currency a search, its budget and its checkout are in. */
  readonly currency: string;
  /** The postcode's form, for asking again: "a 5-digit ZIP code, such as 94107". */
  readonly format: string;
  /** The folded postcode's coarse form, or null when it has none. */
  readonly cut: (folded: string) => string | null;
  /** What a coarse postcode of this country looks like. */
  readonly coarse: RegExp;
}

/** The first `n` characters, when they match `pattern`. */
const first =
  (n: number, pattern: RegExp) =>
  (folded: string): string | null => {
    const cut = folded.slice(0, n);
    return pattern.test(cut) ? cut : null;
  };

const US = /^[0-9]{5}$/;
const CA = /^[A-Z][0-9][A-Z]$/;
const AU = /^[0-9]{4}$/;
const GB = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
/** A UK inward code: a digit and two letters. */
const GB_INWARD = /^[0-9][A-Z]{2}$/;
const IE = /^(?:[AC-FHKNPRTV-Y][0-9]{2}|D6W)$/;
const EU2 = /^[0-9]{2}$/;

const euro = (code: string, name: string, example: string): ShipCountry => ({
  code,
  name,
  currency: "EUR",
  format: `a postcode such as ${example}`,
  cut: first(2, EU2),
  coarse: EU2,
});

const ALL: readonly ShipCountry[] = [
  { code: "US", name: "the US", currency: "USD", format: "a 5-digit ZIP code, such as 94107", cut: first(5, US), coarse: US },
  { code: "CA", name: "Canada", currency: "CAD", format: "a postal code such as K1A 0B1", cut: first(3, CA), coarse: CA },
  // Exactly 4 digits: a longer code has no coarse form.
  {
    code: "AU",
    name: "Australia",
    currency: "AUD",
    format: "a 4-digit postcode, such as 2000",
    cut: (f) => (AU.test(f) ? f : null),
    coarse: AU,
  },
  // The outward code: the postcode without its last 3 characters, which must be an inward code (so a postcode short
  // of a character, `SW1A1A`, has no coarse form rather than the wrong one, `SW1`).
  {
    code: "GB",
    name: "the UK",
    currency: "GBP",
    format: "a postcode such as SW1A 1AA",
    cut: (f) => (GB.test(f.slice(0, -3)) && GB_INWARD.test(f.slice(-3)) ? f.slice(0, -3) : null),
    coarse: GB,
  },
  // The Eircode's routing key.
  { code: "IE", name: "Ireland", currency: "EUR", format: "an Eircode such as D02 X285", cut: first(3, IE), coarse: IE },
  euro("DE", "Germany", "10115"),
  euro("FR", "France", "75001"),
  euro("NL", "the Netherlands", "1012 AB"),
  euro("ES", "Spain", "28001"),
  euro("IT", "Italy", "00184"),
  euro("BE", "Belgium", "1000"),
  euro("AT", "Austria", "1010"),
  euro("PT", "Portugal", "1000-001"),
  euro("FI", "Finland", "00100"),
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
 * The coarse postcode of `postcode` in `country`: spaces and `-` removed, upper-cased, then the country's cut, or null
 * when the postcode has no coarse form there (or the country has no rule).
 */
export function coarsen(country: string, postcode: string): string | null {
  const rules = shipCountry(country);
  if (rules === undefined) return null;
  return rules.cut(postcode.replace(/[\s-]/g, "").toUpperCase());
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

/** What a currency table may say about countries: contract 1.7.1 adds `countries` (country → currency); 1.7.0 has none. */
export type CountryCurrencies = Readonly<Record<string, unknown>> & { readonly countries?: Readonly<Record<string, string>> };

/**
 * The currency a search, its budget and its checkout to `country` are in: the table's `countries` entry when the
 * table has one, else the gateway's own mapping (SHIP_COUNTRIES). The one place a country's currency is read.
 */
export function currencyFor(country: string, table: CountryCurrencies | null): string | undefined {
  const listed = table?.countries;
  if (listed !== undefined) return Object.hasOwn(listed, country) ? listed[country] : undefined;
  return shipCountry(country)?.currency;
}
