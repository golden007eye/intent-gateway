import { describe, expect, it } from "vitest";
import { evaluate, loadPolicy, type Offer, type Outbound, type Purchase } from "./index.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const ZWSP = String.fromCodePoint(0x200b);
const policy = (body: string) => loadPolicy(`version: 1\napproval: passkey\n${body}`);
const cart = (offer: Partial<Offer> = {}): Outbound => ({
  kind: "cart",
  offer: { merchant: "shop.example", category: "home", price_usd: 20, quantity: 1, ...offer },
});
const rules = (p: ReturnType<typeof policy>, o: Outbound, h: readonly Purchase[] = []) =>
  evaluate(p, o, h, NOW).blocked.map((b) => b.rule);

describe("evaluate: carts", () => {
  it("sends an offer the policy allows", () => {
    expect(evaluate(policy(""), cart(), [], NOW)).toEqual({ send: true, blocked: [] });
  });

  it("blocks a blocked merchant and its subdomains", () => {
    const p = policy("merchants: {block: [dropship.example]}\n");
    const d = evaluate(p, cart({ merchant: "Store.Dropship.example" }), [], NOW);
    expect(d.send).toBe(false);
    expect(d.blocked).toEqual([
      { path: "offer.merchant", rule: "merchants.block", reason: 'merchant "Store.Dropship.example" is blocked' },
    ]);
    expect(rules(p, cart({ merchant: "notdropship.example" }))).toEqual([]);
  });

  it("blocks a merchant outside the allow-list", () => {
    const p = policy("merchants: {allow: [shop.example]}\n");
    expect(rules(p, cart({ merchant: "other.example" }))).toEqual(["merchants.allow"]);
    expect(rules(p, cart())).toEqual([]);
  });

  it("blocks a policy category and its subcategories, and every excluded category without any policy", () => {
    expect(rules(policy("categories: {block: [electronics]}\n"), cart({ category: "Electronics/Phones" }))).toEqual([
      "categories.block",
    ]);
    expect(rules(policy(""), cart({ category: "Gift Cards" }))).toEqual(["categories.block"]);
    expect(rules(policy(""), cart({ category: "health/vitamins" }))).toEqual(["categories.block"]);
  });

  it("enforces the per-order cap on price × quantity", () => {
    const p = policy("spend: {per_order_usd: 60}\n");
    expect(rules(p, cart({ price_usd: 60 }))).toEqual([]);
    expect(rules(p, cart({ price_usd: 60.01 }))).toEqual(["spend.per_order_usd"]);
    expect(rules(p, cart({ price_usd: 25, quantity: 3 }))).toEqual(["spend.per_order_usd"]);
  });

  it("enforces the weekly cap from the purchase history", () => {
    const p = policy("spend: {per_week_usd: 150}\n");
    const history: Purchase[] = [
      { at: NOW - 2 * DAY, total_usd: 70 },
      { at: NOW - 6 * DAY, total_usd: 60.1 },
      { at: NOW - 8 * DAY, total_usd: 500 },
    ];
    expect(rules(p, cart({ price_usd: 19.9 }), history)).toEqual([]);
    expect(rules(p, cart({ price_usd: 20 }), history)).toEqual(["spend.per_week_usd"]);
    expect(rules(p, cart({ price_usd: 20 }), history.slice(0, 1))).toEqual([]);
  });

  it("enforces the daily cap over the last 24 hours", () => {
    const p = policy("spend: {per_day_usd: 40}\n");
    expect(rules(p, cart({ price_usd: 20 }), [{ at: NOW - DAY + 1, total_usd: 20.01 }])).toEqual(["spend.per_day_usd"]);
    expect(rules(p, cart({ price_usd: 20 }), [{ at: NOW - DAY, total_usd: 39 }])).toEqual([]);
  });

  it("compares money in cents", () => {
    const p = policy("spend: {per_day_usd: 1}\n");
    expect(rules(p, cart({ price_usd: 0.3 }), [{ at: NOW, total_usd: 0.1 }, { at: NOW, total_usd: 0.6 }])).toEqual([]);
  });

  it("blocks quantities above the policy and Cloud maximum, and invalid quantities", () => {
    expect(rules(policy("quantity: {max: 1}\n"), cart({ quantity: 2 }))).toEqual(["quantity.max"]);
    expect(rules(policy(""), cart({ quantity: 4 }))).toEqual(["quantity.max"]);
    expect(rules(policy(""), cart({ quantity: 0 }))).toEqual(["quantity.max"]);
    expect(rules(policy(""), cart({ quantity: 1.5 }))).toEqual(["quantity.max"]);
  });

  it("blocks a price that is not a finite amount", () => {
    expect(rules(policy("spend: {per_order_usd: 10}\n"), cart({ price_usd: Number.NaN }))).toEqual(["offer.price_usd"]);
    expect(rules(policy(""), cart({ price_usd: -1 }))).toEqual(["offer.price_usd"]);
  });

  it("uses the current time when none is given", () => {
    const p = policy("spend: {per_day_usd: 10}\n");
    expect(evaluate(p, cart({ price_usd: 5 }), [{ at: Date.now(), total_usd: 6 }]).send).toBe(false);
  });
});

