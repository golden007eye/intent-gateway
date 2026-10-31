// Keywords for the excluded categories (decision 38, answer 23): health and medical, age-restricted (alcohol,
// tobacco, cannabis, adult, weapons), financial and digital goods. One list, used two ways. The search seam drops a
// Shop result whose title or category words name one anywhere (excludedKeyword, src/search/excluded.ts): that results
// screen is the enforcement. The policy refuses an outbound search early, as a courtesy, only when the obvious case is
// asked for: a product whose head noun is one (excludedHead). A modifier never refuses a search ("Bourbon vanilla
// extract" is sent, and its results are screened), since keywords cannot be both complete and precise.
// Best effort, and said so: words that name none of these slip through both. A few established compounds name a
// product that is none of these ("root beer", "rubbing alcohol", "candy cigarettes"): both checks read the text with
// those exact phrases taken out, so a keyword anywhere else in it still counts.

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

/**
 * Exact phrases, in folded text, whose meaning is not the excluded product their last word names; the last word may be
 * plural. Tight on purpose: each is a known product, and none unblocks its keyword elsewhere in the text. "Non-alcoholic
 * beer" is not one: it is still a beer product, sold where beer is.
 */
export const BENIGN_COMPOUNDS: readonly string[] = Object.freeze([
  "root beer", "ginger beer", "birch beer", "rubbing alcohol", "isopropyl alcohol", "wine gum", "wine vinegar",
  "candy cigarette", "chocolate cigarette", "chocolate cigar", "bubble gum cigar", "bubblegum cigar",
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
// A compound's words joined by a space or a hyphen; never one an alcoholic qualifier precedes ("hard root beer").
const COMPOUNDS = new RegExp(
  `(?<!(?:hard|alcoholic|spiked|boozy)[ -]+)(?<![\\p{L}\\p{N}])(?:${BENIGN_COMPOUNDS.map((c) => {
    const words = c.split(" ");
    return [...words.slice(0, -1).map(escape), variants(words.at(-1) ?? "")].join("[ -]");
  }).join("|")})(?![\\p{L}\\p{N}])`,
  "gu",
);
/**
 * Words that say a text is about an alcoholic drink although no keyword names it: a strength (`5.9% ABV`, `80 proof`,
 * `4% alc/vol`, `40% vol`), a spirit, beer style or brand the keyword lists leave out, or a qualifier. Where one is
 * present no compound is taken out, so "Root beer schnapps" and "Crabbie's Ginger Beer 4% ABV" read as beer. A
 * spirit the lists already name (vodka, whisky, bourbon) blocks on its own. Not here on purpose: a bare `%` (`rubbing
 * alcohol 70%`), `ale` (ginger ale) and bare `cider` (apple cider vinegar, sweet cider); `hard cider` is.
 */
const ALCOHOL_MARKERS = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:abv|alc|${[
    "rum", "rums", "gin", "gins", "moonshine", "schnapps", "liqueur", "liqueurs", "brandy", "brandies", "cognac", "mezcal",
    "scotch", "everclear", "hard cider", "lager", "lagers", "stout", "stouts", "ipa", "ipas", "mead", "sangria", "prosecco",
    "alcoholic", "spiked", "boozy", "not your father's", "crabbie's", "crabbies",
  ].map(escape).join("|")})(?![\\p{L}])|(?<![\\p{L}\\p{N}-])proof(?![\\p{L}])|%\\s*vol(?![\\p{L}])`,
  "u",
);
const FORM = new RegExp(`[\\s-]+(?:${FORM_WORDS.map(escape).join("|")})$`, "u");

/** The excluded group a text names anywhere, as a whole word in the folded text, or null: the results screen. */
export function excludedKeyword(text: string): string | null {
  const folded = withoutCompounds(text);
  for (const [group, pattern] of PATTERNS) if (pattern.test(folded)) return group;
  return null;
}

/**
 * The folded text with each benign compound taken out, leaving a space so the words around it stay apart; unchanged
 * when an alcohol marker is anywhere in it (ALCOHOL_MARKERS).
 */
export function withoutCompounds(text: string): string {
  const folded = foldText(text);
  if (ALCOHOL_MARKERS.test(folded)) return folded;
  return foldText(folded.replace(COMPOUNDS, " "));
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
 * vanilla extract", "beer bread mix", "wine gums", "champagne flutes" and "shotgun microphone" are none, nor is a benign compound ("root beer"); "root beer vodka" and "vodka and root beer" are.
 */
export function excludedHead(text: string): string | null {
  // A text that holds a compound is refused on a keyword anywhere else in it, so "vodka and root beer" never reads
  // as the head noun "and": a compound loosens nothing but its own words.
  // A compound beside an alcohol marker ("Root beer moonshine", "Everclear rubbing alcohol") is alcohol.
  const folded = foldText(text);
  if (folded.search(COMPOUNDS) !== -1 && ALCOHOL_MARKERS.test(folded)) return "alcohol";
  const stripped = withoutCompounds(text);
  if (stripped !== folded) return excludedKeyword(stripped);
  const head = headText(text);
  for (const [group, pattern] of HEADS) if (pattern.test(head)) return group;
  return null;
}
