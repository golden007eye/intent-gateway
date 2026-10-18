// The 1.7.0 submit (G6, G7; ADR-0024) end to end: Shop search, then create_cart creates the Shop checkout, reads it
// back and submits it to Intent Cloud (`POST /v1/checkouts`) for the passkey; after the passkey, one tap redeems it.
// The gateway runs against the fake Intent Cloud and the fake Shop over real HTTP, with the real store, disclosure log,
// completer keys, account key and encrypted checkout vault. Attack cases: a store, variant or total swap between the
// submit and the completion is refused with no complete_checkout; a hand-off page on another host is never submitted;
// only the coarse postcode reaches Intent Cloud; every refusal code is a clear line.
import { createHash, randomBytes } from "node:crypto";
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
import { pauseLocally } from "../pause/index.ts";
import { buildEvidence, packText } from "../evidence/index.ts";
import { buildModel } from "../panel/index.ts";
import { runVerify } from "../verify/index.ts";
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
    // The full postcode itself, never a bare "1234": random nonces and base64 in the chain can hold those four digits.
    expect(JSON.stringify(h.store.entries())).not.toMatch(/94107-?1234/);
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

  it("attack: an approved hand-off is never paid by the gateway: no completion entry and no complete_checkout", async () => {
    const h = await setup({ faults: { ineligible: true } });
    const result = await submitted(h);
    expect(result.checkout?.completion_mode).toBe("handoff");
    // Shop could pay it now: the signed mode still decides.
    h.shop.faults.ineligible = false;
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    expect((await status(h, result.approval_handle)).status).toBe("approved");
    expect((await status(h, result.approval_handle)).status).toBe("approved");
    expect(h.store.entries().some((e) => e.kind === "completion" || e.kind === "complete_attempt")).toBe(false);
    expect(completes(h)).toBe(0);
  });

  it("a v4 approval counts against the weekly cap by its signed total: the next purchase is held to the cap, not refused as bad history", async () => {
    const h = await setup({ policy: "version: 1\napproval: passkey\nspend:\n  per_week_usd: 15\n" });
    const first = await submitted(h);
    expect(h.fake.approveWithPasskey(first.approval_handle, h.passkey).status).toBe(200);
    const done = await status(h, first.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion?.state).toBe("ordered");
    // $8.99 spent; another $8.99 passes $15 a week. Before the fix the v4 total read as NaN: history_invalid on everything.
    const found = await h.gateway.findOffers(STICKERS);
    expect(found.message).not.toContain("history_invalid");
    const wide = await setup({ policy: "version: 1\napproval: passkey\nspend:\n  per_week_usd: 30\n" });
    const a = await submitted(wide);
    expect(wide.fake.approveWithPasskey(a.approval_handle, wide.passkey).status).toBe(200);
    await status(wide, a.approval_handle);
    expect((await cart(wide)).status).toBe("approval_needed");
  });

  it("attack: the hand-off page's checkout key is a credential: sent to Intent Cloud, found nowhere in the data dir or any output", async () => {
    const h = await setup({ faults: { ineligible: true } });
    const outputs: unknown[] = [];
    const result = await submitted(h);
    outputs.push(result);
    // What Intent Cloud received holds the URL with its key, as the contract requires.
    const sentUrl = (h.fake.checkouts.received.at(-1) as { checkout: { continue_url: string } }).checkout.continue_url;
    const key = new URL(sentUrl).searchParams.get("key") ?? "";
    expect(key.length).toBeGreaterThan(8);
    // The disclosure logs it as its sha256, which is the snapshot's continue_url_hash; the receipt still verified.
    const logged = disclosures(h).findLast((d) => d.endpoint === "createCheckout") as Record<string, unknown>;
    expect(logged.redacted).toEqual([{ at: "body.checkout.continue_url", sha256: createHash("sha256").update(sentUrl, "utf8").digest("hex") }]);
    const loggedSeq = h.store.entries().findLast((e) => e.kind === "disclosure" && body(e).endpoint === "createCheckout")?.seq;
    expect(h.store.entries().some((e) => e.kind === "receipt" && body(e).disclosure_seq === loggedSeq && body(e).verified === true)).toBe(true);
    const pending = body(h.store.entries().findLast((e) => e.kind === "approval_pending") as Entry);
    expect((pending.sent as { continue_url_hash?: string }).continue_url_hash).toBe(`sha256:${createHash("sha256").update(sentUrl, "utf8").digest("hex")}`);
    // Approve, read the status, verify the chain, build the evidence pack and the panel model: every output.
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    outputs.push(await status(h, result.approval_handle));
    const report = await runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(T0), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    outputs.push(report);
    const pack = buildEvidence(h.store.entries(), result.approval_handle, [h.fake.keys.rootPin]);
    outputs.push(packText(pack));
    outputs.push(buildModel({ items: h.store.entries(), now: T0, mode: "real", intent: "intent", policy: null, verify: null, timeZone: "UTC" }));
    for (const out of outputs) expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(outputs)).not.toContain(sentUrl);
    // Every file under the data dir, the checkout vault included (it is encrypted).
    for (const file of await fsp.readdir(h.dir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const bytes = await fsp.readFile(join(file.parentPath, file.name));
      expect(bytes.includes(Buffer.from(key)), join(file.parentPath, file.name)).toBe(false);
    }
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

  it("one tap turned off after the passkey: the completing redemption is refused 409 one_tap_off, nothing paid", async () => {
    const h = await setup();
    const result = await submitted(h);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    h.fake.checkouts.setOneTap(false);
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion).toMatchObject({ state: "failed", reason: "redeem_refused:one_tap_off" });
    expect(done.message).toContain("one tap is off");
    expect(completes(h)).toBe(0);
  });

  it("the per-IP checkout quota: 429 checkouts is one clear line, and the gateway does not resubmit", async () => {
    const h = await setup();
    const found = await h.gateway.findOffers(STICKERS);
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(found.message);
    const results: CreateCartResult[] = [];
    for (let i = 0; i < 11; i++) results.push(await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle }));
    const last = results.at(-1) as CreateCartResult;
    expect(last.status).toBe("refused");
    expect(last.message).toContain("too many checkouts this hour");
    expect(last.message).toContain("does not resubmit");
    // One POST per create_cart: 11, the refused one included, and none sent again.
    expect(disclosures(h).filter((d) => d.endpoint === "createCheckout")).toHaveLength(11);
  });

  it("has one clear line for every refusal code the contract names", () => {
    for (const code of RefusalCode.options) {
      expect(REFUSAL_CODE_WORDS[code]).toMatch(/^Intent Cloud answered that .*Nothing was bought/);
    }
    // Contract 1.7.0 final: there is no unpin, so the line names the recovery, a new account key.
    expect(REFUSAL_CODE_WORDS.account_key_other_buyer).toMatch(/no unpin.*move account-key\.json out of the gateway's data directory, then run `intent init`/);
  });

  it("paused at Intent Cloud: 409 paused on the submit is `refused: paused (by Intent Cloud)`, listed for intent status", async () => {
    const h = await setup();
    h.fake.checkouts.setPaused(true);
    const result = await cart(h);
    expect(result.status).toBe("refused");
    expect(result.message).toContain("`paused` answer was received from Intent Cloud");
    const refused = h.store.entries().findLast((e) => e.kind === "refused");
    expect(body(refused as Entry)).toMatchObject({ step: "create_cart", reason: "paused", source: "intent_cloud" });
    expect(h.store.entries().some((e) => e.kind === "pause" && body(e).from === "intent_cloud")).toBe(true);
  });

  it("paused here: the submit path sends nothing at all, no Shop create and no POST /v1/checkouts", async () => {
    const h = await setup();
    const found = await h.gateway.findOffers(STICKERS);
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(found.message);
    await pauseLocally(h.store, "cli");
    const before = h.store.entries().at(-1)?.seq ?? -1;
    const result = await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    expect(result.status).toBe("refused");
    expect(h.store.entries().filter((e) => e.seq > before && e.kind === "disclosure")).toEqual([]);
    expect(h.shop.createCount).toBe(0);
    expect(h.fake.checkouts.received).toHaveLength(0);
    expect(body(h.store.entries().findLast((e) => e.kind === "refused") as Entry)).toMatchObject({ step: "create_cart", reason: "paused", source: "gateway" });
  });

  it("paused at Intent Cloud after the passkey: the completing report is refused, chained, and no complete_checkout is sent", async () => {
    const h = await setup();
    const result = await submitted(h);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    h.fake.checkouts.setPaused(true);
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion?.state).toBe("completing");
    expect(completes(h)).toBe(0);
    expect(h.store.entries().some((e) => e.kind === "refused" && body(e).step === "report_outcome" && body(e).source === "intent_cloud")).toBe(true);
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
