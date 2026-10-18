// The 1.7.0 submit (G6, G7; ADR-0024) end to end: Shop search, then create_cart creates the Shop checkout, reads it
// back and submits it to Intent Cloud (`POST /v1/checkouts`) for the passkey; after the passkey, one tap redeems it.
// The gateway runs against the fake Intent Cloud and the fake Shop over real HTTP, with the real store, disclosure log,
// completer keys, account key and encrypted checkout vault. Attack cases: a store, variant or total swap between the
// submit and the completion is refused with no complete_checkout; a hand-off page on another host is never submitted;
// only the coarse postcode reaches Intent Cloud; every refusal code is a clear line.
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAccountKey } from "../account/index.ts";
import { type FakeCloud, SoftPasskey, startFakeCloud } from "../cloud-fake/index.ts";
import { connectCloud, connectShop, connectStorefront, type DisclosedCloud } from "../disclosure/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { createSession, openCompleterKeys } from "../signing/index.ts";
import { type Entry, openStore, type Store, verifyChain } from "../store/index.ts";
import { createFakeStorefront, type FakeStorefront } from "../storefront-fake/index.ts";
import { openCheckoutVault, WalletKey } from "../wallet/index.ts";
import { FAKE_BUYER, FAKE_OTHER_VARIANT, FAKE_STORE, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { RefusalCode } from "../contract/index.ts";
import { type ApprovalStatusResult, type CreateCartResult, createGateway, type Gateway } from "./index.ts";
import { REFUSAL_CODE_WORDS } from "./gateway.ts";

vi.setConfig({ testTimeout: 60_000 });

const T0 = Date.parse("2026-10-18T12:00:00Z");
const BASE_POLICY = "version: 1\napproval: passkey\n";
const STICKERS = { category: "stickers", budget_usd: 50, zip: "94107" };

interface Harness {
  gateway: Gateway;
  store: Store;
  fake: FakeCloud;
  shop: FakeShop;
  storefront: FakeStorefront;
  passkey: SoftPasskey;
  dir: string;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.reverse()) await run();
  cleanup = [];
});

async function setup(options: { faults?: FakeShopFaults; policy?: string } = {}): Promise<Harness> {
  const now = (): number => T0;
  const fake = await startFakeCloud({ now, oneTap: true });
  const shop = await startFakeShop(options.faults === undefined ? {} : { faults: options.faults });
  cleanup.push(() => fake.close(), () => shop.close());
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "checkout-v4-")), "data");
  const store = await openStore(dir, { clock: now });
  cleanup.push(() => store.close());
  const session = createSession();
  const holder: { real: DisclosedCloud | null } = { real: null };
  const vaultText = JSON.stringify({ v: 1, client_id: shop.clientId, access_token: shop.accessToken, refresh_token: shop.refreshToken });
  const checkoutIds = await openCheckoutVault(dir, "shop", new WalletKey(randomBytes(32), "test"), now);
  const storefront = createFakeStorefront({ "stickers.example": FAKE_STORE });
  const gateway = createGateway({
    cloud: (keySet) => {
      holder.real = connectCloud({ baseUrl: fake.url, session, now }, store, { keySet, now });
      return holder.real;
    },
    store,
    completerKeys: openCompleterKeys(dir, { now }),
    oneTap: {
      connect: (cloud) => connectShop(holder.real ?? cloud, { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText, checkoutIds }),
      storefront: (cloud) => connectStorefront(holder.real ?? cloud, storefront.transport),
      searchInGateway: true,
    },
    accountKey: async () => (await ensureAccountKey(dir)).key,
    policy: loadPolicy(options.policy ?? BASE_POLICY),
    pinnedRootKeys: [fake.keys.rootPin],
    now,
    logger: { warn: () => undefined },
  });
  await gateway.start();
  return { gateway, store, fake, shop, storefront, passkey: new SoftPasskey(), dir };
}

async function cart(h: Harness): Promise<CreateCartResult> {
  const found = await h.gateway.findOffers(STICKERS);
  if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(`no Shop offers: ${found.message}`);
  return h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
}

