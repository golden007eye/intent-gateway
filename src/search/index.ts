// The search seam (G5, ADR-0021): the gateway searches catalogs itself, Shop first, and filters what comes back under
// the policy. The gateway sends Intent Cloud nothing for a search made here. Each provider sends through the
// disclosure log (the Shop provider through the linked Shop wallet adapter), so the seam itself opens no connection.
export { EXCLUDED_KEYWORDS, excludedGroup } from "./excluded.ts";
export { type FilterContext, type Filtered, filterOffers, MAX_OFFERS, mergeOffers, offerProblems, POLICY_CURRENCY } from "./filter.ts";
export { newOfferHandle, searchProviders } from "./seam.ts";
export { createShopProvider, MAX_QUERY_CHARS, queryText, SHOP_SEARCH_LIMIT } from "./shop.ts";
export type { ProviderName, SearchMoney, SearchOffer, SearchProvider, SearchQuery } from "./types.ts";
