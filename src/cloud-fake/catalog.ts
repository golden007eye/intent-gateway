// The fake's built-in test catalog: a few US offers from `*.example` merchants, chosen so the seed policies have
// something to act on (an electronics item, a drop-shipper, an item in a category Intent Cloud excludes). Demo mode
// uses the larger SAMPLE_CATALOG (sample-catalog.ts). Both are searched the forgiving way a shop search works:
// see `searchCatalog`.
import type { CompletionMode, DeliveryEstimate, Merchant, Money, Rating, ReturnsPolicy, SearchRequest, TotalKind } from "../contract/index.ts";

export interface CatalogItem {
  /** A fixed offer handle that never expires (for vectors); without it each search mints a 30-minute handle. */
  offer_handle?: string;
  /** Not on the wire: the fake filters on it. Levels are separated by `/`. */
  category: string;
  /** Not on the wire: matched against `must_haves`. */
  tags?: readonly string[];
  /** Not on the wire: a cart for more than this gets 409. */
  stock: number;
  merchant: Merchant;
  title: string;
  variant: string;
  price: Money;
  shipping: Money;
  total_kind: TotalKind;
  availability: "in_stock" | "low_stock";
  image_url?: string;
  delivery?: DeliveryEstimate;
  rating?: Rating;
  returns?: ReturnsPolicy;
  /** 1.6.0: the merchant's variant reference; without it the fake derives a stable one (server.ts `variantRef`). */
  variant_ref?: string;
  /** 1.6.0, not on the wire: the merchant's completion modes in preference order (Intent Cloud's config). Default [handoff]. */
  completion?: readonly CompletionMode[];
}

const usd = (amount_minor: number): Money => ({ amount_minor, currency: "USD" });

export const DEFAULT_CATALOG: readonly CatalogItem[] = Object.freeze([
  {
    category: "running-shoes",
    tags: ["trail", "running"],
    stock: 10,
    merchant: { name: "Trail Supply Co", domain: "shop.example" },
    title: "Trail Runner 3",
    variant: "US 10 / Blue",
    price: usd(8999),
    shipping: usd(500),
    total_kind: "exact",
    availability: "in_stock",
    image_url: "https://images.example/p01.webp",
    delivery: { min_days: 3, max_days: 5 },
    rating: { stars_x10: 46, count: 1240 },
    returns: { free: true, days: 30 },
  },
  {
    category: "running-shoes",
    tags: ["road", "running"],
    stock: 2,
    merchant: { name: "Road Runners", domain: "runners.example" },
    title: "Road Runner 2",
    variant: "US 9 / Black",
    price: usd(6499),
    shipping: usd(0),
    total_kind: "exact",
    availability: "low_stock",
  },
  {
    // For `no-electronics`.
    category: "electronics/headphones",
    tags: ["wireless", "noise-cancelling"],
    stock: 5,
    merchant: { name: "Sound House", domain: "sound.example" },
    title: "Studio Headphones",
    variant: "Black",
    price: usd(12900),
    shipping: usd(0),
    total_kind: "exact",
    availability: "in_stock",
  },
  {
    // For `block-dropship`.
    category: "home/kitchen",
    tags: ["ceramic"],
    stock: 50,
    merchant: { name: "Resale Depot", domain: "dropship.example" },
    title: "Ceramic Mug",
    variant: "12 oz / White",
    price: usd(1200),
    shipping: usd(400),
    total_kind: "max",
    availability: "in_stock",
  },
  {
    // An excluded category (health). Intent Cloud never returns one; the fake does, so tests can show the gateway's
    // own baseline refuses it too.
    category: "health/supplements",
    tags: ["vitamin"],
    stock: 20,
    merchant: { name: "Wellness Shop", domain: "wellness.example" },
    title: "Vitamin D3 Gummies",
    variant: "60 count",
    price: usd(1499),
    shipping: usd(399),
    total_kind: "exact",
    availability: "in_stock",
  },
]);

// ---- search -------------------------------------------------------------------------------------------------------
//
// A search matches the way a shop's search box does, not literally: words are folded for case, plurals and common
// synonyms ("sneakers" finds shoes, "flask" finds bottles), a category matches at any level of an item's category
// path ("drinkware" and "water bottles" both find `kitchen/drinkware/water-bottles`), and a size in a must-have
// matches within 20% ("1 liter" finds 1 L and 32 oz bottles). Matching items are ranked by how many words they
// matched, then by price with shipping, then by title, so the same search always returns the same list.

/** Words that carry no meaning in a search ("around 1 liter", "camping gear"). */
const STOPWORDS = new Set(
  (
    "a an the and or of for with without in on to at by from my me i it its is are be that this some any " +
    "around about approximately approx roughly ish near nearly like ideally preferably maybe please " +
    "least most max maximum min minimum under over less more than up good nice great best quality cheap " +
    "inexpensive affordable budget " +
    "capacity size sized type kind style gear stuff thing item product goods equipment set new one"
  ).split(" "),
);

