// The Shop provider (G5): Shop's `search_catalog`, through the linked Shop wallet adapter, so every request is logged
// before it is sent (invariant 2) and every answer is projected to named fields before it gets here (invariant 3).
import type { CatalogQuery, WalletAdapter } from "../wallet/index.ts";
import type { SearchOffer, SearchProvider, SearchQuery } from "./types.ts";

/** How many products the Shop provider asks for: the most an agent is shown at once. */
export const SHOP_SEARCH_LIMIT = 10;
/** The longest query text sent to Shop. */
export const MAX_QUERY_CHARS = 300;

/**
 * The words sent as Shop's query: the product, else the category, then the must-haves, in the agent's words. A
 * category is a path (`home/kitchen`); its separators become spaces.
 */
export function queryText(query: SearchQuery): string {
  const head = query.product ?? query.category?.replace(/[/>_-]+/g, " ") ?? "";
  return [head, ...query.mustHaves].join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

/**
 * The Shop provider over a wallet adapter that has a catalog. The country and currency are the developer's (the
 * query's); the postcode is never sent. The budget is sent as Shop's price ceiling only when it is in the search's
 * currency. Variants Shop marks unavailable are dropped here.
 */
export function createShopProvider(wallet: Pick<WalletAdapter, "searchCatalog">): SearchProvider {
  return {
    name: "shop",
    async search(query) {
      if (wallet.searchCatalog === undefined) return [];
      const currency = query.budget?.currency ?? "USD";
      const catalogQuery: CatalogQuery = {
        text: queryText(query),
        maxPriceMinor: query.budget === null ? null : query.budget.amountMinor,
        currency,
        country: query.country,
        limit: SHOP_SEARCH_LIMIT,
      };
      const hits = await wallet.searchCatalog(catalogQuery);
      return hits
        .filter((hit) => hit.available)
        .map(
          (hit): SearchOffer => ({
            provider: "shop",
            storeDomain: hit.storeDomain,
            storefrontOrigin: hit.storefrontOrigin,
            productRef: hit.productRef,
            variantRef: hit.variantRef,
            title: hit.title,
            variantTitle: hit.variantTitle,
            price: hit.price,
            availability: "in_stock",
            imageUrl: hit.imageUrl,
            productUrl: hit.productUrl,
            categories: hit.categories,
            requiresShipping: hit.requiresShipping,
          }),
        );
    },
  };
}
