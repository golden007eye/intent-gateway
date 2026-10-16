// The fake's built-in catalog: a few US offers from `*.example` merchants, chosen so the seed policies have
// something to act on (an electronics item, a drop-shipper, an item in a category Intent Cloud excludes).
import type { DeliveryEstimate, Merchant, Money, Rating, ReturnsPolicy, SearchRequest, TotalKind } from "../contract/index.ts";

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

const fold = (s: string): string => s.toLowerCase().trim();

/** The items a search matches: category (or a parent of it), title words, every must-have, and the budget. */
export function matches(item: CatalogItem, search: SearchRequest): boolean {
  if (search.category !== undefined) {
    const wanted = fold(search.category);
    const category = fold(item.category);
    if (category !== wanted && !category.startsWith(`${wanted}/`)) return false;
  }
  if (search.product !== undefined && !fold(item.title).includes(fold(search.product))) return false;
  const words = [...(item.tags ?? []), ...fold(item.title).split(/\s+/)].map(fold);
  if (search.must_haves?.some((m) => !words.includes(fold(m))) === true) return false;
  if (search.budget_max !== undefined && item.price.amount_minor + item.shipping.amount_minor > search.budget_max.amount_minor) {
    return false;
  }
  return true;
}
