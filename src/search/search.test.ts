// The search seam's parts (G5): the Shop provider over a wallet's catalog, the merge, and the policy filter with its
// attack cases (a policy only narrows, invariant 1) and the excluded categories (decision 38, answer 23).
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../policy/index.ts";
import type { CatalogHit, CatalogQuery } from "../wallet/index.ts";
import { createShopProvider, excludedGroup, type FilterContext, filterOffers, MAX_OFFERS, mergeOffers, newOfferHandle, queryText, type SearchOffer, searchProviders, type SearchQuery } from "./index.ts";

const T0 = Date.parse("2026-10-18T12:00:00Z");
const POLICY = loadPolicy("version: 1\napproval: passkey\n");
const QUERY: SearchQuery = { category: "stickers", mustHaves: ["holographic"], budget: { amountMinor: 2000, currency: "USD" }, country: "US", currency: "USD", postcode: "94107" };

const hit = (over: Partial<CatalogHit> = {}): CatalogHit => ({
  storeDomain: "sticker-store.myshopify.com",
  storefrontOrigin: "https://stickers.example",
  productRef: "gid://shopify/Product/1",
  variantRef: "gid://shopify/ProductVariant/11",
  title: "Holographic sticker",
  variantTitle: "",
  price: { amountMinor: 500, currency: "USD" },
  available: true,
  imageUrl: null,
  productUrl: null,
  categories: ["stickers"],
  requiresShipping: null,
  ...over,
});
const offer = (over: Partial<SearchOffer> = {}): SearchOffer => ({ ...hit(), provider: "shop", availability: "in_stock", ...over });
const context: FilterContext = { category: "stickers", budget: { amountMinor: 2000, currency: "USD" }, currency: "USD", ceilings: null, history: [], now: T0 };

describe("the Shop provider", () => {
  it("sends the text, country and currency (never the postcode) and returns available variants only", async () => {
    const asked: CatalogQuery[] = [];
    const provider = createShopProvider({
      searchCatalog: (q) => {
        asked.push(q);
        return Promise.resolve([hit(), hit({ variantRef: "gid://shopify/ProductVariant/12", available: false })]);
      },
    });
    const offers = await provider.search(QUERY);
    expect(asked).toEqual([{ text: "stickers holographic", maxPriceMinor: 2000, currency: "USD", country: "US", limit: 10 }]);
    expect(JSON.stringify(asked)).not.toContain("94107");
    expect(offers.map((o) => o.variantRef)).toEqual(["gid://shopify/ProductVariant/11"]);
    expect(offers[0]).toMatchObject({ provider: "shop", availability: "in_stock", storeDomain: "sticker-store.myshopify.com" });
  });

  it("prefers the product over the category, sends no ceiling without a budget, and answers nothing without a catalog", async () => {
    expect(queryText({ ...QUERY, product: "Holo pack", mustHaves: [] })).toBe("Holo pack");
    expect(queryText({ ...QUERY, category: "home/kitchen_tools", mustHaves: [] })).toBe("home kitchen tools");
    const asked: CatalogQuery[] = [];
    await createShopProvider({ searchCatalog: (q) => (asked.push(q), Promise.resolve([])) }).search({ ...QUERY, budget: null });
    expect(asked[0]?.maxPriceMinor).toBeNull();
    expect(await createShopProvider({}).search(QUERY)).toEqual([]);
  });
});

describe("merge", () => {
  it("keeps provider order, drops the same store and variant twice, and caps the list", async () => {
    const a = offer();
    const twin = offer({ storeDomain: "STICKER-STORE.myshopify.com", price: { amountMinor: 1, currency: "USD" } });
    const other = offer({ storeDomain: "paper.myshopify.com" });
    expect(mergeOffers([[a, other], [twin]])).toEqual([a, other]);
    const many = Array.from({ length: MAX_OFFERS + 3 }, (_, i) => offer({ variantRef: `gid://shopify/ProductVariant/${String(i + 100)}` }));
    expect(mergeOffers([many])).toHaveLength(MAX_OFFERS);
    const merged = await searchProviders(
      [
        { name: "shop", search: () => Promise.resolve([a]) },
        { name: "shop", search: () => Promise.resolve([twin, other]) },
      ],
      QUERY,
    );
    expect(merged).toEqual([a, other]);
  });

  it("makes opaque handles that fit the offer handle form and name nothing", () => {
    const handle = newOfferHandle();
    expect(handle).toMatch(/^of_[A-Za-z0-9_-]{22}$/);
    expect(handle).not.toBe(newOfferHandle());
  });
});