describe("evaluate: completion modes", () => {
  const withMode = (mode: unknown): Outbound => ({ ...cart(), completion_mode: mode } as Outbound);

  it("refuses a one-tap cart under a hand-off-only policy, with rule completion", () => {
    const d = evaluate(policy("completion: [handoff]\n"), withMode("one_tap"), [], NOW);
    expect(d).toEqual({
      send: false,
      blocked: [
        {
          path: "completion_mode",
          rule: "completion",
          reason: 'completion mode "one_tap" is not allowed; the policy allows handoff',
        },
      ],
    });
    expect(rules(policy("completion: [handoff]\n"), withMode("handoff"))).toEqual([]);
  });

  it("reads a cart with no mode as a hand-off", () => {
    expect(rules(policy("completion: [one_tap]\n"), cart())).toEqual(["completion"]);
    expect(rules(policy("completion: [handoff]\n"), cart())).toEqual([]);
    expect(rules(policy(""), cart())).toEqual([]);
  });

  it("sends a one-tap cart under the baseline", () => {
    expect(rules(policy(""), withMode("one_tap"))).toEqual([]);
  });

  it("refuses a mode outside the schema even under the baseline (attack)", () => {
    for (const mode of ["shop_agent", "auto", "", "HANDOFF"]) {
      expect(rules(policy(""), withMode(mode))).toEqual(["completion"]);
    }
  });
});

describe("evaluate: searches", () => {
  const search = (fields: Omit<Extract<Outbound, { kind: "search" }>, "kind">): Outbound => ({ kind: "search", ...fields });

  it("sends a US ZIP under ship_to: postcode_only", () => {
    expect(evaluate(policy("share: {ship_to: postcode_only}\n"), search({ ship_to_zip: "94110" }), [], NOW).send).toBe(
      true,
    );
  });

  it("blocks anything but a 5-digit US ZIP under postcode_only", () => {
    const p = policy("");
    for (const zip of ["94110-1234", "SW1A 1AA", "9411", "94110 Main St"]) {
      expect(evaluate(p, search({ ship_to_zip: zip }), [], NOW).blocked).toEqual([
        { path: "ship_to_zip", rule: "share.ship_to", reason: "only a 5-digit US ZIP may be shared" },
      ]);
    }
  });

  it("blocks any ship-to under ship_to: none and sends the search without one", () => {
    const p = policy("share: {ship_to: none}\n");
    expect(rules(p, search({ ship_to_zip: "94110" }))).toEqual(["share.ship_to"]);
    expect(rules(p, search({ category: "home", must_haves: ["blue"], budget_usd: 50 }))).toEqual([]);
  });

  it("blocks a blocked category and any history", () => {
    expect(rules(policy(""), search({ category: "alcohol" }))).toEqual(["categories.block"]);
    expect(rules(policy(""), search({ history: [{ item: "lamp" }] }))).toEqual(["share.history"]);
    expect(rules(policy(""), search({ history: [] }))).toEqual([]);
  });
});

