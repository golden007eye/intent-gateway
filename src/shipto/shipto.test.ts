// The coarse postcode of every country the gateway has rules for: valid and invalid postcodes, and what they coarsen
// to. Expected values are written out from the rules (remove spaces and `-`, upper-case, then cut), never computed.
// For US, CA and AU the rules must also be the contract's own (vector a4's `coarse` cases).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coarsePostcode } from "../contract/index.ts";
import { coarsen, currencyFor, currencyWords, isCoarse, namesText, SHIP_COUNTRIES, shipCountry } from "./index.ts";

const a4 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "a4-snapshot-v4.json"), "utf8")) as {
  coarse: { country: string; postal_code: string; coarse: string | null }[];
};

/** [country, postcode, coarse or null]. */
const CASES: readonly (readonly [string, string, string | null])[] = [
  ["US", "94107", "94107"],
  ["US", "94107-1234", "94107"],
  ["US", "941071234", "94107"],
  ["US", "9410", null],
  ["US", "ABCDE", null],
  ["CA", "K1A 0B1", "K1A"],
  ["CA", "k1a-0b1", "K1A"],
  ["CA", "11A 0B1", null],
  ["CA", "KK1 0B1", null],
  ["AU", "2000", "2000"],
  ["AU", "0800", "0800"],
  ["AU", "200", null],
  ["AU", "20000", null],
  ["GB", "SW1A 1AA", "SW1A"],
  ["GB", "M1 1AE", "M1"],
  ["GB", "EC1A 1BB", "EC1A"],
  ["GB", "B33 8TH", "B33"],
  ["GB", "cr2 6xh", "CR2"],
  ["GB", "1AA", null],
  ["GB", "SW1A", null],
  ["GB", "12 3AB", null],
  // A character short: the inward code is checked too, so this is no postcode, not the area SW1.
  ["GB", "SW1A1A", null],
  ["GB", "SW1A 1A1", null],
  ["IE", "D02 X285", "D02"],
  ["IE", "D6W 1234", "D6W"],
  ["IE", "A65 F4E2", "A65"],
  ["IE", "B65 F4E2", null],
  ["IE", "D6X 1234", null],
  ["DE", "10115", "10"],
  ["DE", "1", null],
  ["FR", "75001", "75"],
  ["FR", "2A004", null],
  ["NL", "1012 AB", "10"],
  ["NL", "AB12", null],
  ["ES", "28001", "28"],
  ["ES", "E-28", null],
  ["IT", "00184", "00"],
  ["IT", "I0184", null],
  ["BE", "1000", "10"],
  ["BE", "B100", null],
  ["AT", "1010", "10"],
  ["AT", "A-1010", null],
  ["PT", "1000-001", "10"],
  ["PT", "P1000", null],
  ["FI", "00100", "00"],
  ["FI", "FI-00100", null],
  // Strict coarse() (Intent Cloud's security review): an already-coarse value, trailing characters and non-ASCII input
  // have no coarse form, in every country.
  ["US", "94107X", null],
  ["US", "94107-12", null],
  ["US", "９４１０７", null],
  ["CA", "K1A", null],
  ["CA", "K1A 0B1 X", null],
  ["CA", "K1A 0B", null],
  ["AU", "2000A", null],
  ["AU", "２０００", null],
  ["GB", "SW1A 1AAX", null],
  ["GB", "M1", null],
  ["GB", "SW1A 1ÅA", null],
  ["IE", "D02", null],
  ["IE", "D02 X2855", null],
  ["IE", "T12 AB34", null],
  ["IE", "D02 X28É", null],
  ["DE", "10", null],
  ["DE", "101150", null],
  ["DE", "1011", null],
  ["FR", "75", null],
  ["FR", "75001 Paris", null],
  ["NL", "1012", null],
  ["NL", "1012 ABC", null],
  ["NL", "10", null],
  ["ES", "28", null],
  ["ES", "280011", null],
  ["IT", "00", null],
  ["IT", "001840", null],
  ["BE", "10", null],
  ["BE", "10000", null],
  ["AT", "10", null],
  ["AT", "1010 ", null],
  ["PT", "10", null],
  ["PT", "1000", null],
  ["PT", "1000-0012", null],
  ["FI", "00", null],
  ["FI", "0010", null],
  ["US", "94107\t", null],
];

