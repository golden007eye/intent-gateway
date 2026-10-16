// The fake's catalog search, forgiving the way a shop search is: case, plurals and synonyms fold; a category matches
// at any level of an item's path; a size in a must-have matches within 20%; the budget counts shipping; results
// rank by relevance, then price. Checked on demo mode's SAMPLE_CATALOG, and on DEFAULT_CATALOG for the old answers.
import { describe, expect, it } from "vitest";
import type { SearchRequest } from "../contract/index.ts";
import { EXCLUDED_CATEGORIES } from "../policy/index.ts";
import { catalogCategories, DEFAULT_CATALOG, SAMPLE_CATALOG, searchCatalog } from "./index.ts";

const SHIP = { country: "US", postal_code: "10001" } as const;
const usd = (dollars: number) => ({ amount_minor: dollars * 100, currency: "USD" as const });

function find(search: Omit<SearchRequest, "ship_to">, excluded: readonly string[] = EXCLUDED_CATEGORIES): string[] {
  return searchCatalog(SAMPLE_CATALOG, { ...search, ship_to: SHIP }, excluded).map((i) => i.title);
}

describe("the sample catalog", () => {
  it("holds about sixty sellable US offers from *.example merchants, several per category", () => {
    const sellable = SAMPLE_CATALOG.filter((i) => searchCatalog([i], { ship_to: SHIP }, EXCLUDED_CATEGORIES).length === 1);
    expect(sellable.length).toBeGreaterThanOrEqual(55);
    for (const item of SAMPLE_CATALOG) {
      expect(item.merchant.domain).toMatch(/\.example$/);
      expect(item.price.currency).toBe("USD");
    }
    const merchants = new Set(SAMPLE_CATALOG.map((i) => i.merchant.domain));
    expect(merchants.size).toBeGreaterThanOrEqual(15);
  });

  it("has items for the seed policies: electronics, drop-shippers and items over $60", () => {
    expect(SAMPLE_CATALOG.some((i) => i.category.startsWith("electronics/"))).toBe(true);
    expect(SAMPLE_CATALOG.some((i) => i.merchant.domain === "dropship.example")).toBe(true);
    expect(SAMPLE_CATALOG.some((i) => i.merchant.domain === "resale.example")).toBe(true);
    expect(SAMPLE_CATALOG.filter((i) => i.price.amount_minor + i.shipping.amount_minor > 6000).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps excluded-category items only for the baseline to refuse: none of them is ever found", () => {
    const excluded = SAMPLE_CATALOG.filter((i) => searchCatalog([i], { ship_to: SHIP }, EXCLUDED_CATEGORIES).length === 0);
    expect(excluded.map((i) => i.category.split("/")[0]).sort()).toEqual(["alcohol", "gift-cards", "health", "tobacco", "weapons"]);
    // Attack: asking for them by name, by category or with no words at all finds none of them.
    for (const search of [{ product: "wine" }, { product: "Vitamin D3 Gummies" }, { category: "alcohol" }, { product: "cigars" }, { product: "gift card" }, { product: "hunting knife" }, {}]) {
      const titles = find(search);
      for (const item of excluded) expect(titles).not.toContain(item.title);
    }
    // Without the exclusion (the test fake's default) the same search does return one, so the filter is what holds.
    expect(find({ product: "wine" }, [])).toEqual(["Cabernet Sauvignon"]);
  });

  it("names its kinds of product without the excluded ones", () => {
    const kinds = catalogCategories(SAMPLE_CATALOG, EXCLUDED_CATEGORIES);
    expect(kinds).toEqual(expect.arrayContaining(["running shoes", "water bottles", "headphones", "backpacks", "dog supplies"]));
    for (const kind of kinds) expect(kind).not.toMatch(/supplements|wine|cigars|gift cards|^knives$/);
  });
});

describe("search", () => {
  it("the developer's first prompt: a stainless water bottle around 1 liter, under $40, finds at least two", () => {
    const asked = [
      { category: "water bottles", must_haves: ["stainless", "1 liter"] },
      { category: "water-bottle", must_haves: ["stainless steel", "around 1 liter"] },
      { product: "stainless water bottle around 1 liter" },
      { product: "Stainless Steel Water Bottle", must_haves: ["1L"] },
      { category: "drinkware", product: "water bottle", must_haves: ["Stainless", "~1 litre"] },
      { category: "Water Bottles", must_haves: ["32 oz"] },
    ];
    for (const search of asked) {
      const titles = find({ ...search, budget_max: usd(40) });
      expect(titles.length, JSON.stringify(search)).toBeGreaterThanOrEqual(2);
      expect(titles, JSON.stringify(search)).toContain("Summit Insulated Water Bottle");
      // 750 ml and 12 oz are not around a liter.
      if (search.must_haves !== undefined) expect(titles).not.toContain("Trailhead Water Bottle");
    }
  });

  it("each everyday category finds something", () => {
    const categories = [
      "running shoes", "water bottles", "headphones", "coffee", "kitchen", "backpacks", "phone accessories", "books",
      "toys", "games", "home", "office supplies", "camping", "outdoor", "pet supplies", "dog", "cat", "beauty", "gifts",
    ];
    for (const category of categories) expect(find({ category }).length, category).toBeGreaterThan(0);
  });

  it("folds case, plurals and synonyms", () => {
    expect(find({ category: "SNEAKERS" })).toEqual(find({ category: "running shoes" }));
    expect(find({ category: "running-shoe" })).toEqual(find({ category: "Running Shoes" }));
    expect(find({ product: "earbuds" })).toContain("Wireless Earbuds");
    expect(find({ product: "earphones" })).toEqual(expect.arrayContaining(["Studio Headphones", "Wireless Earbuds"]));
    expect(find({ product: "rucksack" })).toContain("Everyday Backpack");
    expect(find({ product: "flask" })).toContain("Summit Insulated Water Bottle");
    expect(find({ product: "puppy toys" })).toContain("Rope Chew Toy");
    expect(find({ product: "phone covers" })).toContain("Clear Phone Case");
    expect(find({ product: "journals" })).toContain("Dot Grid Notebook");
    expect(find({ category: "lawnmowers" })).toEqual([]);
  });

  it("a category matches at any level of an item's path, and a must-have every item must have", () => {
    const drinkware = find({ category: "drinkware" });
    expect(drinkware).toEqual(expect.arrayContaining(["Ceramic Mug", "Summit Insulated Water Bottle"]));
    expect(find({ category: "kitchen" })).toEqual(expect.arrayContaining(drinkware));
    expect(find({ category: "running shoes", must_haves: ["trail"] })).toEqual(["Trail Runner 3", "Ridgeline Trail Shoe"]);
    expect(find({ category: "headphones", must_haves: ["noise cancelling"] })).toEqual(["Over-Ear Bluetooth Headphones", "Studio Headphones"]);
    expect(find({ category: "water bottles", must_haves: ["titanium"] })).toEqual([]);
  });

  it("the budget counts shipping, and results rank by relevance then price", () => {
    // Summit is $24.99 + $4.99, Everyday $18.50 free: both under $30; under $20 only Everyday.
    expect(find({ category: "water bottles", must_haves: ["stainless", "1 liter"], budget_max: usd(30) })).toEqual([
      "Everyday Stainless Water Bottle",
      "Summit Insulated Water Bottle",
    ]);
    expect(find({ category: "water bottles", must_haves: ["stainless", "1 liter"], budget_max: usd(20) })).toEqual(["Everyday Stainless Water Bottle"]);
    const totals = searchCatalog(SAMPLE_CATALOG, { category: "backpacks", ship_to: SHIP }).map((i) => i.price.amount_minor + i.shipping.amount_minor);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    // More words matched ranks first, even when dearer.
    expect(find({ category: "water bottles", product: "insulated straw" })[0]).toBe("Glacier Tumbler with Straw");
    for (const item of searchCatalog(SAMPLE_CATALOG, { budget_max: usd(15), ship_to: SHIP })) {
      expect(item.price.amount_minor + item.shipping.amount_minor).toBeLessThanOrEqual(1500);
    }
  });

  it("is deterministic", () => {
    const search = { category: "gifts", budget_max: usd(30) };
    expect(find(search)).toEqual(find(search));
  });

  it("keeps the test catalog's answers", () => {
    const titles = (s: Omit<SearchRequest, "ship_to">): string[] => searchCatalog(DEFAULT_CATALOG, { ...s, ship_to: SHIP }).map((i) => i.title);
    expect(titles({ category: "running-shoes", must_haves: ["trail"] })).toEqual(["Trail Runner 3"]);
    expect(titles({ category: "electronics" })).toEqual(["Studio Headphones"]);
    expect(titles({ product: "Studio Headphones", category: "running-shoes" })).toEqual([]);
    expect(titles({ product: "Trail Runner 3" })).toEqual(["Trail Runner 3"]);
    expect(titles({ category: "home", budget_max: usd(50) })).toEqual(["Ceramic Mug"]);
  });
});
