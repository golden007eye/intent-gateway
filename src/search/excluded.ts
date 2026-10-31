// Excluded categories without Intent Cloud's catalog (decision 38, answer 23): health and medical, age-restricted
// (alcohol, tobacco, cannabis, adult, weapons), financial and digital goods. Shop's results carry no category Intent
// Cloud vetted, so the gateway drops them by the category words the provider gave and by keywords in the title.
// Best effort for the invited preview, and said so: a title that names none of these words slips through, and a
// harmless title that names one (a "wine glass") is dropped. A stronger check is due before any wider preview.
import { categoryBlocked, EXCLUDED_CATEGORIES, EXCLUDED_KEYWORDS, excludedKeyword } from "../policy/index.ts";
import type { SearchOffer } from "./types.ts";

/** The keyword lists, shared with the policy's request check (src/policy/keywords.ts). */
export { EXCLUDED_KEYWORDS };

/**
 * The excluded group an offer falls in, or null: a category word under an excluded category (`Gift Cards` reads as
 * `gift-cards`), a keyword in the title, variant title or category words, or an item the provider says ships
 * nothing (a digital good).
 */
export function excludedGroup(offer: Pick<SearchOffer, "title" | "variantTitle" | "categories" | "requiresShipping">): string | null {
  if (offer.requiresShipping === false) return "digital";
  for (const word of offer.categories) if (categoryBlocked(word, EXCLUDED_CATEGORIES)) return "category";
  return excludedKeyword([offer.title, offer.variantTitle, ...offer.categories].join(" | "));
}
