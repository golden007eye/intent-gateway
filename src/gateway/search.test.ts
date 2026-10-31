// The search seam through the gateway (G5, ADR-0021): with a linked Shop wallet, find_offers searches Shop from the
// gateway, against the fake Intent Cloud and the fake Shop over real HTTP, with the real store and disclosure log.
// The privacy property: a search sends Intent Cloud nothing, and its one Shop send is logged before it leaves
// (invariant 2). The fake answers with the buyer's identity everywhere; none of it reaches the chain or the agent
// (invariant 3).
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeCloud, startFakeCloud } from "../cloud-fake/index.ts";
import { connectCloud, connectShop, type DisclosedCloud } from "../disclosure/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { createSession, openCompleterKeys } from "../signing/index.ts";
import { openStore, type Store, verifyChain } from "../store/index.ts";
import { memoryCheckoutIds } from "../wallet/index.ts";
import { FAKE_BUYER, FAKE_STOREFRONT, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { createGateway, type FindOffersResult, type Gateway } from "./index.ts";

vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.parse("2026-10-18T12:00:00Z");
const BASE_POLICY = "version: 1\napproval: passkey\n";
const STICKERS = { category: "stickers", budget: 50, country: "US", postcode: "94107" };

interface Harness {
  gateway: Gateway;
  store: Store;
  fake: FakeCloud;
  shop: FakeShop;
  /** Searches logged as sent to Intent Cloud. */
  cloudSearches: () => number;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.reverse()) await run();
  cleanup = [];
});

async function setup(options: { policy?: string; faults?: FakeShopFaults; searchInGateway?: boolean } = {}): Promise<Harness> {
  const now = (): number => T0;
  const fake = await startFakeCloud({ now, oneTap: true });
  const shop = await startFakeShop(options.faults === undefined ? {} : { faults: options.faults });
  cleanup.push(() => fake.close(), () => shop.close());
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "search-")), "data");
  const store = await openStore(dir, { clock: now });
  cleanup.push(() => store.close());
  const session = createSession();
  const holder: { real: DisclosedCloud | null } = { real: null };
  const vaultText = JSON.stringify({ v: 1, client_id: shop.clientId, access_token: shop.accessToken, refresh_token: shop.refreshToken });
  const gateway = createGateway({
    cloud: (keySet) => {
      const real = connectCloud({ baseUrl: fake.url, session, now }, store, { keySet, now });
      holder.real = real;
      return real;
    },
    store,
    completerKeys: openCompleterKeys(dir, { now }),
    oneTap: {
      connect: (cloud) => connectShop(holder.real ?? cloud, { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText, checkoutIds: memoryCheckoutIds() }),
      searchInGateway: options.searchInGateway ?? true,
    },
    policy: loadPolicy(options.policy ?? BASE_POLICY),
    pinnedRootKeys: [fake.keys.rootPin],
    now,
    logger: { warn: () => undefined },
  });
  await gateway.start();
  // Searches logged to Intent Cloud: disclosures with no wallet destination, endpoint searchCatalog.
  const cloudSearches = (): number =>
    store.entries().filter((e) => e.kind === "disclosure" && (e.body as { destination?: string; endpoint?: string }).destination === undefined && (e.body as { endpoint?: string }).endpoint === "searchCatalog").length;
  return { gateway, store, fake, shop, cloudSearches };
}

function shopOffers(result: FindOffersResult) {
  if (result.status !== "shop_offers") throw new Error(`not Shop offers: ${result.status}: ${result.message}`);
  return result;
}

/** The disclosure entries after `fromSeq`, by destination. */
function disclosuresSince(store: Store, fromSeq: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of store.entries()) {
    if (e.seq <= fromSeq || e.kind !== "disclosure") continue;
    const body = e.body as { destination?: string; endpoint?: string };
    (out[body.destination ?? "?"] ??= []).push(String(body.endpoint));
  }
  return out;
}

