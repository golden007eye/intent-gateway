// Keywords for the excluded categories (decision 38, answer 23): health and medical, age-restricted (alcohol,
// tobacco, cannabis, adult, weapons), financial and digital goods. One list, used two ways. The search seam drops a
// Shop result whose title or category words name one anywhere (excludedKeyword, src/search/excluded.ts): that results
// screen is the enforcement. The policy refuses an outbound search early, as a courtesy, only when the obvious case is
// asked for: a product whose head noun is one (excludedHead). A modifier never refuses a search ("Bourbon vanilla
// extract" is sent, and its results are screened), since keywords cannot be both complete and precise.
// Best effort, and said so: words that name none of these slip through both.

/** Keywords per excluded group, matched as whole words (or phrases), with a plural ending, in folded text. */
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

/**
 * Nouns that name the form a product comes in, not the product: in "nicotine pouches", "CBD gummies", "vape juice" or
 * "shotgun shells" the word before one is what is bought, so the head-noun check reads that word instead.
 */
export const FORM_WORDS: readonly string[] = Object.freeze([
  "pouch", "pouches", "gummy", "gummies", "oil", "oils", "drops", "tincture", "tinctures", "pod", "pods", "juice", "juices",
  "pen", "pens", "cartridge", "cartridges", "round", "rounds", "shells", "edibles",
]);

/** NFKC, lower case, format characters dropped, so full-width `CBD` and `cbd` with a zero-width space read as `cbd`. */
export function foldText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A keyword with an optional plural ending: `wines`, `rifles`, `whiskies` (y → ies).
const variants = (word: string): string => (word.endsWith("y") ? `(?:${escape(word)}|${escape(word.slice(0, -1))}ies)` : `${escape(word)}(?:e?s)?`);
const PATTERNS: readonly [string, RegExp][] = Object.entries(EXCLUDED_KEYWORDS).map(([group, words]) => [
  group,
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(variants).join("|")})(?![\\p{L}\\p{N}])`, "u"),
]);
const HEADS: readonly [string, RegExp][] = Object.entries(EXCLUDED_KEYWORDS).map(([group, words]) => [
  group,
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(variants).join("|")})$`, "u"),
]);
const FORM = new RegExp(`[\\s-]+(?:${FORM_WORDS.map(escape).join("|")})$`, "u");

/** The excluded group a text names anywhere, as a whole word in the folded text, or null: the results screen. */
export function excludedKeyword(text: string): string | null {
  const folded = foldText(text);
  for (const [group, pattern] of PATTERNS) if (pattern.test(folded)) return group;
  return null;
}

/**
 * The folded text with trailing punctuation and trailing tokens that hold a digit dropped ("whisky 70cl" reads as
 * "whisky"), and a form noun dropped too ("CBD gummies" reads as "cbd"): what its head noun is read from.
 */
export function headText(text: string): string {
  const words = foldText(text).replace(/[^\p{L}\p{N}]+$/u, "").split(" ");
  while (words.length > 1 && /\d/.test(words.at(-1) ?? "")) words.pop();
  const head = words.join(" ").replace(/[^\p{L}\p{N}]+$/u, "");
  const formless = head.replace(FORM, "");
  return formless === "" ? head : formless;
}

/**
 * The excluded group a product's head noun is, or null: its last word or two-word phrase ("single malt whisky" →
 * whisky, "gift card"), read past a form noun ("nicotine pouches" → nicotine). A modifier never counts: "Bourbon
 * vanilla extract", "beer bread mix", "wine gums", "champagne flutes" and "shotgun microphone" are none.
 */
export function excludedHead(text: string): string | null {
  const head = headText(text);
  for (const [group, pattern] of HEADS) if (pattern.test(head)) return group;
  return null;
}