async function submitted(h: Harness) {
  const result = await cart(h);
  if (result.status !== "approval_needed") throw new Error(`no approval: ${result.status}: ${result.message}`);
  return result;
}

const status = (h: Harness, handle: string): Promise<ApprovalStatusResult> => h.gateway.getApprovalStatus({ approval_handle: handle });
const body = (e: Entry): Record<string, unknown> => e.body as Record<string, unknown>;
const disclosures = (h: Harness): Record<string, unknown>[] => h.store.entries().filter((e) => e.kind === "disclosure").map(body);
const sentBody = (d: Record<string, unknown>): string => (typeof d.body_b64 === "string" ? Buffer.from(d.body_b64, "base64").toString("utf8") : "");
const completes = (h: Harness): number => disclosures(h).filter((d) => d.endpoint === "complete_checkout").length;

describe("create_cart with a linked Shop wallet: the 1.7.0 submit", () => {
  it("creates the Shop checkout, reads it back and submits it (logged before it leaves); one tap then orders it", async () => {
    const h = await setup();
    const result = await submitted(h);
    expect(result.checkout).toMatchObject({ store: "stickers.example", quantity: 1, currency: "USD", completion_mode: "shop_agent", ship_to: { country: "US", postal_code_coarse: "94107" } });
    expect(result.checkout?.totals).toEqual({ subtotal: 500, shipping: 399, tax: 0, total: 899 });
    // Order of sends: create_checkout, get_checkout and get_account (the budget) to Shop, then createCheckout to
    // Intent Cloud; each logged first.
    const order = disclosures(h).map((d) => `${typeof d.destination === "string" ? d.destination : "cloud"}:${String(d.endpoint)}`);
    expect(order.filter((o) => !o.endsWith("getMeta") && !o.endsWith("getKeyStatement"))).toEqual(["shop:search_catalog", "shop:create_checkout", "shop:get_checkout", "shop:get_account", "cloud:createCheckout"]);
    const pending = h.store.entries().findLast((e) => e.kind === "approval_pending");
    expect(body(pending as Entry)).toMatchObject({ handle: result.approval_handle, total_minor: 899, completion_mode: "shop_agent", sent: { contract_version: "1.7.0" } });
    expect(verifyChain(h.store.entries()).ok).toBe(true);

    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion).toMatchObject({ state: "ordered", source: "shop_api" });
    expect(completes(h)).toBe(1);
    // No Shop checkout was created after the approval: the passkey signed the one submitted.
    expect(disclosures(h).filter((d) => d.endpoint === "create_checkout")).toHaveLength(1);
    expect(verifyChain(h.store.entries()).ok).toBe(true);
  });

  it("sends the account key in every submit, and the snapshot signs its thumbprint", async () => {
    const h = await setup();
    await submitted(h);
    await submitted(h);
    const key = (await ensureAccountKey(h.dir)).key;
    expect(h.fake.checkouts.received).toHaveLength(2);
    for (const r of h.fake.checkouts.received) expect((r as { account_key?: unknown }).account_key).toEqual(key.publicJwk);
  });

  it("puts only the country and the coarse postcode on the wire: no outbound body holds the full postcode", async () => {
    const h = await setup({ faults: { shipToZip: "94107-1234" } });
    const result = await submitted(h);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    await status(h, result.approval_handle);
    const cloudBodies = disclosures(h).filter((d) => d.destination === undefined).map(sentBody);
    expect(cloudBodies.some((b) => b.includes('"postal_code":"94107"'))).toBe(true);
    for (const b of disclosures(h).map(sentBody)) expect(b).not.toMatch(/94107-?1234/);
    expect(JSON.stringify(h.store.entries())).not.toContain("1234");
    for (const value of [FAKE_BUYER.email, FAKE_BUYER.last_name, FAKE_BUYER.phone]) expect(JSON.stringify(h.store.entries())).not.toContain(value);
  });

  it("attack: a variant swap between the submit and the completion is a mismatch, and no complete_checkout is sent", async () => {
    const h = await setup();
    const result = await submitted(h);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    h.shop.faults.viewVariant = FAKE_OTHER_VARIANT;
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "precheck:line" });
    expect(completes(h)).toBe(0);
  });

  it("attack: a total swap between the submit and the completion is refused, and no complete_checkout is sent", async () => {
    const h = await setup();
    const result = await submitted(h);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    h.shop.faults.totalAboveMinor = 100;
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion).toMatchObject({ state: "failed", reason: "precheck:total" });
    expect(completes(h)).toBe(0);
  });

  it("attack: a store swap in the snapshot (another myshopify domain) fails step 7, and nothing is completed", async () => {
    const h = await setup();
    const result = await submitted(h);
    h.fake.tamper.proofSnapshot({ myshopify_domain: "other-shop.myshopify.com" });
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    const done = await status(h, result.approval_handle);
    expect(done.status).toBe("not_verified");
    expect(done.message).toContain("could not be verified");
    expect(completes(h)).toBe(0);
  });

  it("attack: a snapshot that is not the submitted checkout is refused before the passkey", async () => {
    const h = await setup();
    h.fake.tamper.snapshot({ totals: { subtotal: 1, shipping: 0, tax: 0, total: 1 } });
    const result = await cart(h);
    expect(result.status).toBe("refused");
    expect(result.message).toContain("totals are not the submitted totals");
    expect(h.store.entries().filter((e) => e.kind === "approval_pending")).toHaveLength(0);
  });

  it("hands off to Shop's page on the store's own domain, with a new approval in mode handoff, when one tap cannot pay", async () => {
    const h = await setup({ faults: { ineligible: true } });
    const result = await submitted(h);
    expect(result.checkout?.completion_mode).toBe("handoff");
    const request = h.fake.checkouts.received.at(-1) as { completion_mode: string; checkout: { continue_url?: string } };
    expect(request.completion_mode).toBe("handoff");
    expect(new URL(request.checkout.continue_url ?? "").host).toBe(FAKE_STORE);
  });

  it("attack: a hand-off page on another host is never submitted", async () => {
    const h = await setup({ faults: { ineligible: true, continueUrlHost: "shop.app.evil.example" } });
    const result = await cart(h);
    expect(result.status).toBe("blocked");
    expect(h.fake.checkouts.received).toHaveLength(0);
    expect(disclosures(h).some((d) => d.endpoint === "createCheckout")).toBe(false);
  });

  it("refuses a Shop address in another ZIP than the search's, sending Intent Cloud nothing", async () => {
    const h = await setup({ faults: { shipToZip: "10001" } });
    const result = await cart(h);
    expect(result.status).toBe("refused");
    expect(result.message).toContain("another ZIP");
    expect(h.fake.checkouts.received).toHaveLength(0);
  });

  it("refuses a currency the table does not list, locally, naming the table version", async () => {
    // A gateway started against a CAD-only table: the USD checkout is refused before any submit.
    const g = await setupWithTable({ CAD: { order: 50000, week: 100000 } });
    const result = await cart(g);
    expect(result.status).toBe("refused");
    expect(result.message).toMatch(/USD, which the currency table Intent Cloud returns \(ct-[0-9a-f]{16}\) does not list/);
    expect(g.fake.checkouts.received).toHaveLength(0);
    const blocked = g.store.entries().findLast((e) => e.kind === "block");
    expect(body(blocked as Entry).held).toMatchObject({ currency: "USD", currency_table: expect.stringMatching(/^ct-/) as unknown });
  });

  it.each([
    ["store_blocked", (h: Harness) => {
      h.fake.checkouts.blockStores([FAKE_STORE]);
    }, "block list"],
    [
      "one_tap_off",
      (h: Harness) => {
        h.fake.checkouts.setOneTap(false);
      },
      "one tap is off",
    ],
  ] as const)("maps refusal %s to a clear line, nothing bought", async (code, arrange, words) => {
    const h = await setup();
    arrange(h);
    const result = await cart(h);
    expect(result.status).toBe("refused");
    expect(result.message).toContain(`Refused: ${code}.`);
    expect(result.message).toContain(words);
    expect(result.message).toContain("Nothing was bought");
    expect(h.store.entries().filter((e) => e.kind === "approval_pending")).toHaveLength(0);
  });

  it("maps ceiling_order at the submit to a clear line, with no approval pending", async () => {
    const g = await setupWithTable({ USD: { order: 100, week: 100000 } });
    const result = await cart(g);
    expect(result.status).toBe("refused");
    expect(result.message).toMatch(/^Refused: ceiling_order\. .*per-order ceiling/);
    expect(g.store.entries().filter((e) => e.kind === "approval_pending")).toHaveLength(0);
  });

  it("has one clear line for every refusal code the contract names", () => {
    for (const code of RefusalCode.options) {
      expect(REFUSAL_CODE_WORDS[code]).toMatch(/^Intent Cloud answered that .*Nothing was bought/);
    }
  });

  it("paused: 409 paused is `refused: paused`", async () => {
    const h = await setup();
    h.fake.checkouts.setPaused(true);
    const result = await cart(h);
    expect(result.status).toBe("refused");
    expect(result.message).toMatch(/^Refused: paused\. /);
  });

  it("a 409 ceiling at the completing report is a refusal before payment: no complete_checkout, a clear line", async () => {
    const h = await setup();
    const result = await submitted(h);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    h.fake.checkouts.setCurrencies({ USD: { order: 100, week: 100000 } });
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion).toMatchObject({ state: "failed", reason: "redeem_refused:ceiling_order" });
    expect(done.message).toContain("per-order ceiling");
    expect(completes(h)).toBe(0);
  });

  it("identity never reaches the chain or the agent, though Shop answers with it everywhere", async () => {
    const h = await setup({ faults: { identityEverywhere: true } });
    const result = await submitted(h);
    expect(findIdentity(result)).toEqual([]);
    const chain = JSON.stringify(h.store.entries());
    for (const value of [FAKE_BUYER.email, FAKE_BUYER.phone, FAKE_BUYER.last_name]) expect(chain).not.toContain(value);
  });
});