describe("the policy filter", () => {
  const kept = (policy: string, o: SearchOffer, ctx = context) => filterOffers(loadPolicy(`version: 1\napproval: passkey\n${policy}`), [o], ctx);

  it("keeps an offer the policy allows", () => {
    expect(filterOffers(POLICY, [offer()], context)).toEqual({ kept: [offer()], hidden: 0, rules: [] });
  });

  it("blocks a store by either of its names", () => {
    expect(kept("merchants:\n  block: [sticker-store.myshopify.com]\n", offer()).rules).toEqual(["merchants.block"]);
    expect(kept("merchants:\n  block: [stickers.example]\n", offer()).rules).toEqual(["merchants.block"]);
  });

  it("allows a store by either name, and nothing else", () => {
    expect(kept("merchants:\n  allow: [stickers.example]\n", offer()).hidden).toBe(0);
    expect(kept("merchants:\n  allow: [sticker-store.myshopify.com]\n", offer({ storefrontOrigin: null })).hidden).toBe(0);
    expect(kept("merchants:\n  allow: [paper.example]\n", offer()).rules).toEqual(["merchants.allow"]);
  });

  it("attack: a look-alike storefront, a block-listed store behind an allowed storefront, a store with no storefront", () => {
    expect(kept("merchants:\n  allow: [stickers.example]\n", offer({ storefrontOrigin: "https://stickers.example.evil.example" })).rules).toEqual(["merchants.allow"]);
    expect(kept("merchants:\n  allow: [stickers.example]\n", offer({ storeDomain: "stickers-example.myshopify.com", storefrontOrigin: null })).rules).toEqual(["merchants.allow"]);
    const both = kept("merchants:\n  allow: [stickers.example]\n  block: [sticker-store.myshopify.com]\n", offer());
    expect(both.rules).toEqual(["merchants.block"]);
  });

  it("caps per order, per day from the history, and the budget", () => {
    expect(kept("spend:\n  per_order_usd: 4\n", offer()).rules).toEqual(["spend.per_order_usd"]);
    expect(kept("spend:\n  per_day_usd: 10\n", offer(), { ...context, history: [{ at: T0 - 1000, total_usd: 8 }] }).rules).toEqual(["spend.per_day_usd"]);
    expect(kept("", offer({ price: { amountMinor: 2001, currency: "USD" } })).rules).toEqual(["budget"]);
  });

  it("attack: another currency, a negative or fractional price, and a damaged history never pass", () => {
    expect(kept("", offer({ price: { amountMinor: 1, currency: "CAD" } })).rules).toEqual(["currency"]);
    expect(kept("", offer({ price: { amountMinor: -1, currency: "USD" } })).rules).toEqual(["currency"]);
    expect(kept("", offer({ price: { amountMinor: 1.5, currency: "USD" } })).rules).toEqual(["currency"]);
    expect(kept("", offer(), { ...context, history: [{ at: Number.NaN, total_usd: 1 }] }).rules).toEqual(["history_invalid"]);
  });

  it("blocks a policy category on the search or on the offer's own category words", () => {
    expect(kept("categories:\n  block: [stickers]\n", offer()).rules).toEqual(["categories.block"]);
    expect(kept("categories:\n  block: [toys]\n", offer({ categories: ["Toys & Games"] }), { ...context, category: "gifts" }).rules).toEqual(["categories.block"]);
  });

  it("counts what it hid and names only the rules", () => {
    const result = filterOffers(POLICY, [offer(), offer({ title: "Red wine sticker", variantRef: "gid://shopify/ProductVariant/2" }), offer({ price: { amountMinor: 1, currency: "EUR" } })], context);
    expect(result.kept).toHaveLength(1);
    expect(result.hidden).toBe(2);
    expect(result.rules).toEqual(["currency", "excluded_categories"]);
  });
});