/** Synonyms, folded onto one word after plurals are dropped. */
const SYNONYMS: Readonly<Record<string, string>> = Object.freeze({
  sneaker: "shoe",
  trainer: "shoe",
  footwear: "shoe",
  run: "running",
  runner: "running",
  jogging: "running",
  flask: "bottle",
  canteen: "bottle",
  thermos: "bottle",
  hydration: "water",
  litre: "liter",
  steel: "stainless",
  ss: "stainless",
  earphone: "headphone",
  earbud: "headphone",
  headset: "headphone",
  cup: "mug",
  rucksack: "backpack",
  daypack: "backpack",
  knapsack: "backpack",
  bookbag: "backpack",
  cellphone: "phone",
  smartphone: "phone",
  iphone: "phone",
  android: "phone",
  cover: "case",
  cord: "cable",
  journal: "notebook",
  notepad: "notebook",
  novel: "book",
  paperback: "book",
  hardcover: "book",
  boardgame: "game",
  puppy: "dog",
  kitten: "cat",
  moisturiser: "moisturizer",
  lotion: "moisturizer",
  flashlight: "light",
  torch: "light",
  lamp: "light",
  skillet: "pan",
  frypan: "pan",
  coffeemaker: "coffee",
  espresso: "coffee",
  present: "gift",
  stocking: "gift",
  leakproof: "leak",
  wireless: "bluetooth",
  cordless: "bluetooth",
  noise: "anc",
  cancelling: "anc",
  canceling: "anc",
  kid: "kids",
  child: "kids",
  children: "kids",
  colour: "color",
  knive: "knife",
});

/** Drops a plural ending: bottles → bottle, boxes → box, batteries → battery, shoes → shoe; keeps stainless. */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

function term(word: string): string {
  const one = singular(word);
  return SYNONYMS[one] ?? SYNONYMS[word] ?? one;
}

const VOLUME =
  /(\d+(?:\.\d+)?)\s*-?\s*(fl\.?\s*oz|oz|ounces?|ml|millilit(?:er|re)s?|l|lit(?:er|re)s?)(?![a-z])/g;
const ML_PER_OZ = 29.5735;

/** Millilitres per unit: fl oz, ml or l. */
function unitOf(unit: string): number {
  if (unit.includes("oz") || unit.startsWith("ounce")) return ML_PER_OZ;
  if (unit === "ml" || unit.startsWith("milli")) return 1;
  return 1000;
}

interface Terms {
  words: string[];
  /** Volumes in millilitres ("1 liter", "32 oz"). */
  volumes: number[];
}

/** The meaningful words of a text, folded, and any volumes in it. */
function terms(text: string): Terms {
  const volumes: number[] = [];
  const rest = fold(text).replace(VOLUME, (_m, amount: string, unit: string) => {
    volumes.push(Number(amount) * unitOf(unit));
    return " ";
  });
  const words = rest
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "" && !STOPWORDS.has(w))
    .map(term)
    .filter((w) => !STOPWORDS.has(w));
  return { words, volumes };
}

interface Indexed {
  item: CatalogItem;
  /** Title, variant, tag and category-path words. */
  all: Set<string>;
  volumes: number[];
}

function index(item: CatalogItem): Indexed {
  const category = terms(item.category.replace(/[/-]/g, " "));
  const own = terms([item.title, item.variant, ...(item.tags ?? [])].join(" "));
  return {
    item,
    all: new Set([...category.words, ...own.words]),
    volumes: own.volumes,
  };
}

/** Whether at least half the words (and at least one) are found. */
function enough(found: number, of: number): boolean {
  return of === 0 || (found >= 1 && found * 2 >= of);
}

const near = (want: number, have: readonly number[]): boolean => have.some((v) => Math.abs(v - want) <= want * 0.2);

/** How well `entry` matches the search, or null when it does not. */
function score(entry: Indexed, search: SearchRequest): number | null {
  let points = 0;
  if (search.category !== undefined) {
    const { words } = terms(search.category);
    const found = words.filter((w) => entry.all.has(w)).length;
    if (!enough(found, words.length)) return null;
    points += found;
  }
  if (search.product !== undefined) {
    const { words, volumes } = terms(search.product);
    const found = words.filter((w) => entry.all.has(w)).length;
    if (!enough(found, words.length)) return null;
    points += found + volumes.filter((v) => near(v, entry.volumes)).length;
  }
  for (const must of search.must_haves ?? []) {
    const { words, volumes } = terms(must);
    // A size in a must-have is a requirement: "1 liter" rules out a 500 ml bottle.
    if (!volumes.every((v) => near(v, entry.volumes))) return null;
    const found = words.filter((w) => entry.all.has(w)).length;
    if (!enough(found, words.length)) return null;
    points += found + volumes.length;
  }
  return points;
}

/** True when `category`, or a parent level of it, is one of `excluded`. */
function excludedCategory(category: string, excluded: readonly string[]): boolean {
  const levels = fold(category).split("/");
  return levels.some((_, i) => excluded.includes(levels.slice(0, i + 1).join("/")));
}

const total = (item: CatalogItem): number => item.price.amount_minor + item.shipping.amount_minor;

/**
 * The items a search finds, best first: every given part (category, product words, each must-have) matches, the
 * price with shipping is within the budget, and the item is not in an `excluded` category (Intent Cloud never
 * returns those). With no category, product or must-have, every item within the budget matches.
 */
export function searchCatalog(catalog: readonly CatalogItem[], search: SearchRequest, excluded: readonly string[] = []): CatalogItem[] {
  const found: { item: CatalogItem; points: number }[] = [];
  for (const item of catalog) {
    if (excludedCategory(item.category, excluded)) continue;
    if (search.budget_max !== undefined && total(item) > search.budget_max.amount_minor) continue;
    const points = score(index(item), search);
    if (points !== null) found.push({ item, points });
  }
  found.sort((a, b) => b.points - a.points || total(a.item) - total(b.item) || a.item.title.localeCompare(b.item.title, "en"));
  return found.map((f) => f.item);
}

/** The leaf categories of a catalog in first-seen order, as words ("water bottles"), leaving out `excluded` ones. */
export function catalogCategories(catalog: readonly CatalogItem[], excluded: readonly string[] = []): string[] {
  const seen = new Set<string>();
  for (const item of catalog) {
    if (excludedCategory(item.category, excluded)) continue;
    seen.add((item.category.split("/").at(-1) ?? item.category).replace(/-/g, " "));
  }
  return [...seen];
}
