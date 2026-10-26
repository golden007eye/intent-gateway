// Ship-to countries: each one's currency, postcode format and coarse postcode rule. Only the coarse postcode is ever
// kept or sent; the full one is dropped when it is coarsened (invariant 3).
export { coarsen, type CountryCurrencies, currencyFor, currencyWords, isCoarse, namesText, SHIP_COUNTRIES, type ShipCountry, shipCountry } from "./countries.ts";