describe("excluded categories", () => {
  const group = (over: Partial<SearchOffer>) => excludedGroup(offer(over));

  it("drops each excluded group by keyword in the title", () => {
    const cases: [string, string][] = [
      ["Vitamin D gummies", "health"],
      ["Craft beer sampler", "alcohol"],
      ["Disposable vape pen", "tobacco"],
      ["CBD calm drops", "cannabis"],
      ["Vibrator deluxe", "adult"],
      ["Rifle scope mount", "weapons"],
      ["$50 gift card", "financial"],
      ["Wedding planner printable", "digital"],
    ];
    for (const [title, expected] of cases) expect(group({ title, categories: [] }), title).toBe(expected);
  });

  it("drops by the provider's category words, and an item that ships nothing", () => {
    expect(group({ categories: ["Gift Cards"] })).toBe("category");
    expect(group({ categories: ["Health & Beauty"] })).toBe("category");
    expect(group({ requiresShipping: false })).toBe("digital");
  });

  it("attack: folded and zero-width spellings still match, while words inside other words do not", () => {
    expect(group({ title: "ＣＢＤ oil", categories: [] })).toBe("cannabis");
    expect(group({ title: "c​bd oil", categories: [] })).toBe("cannabis");
    expect(group({ title: "Swine plush toy", categories: [] })).toBeNull();
    expect(group({ title: "Holographic sticker", categories: ["stickers"] })).toBeNull();
  });

  it("keeps a benign compound whose last word is a keyword, in the title, variant or category words", () => {
    const titles = [
      "A&W Root Beer, 12 cans", "Fever-Tree ginger beer", "Birch beer soda", "Butterbeer fudge", "Rubbing alcohol 70%", "Isopropyl Alcohol 99%",
      "Retro candy cigarettes", "Milk chocolate cigars", "Bubble gum cigars, pink", "Wine gums 1kg", "Red wine vinegar", "Root-beer barrels candy",
      "A&W Root Beer 12 pack", "rubbing alcohol 70%", "70% isopropyl alcohol", "Root beer and ginger ale variety pack", "Leak-proof root beer bottle",
    ];
    for (const title of titles) expect(group({ title, categories: [] }), title).toBeNull();
    expect(group({ title: "Soda", variantTitle: "Root beer", categories: ["Root Beer"] })).toBeNull();
    const result = filterOffers(POLICY, titles.map((title, i) => offer({ title, categories: [], variantRef: `gid://shopify/ProductVariant/${String(i)}` })), context);
    expect(result.hidden).toBe(0);
  });

  it("attack: a compound beside a keyword, or behind an alcoholic qualifier, is still dropped", () => {
    const cases: [string, string][] = [
      ["Root beer vodka", "alcohol"],
      ["Root beer and vodka gift set", "alcohol"],
      ["Ginger beer and whisky set", "alcohol"],
      ["Hard root beer 6 pack", "alcohol"],
      ["Alcoholic ginger beer", "alcohol"],
      ["Non-alcoholic beer", "alcohol"],
      ["Candy cigarettes with nicotine", "tobacco"],
      ["Wine gums and red wine", "alcohol"],
      // The security review's titles: an alcohol marker means no compound is taken out.
      ["Not Your Father's Root Beer 5.9% ABV", "alcohol"],
      ["Crabbie's Ginger Beer 4% ABV", "alcohol"],
      ["Root Beer Moonshine", "alcohol"],
      ["Root beer schnapps", "alcohol"],
      ["ginger beer rum kit", "alcohol"],
      ["Everclear Rubbing Alcohol", "alcohol"],
      ["Ginger beer 4% alc/vol", "alcohol"],
      ["Root beer 5% vol", "alcohol"],
      ["80 proof root beer", "alcohol"],
    ];
    for (const [title, expected] of cases) expect(group({ title, categories: [] }), title).toBe(expected);
    expect(group({ title: "Candy cigarettes", categories: ["nicotine"] })).toBe("tobacco");
  });
});