describe("evaluate: a search that names a blocked category in words (invariant 1)", () => {
  const search = (fields: Omit<Extract<Outbound, { kind: "search" }>, "kind">): Outbound => ({ kind: "search", ...fields });
  const ALCOHOL = policy("categories: {block: [alcohol]}\n");

  it("refuses the category QA saw leave the machine: \"single malt whisky\" under categories.block [alcohol]", () => {
    expect(evaluate(ALCOHOL, search({ category: "single malt whisky" }), [], NOW).blocked).toEqual([
      { path: "category", rule: "categories.block", reason: "the category names alcohol, a blocked category" },
    ]);
    // The Cloud baseline excludes alcohol whatever the policy names.
    expect(rules(policy(""), search({ category: "single malt whisky" }))).toEqual(["categories.block"]);
  });

  it("attack: rephrase to get around it; the product, a must-have, plurals, case, full-width and zero-width forms are all refused", () => {
    const attempts: Omit<Extract<Outbound, { kind: "search" }>, "kind">[] = [
      { category: "gifts", product: "Islay single malt whisky" },
      { category: "gifts", product: "two single malt whiskies" },
      { category: "drinks/spirits/Whisky-Single-Malt" },
      { category: "SCOTCH WHISKY" },
      { category: "ｗｈｉｓｋｙ" },
      { category: `whis${ZWSP}ky` },
      { category: "gifts", must_haves: ["aged 12 years", "bourbon"] },
      { category: "gifts", product: "red wines" },
      { category: "kitchen", product: "whisky stones and a bottle of whisky" },
      { category: "home", product: "disposable vapes" },
      { category: "outdoors", product: "hunting rifles" },
      { category: "gifts", product: "$50 gift card" },
    ];
    for (const fields of attempts) expect(rules(ALCOHOL, search(fields)), JSON.stringify(fields)).toContain("categories.block");
  });

  it("names the field and the group, never the free text", () => {
    const d = evaluate(ALCOHOL, search({ category: "gifts", product: "Lagavulin single malt whisky", must_haves: ["peaty", "bourbon cask"] }), [], NOW);
    expect(d.blocked).toEqual([
      { path: "product", rule: "categories.block", reason: "the product names alcohol, a blocked category" },
      { path: "must_haves[1]", rule: "categories.block", reason: "the must-have names alcohol, a blocked category" },
    ]);
    expect(JSON.stringify(d)).not.toMatch(/Lagavulin|peaty/);
  });

  it("refuses the words of a category the policy itself blocks, in the product too", () => {
    const p = policy("categories: {block: [electronics, power-tools]}\n");
    expect(rules(p, search({ category: "gifts", product: "cheap electronics gadget" }))).toEqual(["categories.block"]);
    expect(rules(p, search({ category: "garden", must_haves: ["Power Tools"] }))).toEqual(["categories.block"]);
    expect(rules(p, search({ category: "gifts", product: "electronic music vinyl" }))).toEqual([]);
  });

  it("benign corpus: accessories and look-alike words are sent", () => {
    const benign: Omit<Extract<Outbound, { kind: "search" }>, "kind">[] = [
      { category: "kitchen", product: "whisky stones" },
      { category: "garden", product: "whiskey barrel planter" },
      { category: "kitchen", product: "wine glass" },
      { category: "kitchen/wine-glasses" },
      { category: "kitchen", product: "beer koozie" },
      { category: "clothing", product: "cigarette pants" },
      { category: "home", must_haves: ["vape-free", "smoke-free"] },
      { category: "toys", product: "swine plush toy" },
      { category: "books", product: "winery history" },
      { category: "running-shoes", must_haves: ["trail", "waterproof"] },
      { category: "stickers", product: "holographic sticker" },
    ];
    for (const fields of benign) expect(rules(ALCOHOL, search(fields)), JSON.stringify(fields)).toEqual([]);
  });
});

describe("evaluate: bad purchase history fails closed", () => {
  const p = policy("spend: {per_day_usd: 40}\n");
  const bad: [string, unknown][] = [
    ["a NaN total", { at: NOW, total_usd: Number.NaN }],
    ["an infinite total", { at: NOW, total_usd: Number.POSITIVE_INFINITY }],
    ["a negative total", { at: NOW, total_usd: -1000 }],
    ["a total as text", { at: NOW, total_usd: "39" }],
    ["a missing total", { at: NOW }],
    ["a NaN time", { at: Number.NaN, total_usd: 1 }],
    ["an infinite time", { at: Number.NEGATIVE_INFINITY, total_usd: 1 }],
    ["a time as text", { at: "2026-10-15", total_usd: 1 }],
    ["null", null],
    ["a number", 5],
  ];

  it.each(bad)("refuses a cart when one entry has %s", (_label, entry) => {
    const history = [entry, { at: NOW, total_usd: 39 }] as unknown as Purchase[];
    const d = evaluate(p, cart({ price_usd: 30 }), history, NOW);
    expect(d.send).toBe(false);
    expect(d.blocked).toContainEqual({
      path: "purchase_history[0]",
      rule: "history_invalid",
      reason: "a purchase needs a finite time and a finite total ≥ 0",
    });
  });

  it("refuses the review's NaN-then-39 case, which used to send", () => {
    const history = [
      { at: NOW, total_usd: Number.NaN },
      { at: NOW, total_usd: 39 },
    ];
    expect(rules(p, cart({ price_usd: 30 }), history)).toContain("history_invalid");
  });

  it("refuses a negative total even with no cap it could offset", () => {
    expect(rules(policy(""), cart(), [{ at: NOW, total_usd: -1 }])).toEqual(["history_invalid"]);
  });

  it("refuses a search too, and a history that is not a list", () => {
    const search: Outbound = { kind: "search", category: "home" };
    expect(rules(p, search, [{ at: Number.NaN, total_usd: 1 }])).toEqual(["history_invalid"]);
    expect(evaluate(p, cart(), {} as unknown as Purchase[], NOW).blocked).toEqual([
      { path: "purchase_history", rule: "history_invalid", reason: "the purchase history is not a list" },
    ]);
  });

  it("accepts a zero total and an old purchase", () => {
    expect(rules(p, cart(), [{ at: 0, total_usd: 0 }])).toEqual([]);
  });
});