describe("coarse postcodes, every country", () => {
  it.each(CASES)("%s %j → %j", (country, postcode, coarse) => {
    expect(coarsen(country, postcode)).toBe(coarse);
    if (coarse !== null) expect(isCoarse(country, coarse)).toBe(true);
  });

  it("has rules for exactly the 14 countries (US, CA, AU, GB, IE and nine euro countries), and each has a valid and an invalid case above", () => {
    const codes = ["US", "CA", "AU", "GB", "IE", "DE", "FR", "NL", "ES", "IT", "BE", "AT", "PT", "FI"];
    expect(Object.keys(SHIP_COUNTRIES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(CASES.some(([c, , coarse]) => c === code && coarse !== null), code).toBe(true);
      expect(CASES.some(([c, , coarse]) => c === code && coarse === null), code).toBe(true);
    }
  });

  it("no rule for another country, nor for an inherited name", () => {
    expect(coarsen("JP", "100-0001")).toBeNull();
    expect(coarsen("toString", "12345")).toBeNull();
    expect(shipCountry("__proto__")).toBeUndefined();
  });

  it("a full postcode is never its own coarse form where the cut drops a part (GB, CA)", () => {
    expect(isCoarse("GB", "SW1A1AA")).toBe(false);
    expect(isCoarse("CA", "K1A0B1")).toBe(false);
    expect(isCoarse("US", "94107-1234")).toBe(false);
  });

  it("the contract's coarse() is this one for every contract country (vector a4 is replayed in src/contract)", () => {
    for (const [country, postcode, coarse] of CASES) expect(coarsePostcode(country, postcode)).toBe(coarse);
  });

  it("the vector covers every country the gateway has rules for; one it has none for has no coarse code", () => {
    const countries = new Set(a4.coarse.map((c) => c.country));
    for (const code of Object.keys(SHIP_COUNTRIES)) expect(countries.has(code), code).toBe(true);
    for (const c of a4.coarse.filter((x) => !Object.hasOwn(SHIP_COUNTRIES, x.country))) expect(c.coarse).toBeNull();
  });

  it("coarse() of an already coarse GB code is no code: the full postcode must be given (Appendix G check 4)", () => {
    expect(coarsen("GB", "SW1A")).toBeNull();
    expect(coarsen("GB", "SW1A 1AA")).toBe("SW1A");
  });
});

describe("a country's currency", () => {
  it("only from the table's `countries` (contract 1.7.1); no table, or a country it leaves out, gives none", () => {
    const table = { countries: { US: "USD", CA: "CAD", GB: "GBP" } };
    expect(["US", "CA", "GB"].map((c) => currencyFor(c, table))).toEqual(["USD", "CAD", "GBP"]);
    expect(currencyFor("AU", table)).toBeUndefined();
    expect(currencyFor("CA", null)).toBeUndefined();
    expect(currencyFor("US", {})).toBeUndefined();
  });

  it("attack: there is no fixed fallback, and an inherited name is not a country", () => {
    expect(currencyFor("toString", { countries: { US: "USD" } })).toBeUndefined();
    expect(Object.values(SHIP_COUNTRIES).some((c) => "currency" in c)).toBe(false);
  });

  it("in words, for the budget question", () => {
    expect(currencyWords("CAD")).toBe("Canadian dollars (CAD)");
    expect(currencyWords("USD")).toBe("US dollars");
    expect(currencyWords("NZD")).toBe("NZD");
  });

  it("country names for a sentence", () => {
    expect(namesText(["US", "CA", "AU"])).toBe("the US, Canada and Australia");
    expect(namesText(["US", "AU"])).toBe("the US and Australia");
    expect(namesText(["US"])).toBe("the US");
  });
});