describe("find_offers with a linked Shop wallet", () => {
  it("sends Intent Cloud nothing and logs exactly one Shop search before it is sent", async () => {
    const h = await setup();
    const before = h.store.entries().at(-1)?.seq ?? -1;
    const result = shopOffers(await h.gateway.findOffers(STICKERS));
    expect(h.cloudSearches()).toBe(0);
    expect(disclosuresSince(h.store, before)).toEqual({ shop: ["search_catalog"] });
    expect(h.shop.searches).toHaveLength(1);
    // Log before send: the disclosure entry precedes its response entry, and the chain verifies.
    const kinds = h.store.entries().filter((e) => e.seq > before).map((e) => e.kind);
    expect(kinds.slice(0, 2)).toEqual(["disclosure", "response"]);
    expect(verifyChain(h.store.entries()).ok).toBe(true);
    // What was sent to Shop: the text, the country and the currency, a price ceiling; no ZIP.
    expect(h.shop.searches[0]).toEqual({
      catalog: { query: "stickers", context: { address_country: "US", currency: "USD" }, filters: { price: { max: 5000 }, ships_to: { country: "US" } }, pagination: { limit: 10 } },
    });
    expect(JSON.stringify(h.shop.searches)).not.toContain(STICKERS.postcode);
    expect(result.summary).toMatch(/^Sent: Shop search_catalog \(/);
    expect(result.summary).not.toContain("searchCatalog (");
    expect(result.message).toContain("nothing was sent to Intent Cloud");
  });

  it("drops the excluded items and names only the rule", async () => {
    const h = await setup();
    const result = shopOffers(await h.gateway.findOffers(STICKERS));
    expect(result.offers.map((o) => o.title)).toEqual(["Holographic sticker", "Vinyl sticker sheet"]);
    expect(result.hidden).toBe(2);
    expect(result.message).toContain("2 more hidden by the gateway policy (categories.block, excluded_categories)");
  });

  it("keeps each offer opaque: a fresh handle and display fields only, no variant, store pairing or provider", async () => {
    const h = await setup();
    const result = shopOffers(await h.gateway.findOffers(STICKERS));
    const first = result.offers[0];
    expect(first).toEqual({
      offer_handle: expect.stringMatching(/^of_[A-Za-z0-9_-]{22}$/) as unknown,
      title: "Holographic sticker",
      variant: "Default",
      store: new URL(FAKE_STOREFRONT).host,
      price: { amount_minor: 500, currency: "USD" },
      availability: "in_stock",
      image_url: `${FAKE_STOREFRONT}/cdn/holo.png`,
      product_url: `${FAKE_STOREFRONT}/products/holographic-sticker`,
    });
    expect(JSON.stringify(result)).not.toMatch(/ProductVariant|myshopify|gid:/);
  });

  it("applies the policy: a blocked store is hidden, and a blocked category is never searched", async () => {
    const blocked = await setup({ policy: `${BASE_POLICY}merchants:\n  block: [stickers.example]\n` });
    const result = shopOffers(await blocked.gateway.findOffers(STICKERS));
    expect(result.offers.map((o) => o.title)).toEqual(["Vinyl sticker sheet"]);
    expect(result.message).toContain("merchants.block");

    const h = await setup({ policy: `${BASE_POLICY}categories:\n  block: [stickers]\n` });
    const refused = await h.gateway.findOffers(STICKERS);
    expect(refused.status).toBe("blocked");
    expect(h.shop.searches).toEqual([]);
  });

  it("attack: a product that names an excluded category is never searched at Shop either, whatever the category says", async () => {
    const h = await setup({ policy: `${BASE_POLICY}categories:\n  block: [alcohol]\n` });
    for (const product of ["single malt whisky", "craft beers"]) {
      const result = await h.gateway.findOffers({ ...STICKERS, category: "gifts", product });
      expect(result.status).toBe("blocked");
      expect(result.message).toContain("blocked category");
    }
    expect(h.shop.searches).toEqual([]);
    expect(h.cloudSearches()).toBe(0);
  });

  it("attack: identity in the input sends nothing to Shop or Intent Cloud", async () => {
    const h = await setup();
    const result = await h.gateway.findOffers({ ...STICKERS, product: `sticker for ${FAKE_BUYER.email}` });
    expect(result.status).toBe("blocked");
    expect(h.shop.searches).toEqual([]);
    expect(h.cloudSearches()).toBe(0);
  });

  it("drops the buyer's identity Shop answers with: none reaches the chain or the agent", async () => {
    const h = await setup({ faults: { identityEverywhere: true } });
    const result = shopOffers(await h.gateway.findOffers(STICKERS));
    expect(findIdentity(result)).toEqual([]);
    expect(result.offers.length).toBeGreaterThan(0);
    const chain = JSON.stringify(h.store.entries());
    for (const value of [FAKE_BUYER.email, FAKE_BUYER.phone, FAKE_BUYER.last_name]) expect(chain).not.toContain(value);
  });

  it("without an account key, refuses a cart for a Shop offer, sending nothing to Shop or Intent Cloud", async () => {
    const h = await setup();
    const result = shopOffers(await h.gateway.findOffers(STICKERS));
    const before = h.store.entries().at(-1)?.seq ?? -1;
    const cart = await h.gateway.createCart({ offer_handle: result.offers[0]?.offer_handle ?? "" });
    expect(cart.status).toBe("error");
    expect(cart.message).toContain("account key");
    expect(disclosuresSince(h.store, before)).toEqual({});
    expect(h.shop.createCount).toBe(0);
  });

  it("says plainly when Shop refuses or cannot be reached", async () => {
    const h = await setup({ faults: { toolHttpStatus: { search_catalog: 500 } } });
    const result = await h.gateway.findOffers(STICKERS);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/^Shop could not search: /);
  });
});

describe("find_offers without the search seam", () => {
  it("keeps Intent Cloud's catalog when the wallet does not search in the gateway", async () => {
    const h = await setup({ searchInGateway: false });
    const result = await h.gateway.findOffers({ category: "running-shoes", budget: 200, country: "US", postcode: "94107" });
    expect(result.status).toBe("offers");
    expect(h.cloudSearches()).toBe(1);
    expect(h.shop.searches).toEqual([]);
  });
});