describe("evaluate: order totals in cents rounded up", () => {
  it("counts 3 × $20.004 as over a $60 per-order cap", () => {
    expect(rules(policy("spend: {per_order_usd: 60}\n"), cart({ price_usd: 20.004, quantity: 3 }))).toEqual([
      "spend.per_order_usd",
    ]);
  });

  it("rounds a history total up too", () => {
    const p = policy("spend: {per_day_usd: 40}\n");
    expect(rules(p, cart({ price_usd: 20 }), [{ at: NOW, total_usd: 20.001 }])).toEqual(["spend.per_day_usd"]);
  });

  it("does not add a cent for float noise", () => {
    const p = policy("spend: {per_order_usd: 1}\n");
    expect(rules(p, cart({ price_usd: 0.07 }))).toEqual([]);
    expect(rules(p, cart({ price_usd: 0.33, quantity: 3 }))).toEqual([]);
    expect(rules(p, cart({ price_usd: 1 }))).toEqual([]);
    expect(rules(policy("spend: {per_order_usd: 60}\n"), cart({ price_usd: 20, quantity: 3 }))).toEqual([]);
  });
});

describe("evaluate: merchant names are normalized", () => {
  const p = policy("merchants: {block: [evil.com, bücher.de]}\n");
  const blockedForms = [
    "evil.com",
    "EVIL.com",
    "evil.com.",
    "evil。com",
    "ｅｖｉｌ.com",
    "shop.evil.com",
    "xn--bcher-kva.de",
    "bücher.de",
    "BÜCHER.de",
    "evil.com\u200b",
  ];
  const malformed = [
    "evil.com..",
    "evil.com:443",
    "https://evil.com",
    "evil.com/x",
    "",
    ".",
    "a..evil.com",
    "evil com",
    "*.evil.com",
    "-evil.com",
  ];

  it.each(blockedForms)("blocks %s as a blocked merchant", (merchant) => {
    expect(rules(p, cart({ merchant }))).toEqual(["merchants.block"]);
  });

  it.each(malformed)("refuses %j, which is not a bare hostname", (merchant) => {
    const d = evaluate(p, cart({ merchant }), [], NOW);
    expect(d.send).toBe(false);
    expect(d.blocked).toEqual([
      { path: "offer.merchant", rule: "offer.merchant", reason: `merchant "${merchant}" is not a hostname` },
    ]);
  });

  it("refuses an un-normalisable merchant with no merchant rules at all", () => {
    expect(rules(policy(""), cart({ merchant: "evil.com:443" }))).toEqual(["offer.merchant"]);
  });

  it("matches an allow-list on the normalized form", () => {
    const allow = policy("merchants: {allow: [bücher.de]}\n");
    expect(allow.merchants.allow).toEqual(["xn--bcher-kva.de"]);
    expect(rules(allow, cart({ merchant: "xn--bcher-kva.de" }))).toEqual([]);
    expect(rules(allow, cart({ merchant: "Shop.Bücher.de." }))).toEqual([]);
    expect(rules(allow, cart({ merchant: "evil.com" }))).toEqual(["merchants.allow"]);
    expect(rules(allow, cart({ merchant: "evil.com.." }))).toEqual(["offer.merchant"]);
  });
});

describe("evaluate: the excluded-category check normalizes categories", () => {
  const excludedForms = [
    "Alcohol & Spirits",
    "Ａlcohol",
    `alcohol${ZWSP}`,
    `alco${ZWSP}hol`,
    "alcohol>beer",
    "Beer, Alcohol",
    "Food / Alcohol",
    "  ALCOHOL  ",
    "Gift   Cards",
    "gift_cards",
  ];

  it.each(excludedForms)("blocks %j", (category) => {
    expect(rules(policy(""), cart({ category }))).toEqual(["categories.block"]);
  });

  it("does not block a part that only contains an excluded word", () => {
    expect(rules(policy(""), cart({ category: "alcohol-free drinks" }))).toEqual([]);
    expect(rules(policy(""), cart({ category: "Home & Garden" }))).toEqual([]);
  });

  it("matches a policy's own subcategory written with > or full-width letters", () => {
    const p = policy("categories: {block: [Electronics / Phones]}\n");
    expect(p.categories.block).toContain("electronics/phones");
    expect(rules(p, cart({ category: "ＥＬＥＣＴＲＯＮＩＣＳ>phones>cases" }))).toEqual(["categories.block"]);
    expect(rules(p, cart({ category: "electronics/laptops" }))).toEqual([]);
  });
});
