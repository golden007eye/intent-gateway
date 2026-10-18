// Running one search over the providers, and the opaque handle each offer is kept under.
import { randomBytes } from "node:crypto";
import { mergeOffers } from "./filter.ts";
import type { SearchOffer, SearchProvider, SearchQuery } from "./types.ts";

/** Asks each provider in turn and merges their offers (mergeOffers). A provider's failure fails the search. */
export async function searchProviders(providers: readonly SearchProvider[], query: SearchQuery): Promise<SearchOffer[]> {
  const lists: (readonly SearchOffer[])[] = [];
  for (const provider of providers) lists.push(await provider.search(query));
  return mergeOffers(lists);
}

/**
 * A new opaque offer handle (`of_` and 22 random base64url characters): it names an offer the gateway keeps in memory
 * and says nothing about the store, the variant or the provider.
 */
export function newOfferHandle(): string {
  return `of_${randomBytes(16).toString("base64url")}`;
}
