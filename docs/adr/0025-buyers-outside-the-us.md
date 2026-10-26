# ADR-0025: Buyers outside the US: a country and postcode, caps scaled per currency

Status: accepted · 2026-10-25 · Amended by ADR-0026 (contract 1.7.1) · Amends ADR-0024 (the submit's currency and ship-to checks); relates to ADR-0009 (policy v1 narrows only), ADR-0021 (search seam)

## Context

Contract 1.7.0 ships to the US, Canada and Australia, and its meta carries a ceiling per currency (`currency_table`). Until now `find_offers` took a 5-digit US ZIP and a budget in US dollars, and the submit refused any checkout not in USD, because the policy's limits are whole US dollars and the gateway never converts. Contract 1.7.1 will add the UK, Ireland and the euro countries.

## Decision

- **find_offers takes `country`, `postcode` and `budget`**, the budget in the ship-to country's currency. The postcode is coarsened at once (`src/shipto`); only the country and the coarse code are held, remembered, logged or sent (invariant 3). `src/shipto` holds the rules for all fourteen countries, so a later contract only widens the list.
- **The countries come from one place:** the contract's `ship_to.country` enum (`ShipToCountry`), kept where the currency table lists the country's currency (`shipsTo`). A country's currency comes from one lookup, `currencyFor`, which reads a 1.7.1 `countries` field when the table has one. Any other country is refused with one line that names the countries shipped to.
- **Outside the US, search goes through the linked Shop wallet only.** The catalog search the contract defines takes a US ZIP.
- **The policy stays in whole USD, and its caps are scaled, never the prices.** In currency C a cap is the USD cap × (C's ceiling / the USD ceiling): per-order ceilings for `per_order_usd` and `per_day_usd`, weekly ceilings for `per_week_usd`, rounded down to a minor unit (`capsIn`). A currency whose ratio to USD falls outside 0.25 to 4, per order or per week, is not scaled: a table must not widen a cap without bound (invariant 1), and the currency is treated as unsupported. Each currency has its own daily and weekly window. With no table, or no usable ceiling for the currency, a search in it is refused and a purchase in it is never let through without a cap.
- **The submit checks the search's country, coarse code and currency.** The checkout must ship to the country and coarse postcode of the search, in the currency of that country; anything else is refused locally, before any send.

## Consequences

- The caps add up across currencies: $40 a week in USD, and CAD 56 a week in CAD, can both be spent in the same week.
- In 1.7.0 an approval's status (`display.total`) and an outcome's `final_total` are USD-only `Money`, so a CAD or AUD approval cannot be read back through `get_approval_status` until 1.7.1. The payment-time cap is tested at the completion's own level until then.
- Shop agent payments outside the US have not been tried with a real account; a first order there may go to Shop's checkout page.
