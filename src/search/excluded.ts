// Excluded categories without Intent Cloud's catalog (decision 38, answer 23): health and medical, age-restricted
// (alcohol, tobacco, cannabis, adult, weapons), financial and digital goods. Shop's results carry no category Intent
// Cloud vetted, so the gateway drops them by the category words the provider gave and by keywords in the title.
// Best effort for the invited preview, and said so: a title that names none of these words slips through, and a
// harmless title that names one (a "wine glass") is dropped. A stronger check is due before any wider preview.
import { categoryBlocked, EXCLUDED_CATEGORIES } from "../policy/index.ts";
import type { SearchOffer } from "./types.ts";

/** Keywords per excluded group, matched as whole words (or phrases) in the folded title and category words. */
export const EXCLUDED_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  health: ["medicine", "medication", "medical", "pharmacy", "pharmaceutical", "prescription", "supplement", "supplements", "vitamin", "vitamins", "melatonin", "ibuprofen", "painkiller", "contact lenses"],
  alcohol: ["alcohol", "wine", "beer", "vodka", "whiskey", "whisky", "bourbon", "tequila", "liquor", "champagne", "hard seltzer"],
  tobacco: ["tobacco", "cigarette", "cigarettes", "cigar", "cigars", "vape", "vapes", "vaping", "e-liquid", "nicotine", "hookah", "snus"],
  cannabis: ["cannabis", "cbd", "thc", "marijuana", "delta-8", "kratom", "hemp extract"],
  adult: ["sex toy", "vibrator", "dildo", "erotic", "porn", "xxx", "adult toy"],
  weapons: ["firearm", "firearms", "ammo", "ammunition", "rifle", "pistol", "handgun", "shotgun", "crossbow", "taser", "stun gun", "pepper spray", "switchblade", "brass knuckles"],
  financial: ["gift card", "giftcard", "e-gift", "egift", "crypto", "bitcoin", "ethereum", "nft", "voucher", "subscription"],
  digital: ["digital download", "instant download", "digital file", "digital product", "ebook", "e-book", "printable", "pdf", "svg file"],
});

/** NFKC, lower case, format characters dropped, so full-width `CBD` and `cbd` with a zero-width space read as `cbd`. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS: readonly [string, RegExp][] = Object.entries(EXCLUDED_KEYWORDS).map(([group, words]) => [
  group,
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "u"),
]);

/**
 * The excluded group an offer falls in, or null: a category word under an excluded category (`Gift Cards` reads as
 * `gift-cards`), a keyword in the title, variant title or category words, or an item the provider says ships
 * nothing (a digital good).
 */
export function excludedGroup(offer: Pick<SearchOffer, "title" | "variantTitle" | "categories" | "requiresShipping">): string | null {
  if (offer.requiresShipping === false) return "digital";
  for (const word of offer.categories) if (categoryBlocked(word, EXCLUDED_CATEGORIES)) return "category";
  const text = fold([offer.title, offer.variantTitle, ...offer.categories].join(" | "));
  for (const [group, pattern] of PATTERNS) if (pattern.test(text)) return group;
  return null;
}
