# ADR-0026: Contract 1.7.1: the UK, Ireland and the euro countries; each country's currency from Intent Cloud

Status: proposed · 2026-10-25 · Amends ADR-0025 (where a country's currency comes from, the coarse postcode); relates to ADR-0024 (the submit)

## Context

Contract 1.7.1 adds buyers in GB, IE and the euro countries DE, FR, NL, ES, IT, BE, AT, PT and FI. Its meta's `currency_table` gains `countries`, each served country's currency, listing only the countries whose currency is in the table, and its version is taken over `{currencies, countries}`. A checkout whose currency is not its ship-to country's is refused with `currency_unsupported`. An outcome's `final_total` takes any two-decimal currency, and binding check 4 coarsens the full postcode Shop observed. 1.7.0 stays frozen on the server, USD only.

## Decision

- **The gateway speaks 1.7.1.** It vendors the tree byte for byte (`scripts/vendor-contract.sh`) and sends `Intent-Contract-Version: 1.7.1` on every request but the pause, which keeps `1.7.0` as Appendix H names it.
- **A country's currency comes only from the table's `countries`.** The gateway keeps no mapping of its own. A search may ship to a country that map lists, that the contract's `ship_to.country` enum names and that `src/shipto` has rules for. A table without `countries`, with a currency that has no two decimals, or whose version is not the hash of what it holds is not used, and then nothing ships. A country left out of the map is refused with one line: intent does not ship there yet.
- **coarse() is strict.** ASCII only, spaces and `-` removed, upper-cased, then the whole result must be one full postcode of the country, and the coarse part is a fixed group of it. An already-coarse value has no coarse form, so a partial postcode such as `SW1A` is asked for again. The same function reads the developer's postcode and binding check 4's.
- **Binding check 4 runs on the full postcode, in memory.** The Shop adapter keeps the full postcode on the checkout as a non-enumerable field; binding-v2 coarsens it, and the chain records only its coarse form (`ship_to_postal_code_coarse`), from which `intent verify` gives the same verdict. An observed postcode with no country is `unknown`.
- **Refusals after the submit.** Intent Cloud enforces the country map again at the passkey and at the `completing` report; a refused report (403 or 409) is final, and nothing is paid.

## Consequences

- Searches to GB, IE and the euro countries go through the linked Shop wallet, in GBP or EUR, with the caps scaled as ADR-0025 says.
- The 1.7.1 tree under review still types `ApprovalStatus.display.total` as USD-only `Money`, so a non-USD approval cannot be read back through `get_approval_status` until the final tree widens it; the end-to-end tests for CAD, AUD, GBP and EUR fail until then.