/** A gateway whose fake Intent Cloud serves `currencies` from the start. */
async function setupWithTable(currencies: Record<string, { order: number; week: number }>): Promise<Harness> {
  const now = (): number => T0;
  const fake = await startFakeCloud({ now, oneTap: true, currencies });
  const shop = await startFakeShop({});
  cleanup.push(() => fake.close(), () => shop.close());
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "checkout-v4-")), "data");
  const store = await openStore(dir, { clock: now });
  cleanup.push(() => store.close());
  const session = createSession();
  const holder: { real: DisclosedCloud | null } = { real: null };
  const vaultText = JSON.stringify({ v: 1, client_id: shop.clientId, access_token: shop.accessToken, refresh_token: shop.refreshToken });
  const storefront = createFakeStorefront({ "stickers.example": FAKE_STORE });
  const checkoutIds = await openCheckoutVault(dir, "shop", new WalletKey(randomBytes(32), "test"), now);
  const gateway = createGateway({
    cloud: (keySet) => {
      holder.real = connectCloud({ baseUrl: fake.url, session, now }, store, { keySet, now });
      return holder.real;
    },
    store,
    completerKeys: openCompleterKeys(dir, { now }),
    oneTap: {
      connect: (cloud) => connectShop(holder.real ?? cloud, { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText, checkoutIds }),
      storefront: (cloud) => connectStorefront(holder.real ?? cloud, storefront.transport),
      searchInGateway: true,
    },
    accountKey: async () => (await ensureAccountKey(dir)).key,
    policy: loadPolicy(BASE_POLICY),
    pinnedRootKeys: [fake.keys.rootPin],
    now,
    logger: { warn: () => undefined },
  });
  await gateway.start();
  return { gateway, store, fake, shop, storefront, passkey: new SoftPasskey(), dir };
}
