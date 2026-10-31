// Keywords for the excluded categories (decision 38, answer 23): health and medical, age-restricted (alcohol,
// tobacco, cannabis, adult, weapons), financial and digital goods. One list, used twice: the search seam drops a Shop
// result whose title or category words name one (src/search/excluded.ts), and the policy refuses an outbound search
// whose category, product or must-haves name one, so the request itself never leaves (invariant 1).
// Best effort, and said so: words that name none of these slip through.

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
 * Words that, right after a keyword, make it name an accessory and not the excluded good: a "wine glass", "whisky
 * stones", a "whiskey barrel planter", a "beer koozie", "cigarette pants", "vape-free". Used by the request check
 * only, and only for the occurrence they follow: "whisky stones and a bottle of whisky" still names whisky.
 */
export const ACCESSORY_WORDS: readonly string[] = Object.freeze([
  "glass", "glasses", "stone", "stones", "barrel", "barrels", "rack", "racks", "opener", "openers", "koozie", "koozies",
  "decanter", "decanters", "aerator", "aerators", "mug", "mugs", "stein", "steins", "tumbler", "tumblers", "chiller",
  "chillers", "pants", "jeans", "free",
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
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(variants).join("|")})(?![\\p{L}\\p{N}])`, "gu"),
]);
const ACCESSORY = new RegExp(`^[\\s-]+(?:${ACCESSORY_WORDS.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "u");

/**
 * The excluded group a text names, or null: a keyword as a whole word in the folded text. With `accessories`, an
 * occurrence followed by an accessory word (ACCESSORY_WORDS) does not count; any other occurrence still does.
 */
export function excludedKeyword(text: string, options: { readonly accessories?: boolean } = {}): string | null {
  const folded = foldText(text);
  for (const [group, pattern] of PATTERNS) {
    for (const match of folded.matchAll(pattern)) {
      if (options.accessories === true && ACCESSORY.test(folded.slice(match.index + match[0].length))) continue;
      return group;
    }
  }
  return null;
}
