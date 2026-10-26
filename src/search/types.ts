// The search seam's own terms (G5, ADR-0021): a query the gateway builds from the agent's words, the providers that
// answer it, and the offers they return, normalized. A provider is any catalog the gateway asks directly; Shop is the
// first. Intent Cloud is not a provider here: a search through this seam never reaches it.

/** Integer minor units with their ISO 4217 currency. */
export interface SearchMoney {
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * One search in the gateway's terms. `postcode` is the coarse code (src/shipto: for the US, the 5-digit ZIP), never
 * the full one: providers that do not need it never send it (the Shop provider sends the country and the currency
 * only).
 */
export interface SearchQuery {
  /** The exact product the user named, if any. */
  readonly product?: string;
  /** The kind of product, if any. */
  readonly category?: string;
  readonly mustHaves: readonly string[];
  /** The most the user will spend on one item; null for no ceiling. */
  readonly budget: SearchMoney | null;
  /** ISO 3166-1 alpha-2, upper case. */
  readonly country: string;
  /** ISO 4217: the ship-to country's currency, which prices and the budget are in. */
  readonly currency: string;
  readonly postcode: string | null;
}

/** Where an offer came from: the provider's name. */
export type ProviderName = "shop";

/**
 * One offer as a provider returns it, normalized: the store (its myshopify domain and storefront origin), the product
 * and variant ids, titles, price, availability, an image and a product page, and the category words the provider
 * gave (read by the filter, never shown). This is what a later checkout needs (G6: store, variant, quantity), so the
 * gateway keeps it behind an opaque offer handle; the agent sees only the display fields.
 */
export interface SearchOffer {
  readonly provider: ProviderName;
  /** The store as the provider names it (Shop: `*.myshopify.com`). */
  readonly storeDomain: string;
  readonly storefrontOrigin: string | null;
  readonly productRef: string | null;
  readonly variantRef: string;
  readonly title: string;
  readonly variantTitle: string;
  readonly price: SearchMoney;
  readonly availability: "in_stock" | "out_of_stock";
  readonly imageUrl: string | null;
  readonly productUrl: string | null;
  readonly categories: readonly string[];
  /** False when the provider says the item ships nothing (a digital good); null when it does not say. */
  readonly requiresShipping: boolean | null;
}

/** A catalog the gateway searches directly. Each call that leaves the machine goes through the disclosure log. */
export interface SearchProvider {
  readonly name: ProviderName;
  search(query: SearchQuery): Promise<readonly SearchOffer[]>;
}
