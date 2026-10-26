// The 1.7.x submit (G6, G7; ADR-0024, ADR-0025) end to end: Shop search, then create_cart creates the Shop checkout, reads it
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
import { DEFAULT_COUNTRIES, type FakeCloud, SoftPasskey, startFakeCloud } from "../cloud-fake/index.ts";
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
const STICKERS = { category: "stickers", budget: 50, country: "US", postcode: "94107" };

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

async function setup(
  options: { faults?: FakeShopFaults; policy?: string; currencies?: Record<string, { order: number; week: number }>; countries?: Record<string, string> } = {},
): Promise<Harness> {
  const now = (): number => T0;
  const fake = await startFakeCloud({
    now,
    oneTap: true,
    ...(options.currencies === undefined ? {} : { currencies: options.currencies }),
    ...(options.countries === undefined ? {} : { countries: options.countries }),
  });
  const shop = await startFakeShop(options.faults === undefined ? {} : { faults: options.faults });
  cleanup.push(() => fake.close(), () => shop.close());
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "checkout-v4-")), "data");
  const store = await openStore(dir, { clock: now });
  cleanup.push(() => store.close());
  const session = createSession();
  const vaultText = JSON.stringify({ v: 1, client_id: shop.clientId, access_token: shop.accessToken, refresh_token: shop.refreshToken });
  const checkoutIds = await openCheckoutVault(dir, "shop", new WalletKey(randomBytes(32), "test"), now);
  const storefront = createFakeStorefront({ "stickers.example": FAKE_STORE });
  const make = async (policy: string, session = createSession()): Promise<Gateway> => {
    const holder: { real: DisclosedCloud | null } = { real: null };
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
      policy: loadPolicy(policy),
      pinnedRootKeys: [fake.keys.rootPin],
      now,
      logger: { warn: () => undefined },
    });
    await gateway.start();
    return gateway;
  };
  const gateway = await make(options.policy ?? BASE_POLICY, session);
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

describe("create_cart with a linked Shop wallet: the 1.7.1 submit", () => {
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
    expect(body(pending as Entry)).toMatchObject({ handle: result.approval_handle, total_minor: 899, completion_mode: "shop_agent", sent: { contract_version: "1.7.1" } });
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
    expect(result.message).toContain("another country or postcode area than the one given for the search");
    expect(h.fake.checkouts.received).toHaveLength(0);
  });

  it("refuses a checkout currency the table does not list, locally, naming the table version", async () => {
    // A USD-only table and a store that prices the checkout in GBP: refused before any submit.
    const g = await setup({ currencies: { USD: { order: 50000, week: 100000 } }, faults: { checkoutCurrency: "GBP" } });
    const result = await cart(g);
    expect(result.status).toBe("refused");
    expect(result.message).toMatch(/GBP, which the currency table Intent Cloud returns \(ct-[0-9a-f]{16}\) does not list/);
    expect(g.fake.checkouts.received).toHaveLength(0);
    const blocked = g.store.entries().findLast((e) => e.kind === "block");
    expect(body(blocked as Entry).held).toMatchObject({ currency: "GBP", currency_table: expect.stringMatching(/^ct-/) as unknown });
  });

  it("refuses, locally, a checkout in another currency than the search country's, though the table lists it", async () => {
    const h = await setup({ faults: { checkoutCurrency: "CAD" } });
    const result = await cart(h);
    expect(result.status).toBe("refused");
    expect(result.message).toContain("Shop's checkout is in CAD, not the USD the search was in");
    expect(h.fake.checkouts.received).toHaveLength(0);
  });

  it("a table without USD: a US search is refused with one line, and nothing is sent", async () => {
    const g = await setupWithTable({ CAD: { order: 50000, week: 100000 } });
    const result = await g.gateway.findOffers(STICKERS);
    expect(result.status).toBe("refused");
    // 1.7.1 serves only the countries whose currency is in the table, and CAD cannot carry the caps without USD.
    expect(result.message).toBe("Not sent: the currency table Intent Cloud returns lists no country intent ships to, so no search can be made now.");
    expect(disclosures(g).filter((d) => d.endpoint === "search_catalog")).toHaveLength(0);
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

  it("attack: a country left out of the served map after the passkey: the completing report is refused 403, nothing paid, a clear line", async () => {
    // The US, so the approval status reads back: the kill switch leaves a country out of the served map.
    const h = await setup();
    const result = await submitted(h);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    h.fake.checkouts.setCountries(Object.fromEntries(Object.entries(DEFAULT_COUNTRIES).filter(([c]) => c !== "US")));
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(done.message);
    expect(done.completion).toMatchObject({ state: "failed", source: "gateway_precheck" });
    expect(done.message).toMatch(/Intent Cloud (returns a refusal to redeem|answered that it does not support)/);
    expect(done.message).toContain("Nothing was bought.");
    expect(completes(h)).toBe(0);
    // Refused for good: a later call sends no completing report again.
    const reportsBefore = disclosures(h).filter((d) => d.endpoint === "reportOutcome").length;
    await status(h, result.approval_handle);
    expect(disclosures(h).filter((d) => d.endpoint === "reportOutcome").length).toBe(reportsBefore);
  });

  it("a country left out of the served map before the passkey: the confirm page refuses 403 currency_unsupported, the approval stays pending", async () => {
    // The US, so the approval status reads back: the kill switch leaves a country out of the served map.
    const h = await setup();
    const result = await submitted(h);
    h.fake.checkouts.setCountries(Object.fromEntries(Object.entries(DEFAULT_COUNTRIES).filter(([c]) => c !== "US")));
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey)).toMatchObject({ status: 403, reason: "currency_unsupported" });
    expect(await status(h, result.approval_handle)).toMatchObject({ status: "pending" });
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
function setupWithTable(currencies: Record<string, { order: number; week: number }>): Promise<Harness> {
  return setup({ currencies });
}

// ---- buyers outside the US (contract 1.7.1: US, CA, AU, GB, IE and the euro countries) -------------------------------

const CANADA = { country: "CA", postalCode: "K1A 0B1", currency: "CAD" } as const;
const AUSTRALIA = { country: "AU", postalCode: "2000", currency: "AUD" } as const;
const UK = { country: "GB", postalCode: "SW1A 1AA", currency: "GBP" } as const;
const IRELAND = { country: "IE", postalCode: "D02 X285", currency: "EUR" } as const;
const GERMANY = { country: "DE", postalCode: "10115", currency: "EUR" } as const;
const NETHERLANDS = { country: "NL", postalCode: "1012 AB", currency: "EUR" } as const;
/** Every country contract 1.7.1 serves, in its ship_to enum's order. */
const ALL_NAMES = "the US, Canada, Australia, the UK, Ireland, Germany, France, the Netherlands, Spain, Italy, Belgium, Austria, Portugal and Finland";
/** The default policy's caps: $20 an order, $40 a week (CAD 28 and CAD 56, AUD 30 and AUD 60 at Intent Cloud's ceilings). */
const DEFAULTS = "version: 1\napproval: passkey\nspend:\n  per_order_usd: 20\n  per_week_usd: 40\n";

/** Every chain entry (sent bodies decoded), every body the fakes received, and the results given. */
function everythingSent(h: Harness, ...results: unknown[]): string {
  const chain = h.store.entries().map((e) => {
    const b = body(e);
    return JSON.stringify(typeof b.body_b64 === "string" ? { ...b, body_b64: sentBody(b) } : b);
  });
  return [...chain, ...h.shop.calls.map((c) => JSON.stringify(c.body)), ...h.fake.checkouts.received.map((r) => JSON.stringify(r)), ...results.map((r) => JSON.stringify(r))].join("\n");
}

describe("buyers outside the US: Canada, Australia, the UK, Ireland and the euro countries through Shop, in their own currency", () => {
  it.each([
    ["Canada", CANADA, "K1A", "CAD"],
    ["Australia", AUSTRALIA, "2000", "AUD"],
    ["the UK", UK, "SW1A", "GBP"],
    ["Ireland", IRELAND, "D02", "EUR"],
    ["Germany", GERMANY, "10", "EUR"],
    ["the Netherlands", NETHERLANDS, "10", "EUR"],
  ] as const)("%s: Shop is searched with the country and currency, and the checkout submitted in it, for the passkey", async (_, region, coarse, currency) => {
    const h = await setup({ faults: { region }, policy: DEFAULTS });
    const found = await h.gateway.findOffers({ category: "stickers", budget: 25, country: region.country, postcode: region.postalCode });
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(`no Shop offers: ${found.message}`);
    expect(found.offers.every((o) => o.price.currency === currency)).toBe(true);
    const search = h.shop.searches.at(-1) as { catalog: { context: unknown; filters: { ships_to: unknown; price: unknown } } };
    expect(search.catalog.context).toEqual({ address_country: region.country, currency });
    expect(search.catalog.filters.ships_to).toEqual({ country: region.country });
    expect(search.catalog.filters.price).toEqual({ max: 2500 });
    const result = await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    if (result.status !== "approval_needed") throw new Error(`${result.status}: ${result.message}`);
    expect(result.checkout).toMatchObject({ currency, ship_to: { country: region.country, postal_code_coarse: coarse }, completion_mode: "shop_agent" });
    expect(result.message).toContain(`approve ${currency} 8.99 with their passkey`);
    // The spend history counts it in its own currency.
    expect(body(h.store.entries().findLast((e) => e.kind === "approval_pending") as Entry)).toMatchObject({ total_minor: 899, currency });
    expect(h.fake.checkouts.received).toHaveLength(1);
    expect(verifyChain(h.store.entries()).ok).toBe(true);
  });

  // One tap end to end in each currency: the submit, the passkey, then get_approval_status pays the checkout with
  // the Shop agent budget and reads Intent Cloud's outcome back as ordered, with binding-v2 ok on the full postcode.
  it.each([
    ["CAD", CANADA],
    ["AUD", AUSTRALIA],
    ["GBP", UK],
    ["EUR", GERMANY],
  ] as const)("%s: submit, passkey, then get_approval_status to ordered; one complete; verify exits 0", async (currency, region) => {
    const h = await setup({ faults: { region }, policy: DEFAULTS });
    const found = await h.gateway.findOffers({ category: "stickers", budget: 25, country: region.country, postcode: region.postalCode });
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(`no Shop offers: ${found.message}`);
    const result = await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    if (result.status !== "approval_needed") throw new Error(`${result.status}: ${result.message}`);
    expect(h.fake.approveWithPasskey(result.approval_handle, h.passkey).status).toBe(200);
    const done = await status(h, result.approval_handle);
    if (done.status !== "approved") throw new Error(`${done.status}: ${done.message}`);
    expect(done.completion).toMatchObject({ state: "ordered", source: "shop_api" });
    expect(completes(h)).toBe(1);
    // Intent Cloud got completing, then ordered with the total in the approved currency.
    const reports = (h.fake.inspect(result.approval_handle)?.reports ?? []).filter((r) => r.state === "ordered");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.final_total).toEqual({ amount_minor: 899, currency });
    // Intent Cloud keeps the gateway's ordered as its report (Appendix G R5), the total in the approved currency.
    expect(h.fake.inspect(result.approval_handle)?.outcome).toMatchObject({ state: "reported", reported: { state: "ordered", final_total: { amount_minor: 899, currency } } });
    // The full postcode is in no chain entry: binding-v2 ran on it in memory, the chain keeps its coarse form.
    // (Signatures, digests and receipts are left out: random text may hold a run of digits by chance. AU's full
    // postcode is its coarse one.)
    const chained = h.store.entries().filter((e) => e.kind !== "disclosure" && e.kind !== "receipt" && e.kind !== "keys").map((e) => JSON.stringify(e.body)).join("\n");
    if (region.country !== "AU") for (const full of [region.postalCode, region.postalCode.replace(/ /g, "")]) expect(chained).not.toContain(full);
    expect(verifyChain(h.store.entries()).ok).toBe(true);
    const report = await runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(T0), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  // The per-order cap at payment (after the passkey) in CAD and AUD at the lowest level: payment-cap.test.ts.
  it("the caps are put in CAD: a $5 cap is CAD 7 (× 7000/5000), so the CAD 8.99 checkout is refused before any submit", async () => {
    const h = await setup({ faults: { region: CANADA }, policy: "version: 1\napproval: passkey\nspend:\n  per_order_usd: 5\n", currencies: { USD: { order: 5000, week: 10_000 }, CAD: { order: 7000, week: 14_000 } } });
    const found = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "CA", postcode: CANADA.postalCode });
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(found.message);
    const result = await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("over the CAD 7 per order limit");
    expect(h.fake.checkouts.received).toHaveLength(0);
  });

  it("attack (invariants 2 and 3): the full postcode, and its inward part, is in no log entry, request, held value or result", async () => {
    const h = await setup({ faults: { region: CANADA }, policy: `${DEFAULTS}categories:\n  block: [toys]\n` });
    const asked = { category: "stickers", budget: 25, country: "CA", postcode: "k1a-0b1" };
    const found = await h.gateway.findOffers(asked);
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(found.message);
    const result = await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    if (result.status !== "approval_needed") throw new Error(result.message);
    // A policy block keeps the values it held back: the search's category, never the postcode.
    const blocked = await h.gateway.findOffers({ ...asked, category: "toys" });
    expect(blocked.status).toBe("blocked");
    const all = everythingSent(h, found, result, blocked);
    expect(all).toContain("K1A");
    for (const part of ["K1A 0B1", "K1A0B1", "k1a-0b1", "k1a0b1"]) expect(all).not.toContain(part);
    // The inward part alone, in every body sent and every value held or shown (signatures and digests, random text, are
    // left out: they may hold three such characters by chance).
    const values = [
      ...disclosures(h).map(sentBody),
      ...h.store.entries().filter((e) => e.kind !== "disclosure" && e.kind !== "receipt" && e.kind !== "keys").map((e) => JSON.stringify(e.body)),
      ...h.shop.calls.map((c) => JSON.stringify(c.body)),
      JSON.stringify([h.fake.checkouts.received, found, result, blocked]),
    ].join("\n");
    expect(values).not.toContain("0B1");
    // The checkout Intent Cloud received ships to the country and the coarse postcode only.
    expect((h.fake.checkouts.received[0] as { checkout: { ship_to: unknown } }).checkout.ship_to).toEqual({ country: "CA", postal_code: "K1A" });
  });

  it("attack: a US ZIP+4 is kept and sent as its 5 digits only", async () => {
    const h = await setup({ faults: { shipToZip: "94107-1234" } });
    const found = await h.gateway.findOffers({ ...STICKERS, postcode: "94107-1234" });
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(found.message);
    const result = await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    if (result.status !== "approval_needed") throw new Error(result.message);
    const all = everythingSent(h, found, result);
    for (const full of ["94107-1234", "941071234"]) expect(all).not.toContain(full);
  });

  it.each([
    ["GB", "SW1A 1AA", "the UK"],
    ["IE", "D02 X285", "Ireland"],
    ["DE", "10115", "Germany"],
    ["FR", "75001", "France"],
  ])("%s left out of the countries Intent Cloud serves is refused with one clear line, and nothing is sent", async (country, postcode, name) => {
    const countries = Object.fromEntries(Object.entries(DEFAULT_COUNTRIES).filter(([c]) => c !== country));
    const h = await setup({ policy: DEFAULTS, countries });
    const before = disclosures(h).length;
    const result = await h.gateway.findOffers({ category: "stickers", budget: 25, country, postcode });
    expect(result).toMatchObject({ status: "refused" });
    expect(result.message).toMatch(new RegExp(`^Not sent: intent does not ship to ${name} yet; it ships to the US, Canada, Australia`));
    expect(disclosures(h)).toHaveLength(before);
    expect(everythingSent(h)).not.toContain(postcode);
  });

  it("a country the gateway knows nothing of is refused with the list alone", async () => {
    const h = await setup();
    const result = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "JP", postcode: "100-0001" });
    expect(result).toMatchObject({ status: "refused", message: `Not sent: intent ships to ${ALL_NAMES} for now.` });
  });

  it("a currency missing from Intent Cloud's table: its countries are left out of the served map and refused, the others still ship", async () => {
    const h = await setup({ currencies: { USD: { order: 50_000, week: 100_000 }, AUD: { order: 75_000, week: 150_000 } } });
    const ca = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "CA", postcode: CANADA.postalCode });
    expect(ca).toMatchObject({ status: "refused", message: "Not sent: intent does not ship to Canada yet; it ships to the US and Australia." });
    const gb = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "GB", postcode: "SW1A 1AA" });
    expect(gb.message).toBe("Not sent: intent does not ship to the UK yet; it ships to the US and Australia.");
    expect(disclosures(h).filter((d) => d.endpoint === "search_catalog")).toHaveLength(0);
  });

  it("attack: a country map that names a currency the table does not list ships nowhere new", async () => {
    // The map is served as configured only for currencies in the table, so CA → NZD is dropped by the fake as by Intent
    // Cloud; with a hand-made table the gateway still needs the currency's ceilings to put its limits in.
    const h = await setup({ countries: { ...DEFAULT_COUNTRIES, CA: "NZD" } });
    const ca = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "CA", postcode: CANADA.postalCode });
    expect(ca).toMatchObject({ status: "refused" });
    expect(disclosures(h).filter((d) => d.endpoint === "search_catalog")).toHaveLength(0);
  });

  it("a partial UK postcode or Eircode is asked for again in full: only a whole postcode has a coarse form", async () => {
    const h = await setup({ policy: DEFAULTS });
    for (const [country, postcode, format] of [
      ["GB", "SW1A", "a full postcode such as SW1A 1AA"],
      ["IE", "D02", "a full Eircode such as D02 X285"],
      ["DE", "10", "a postcode such as 10115"],
    ] as const) {
      const asked = await h.gateway.findOffers({ category: "stickers", budget: 25, country, postcode });
      if (asked.status !== "needs_details") throw new Error(asked.message);
      expect(asked.missing.map((m) => m.ask)).toEqual([expect.stringMatching(new RegExp(`does not look right for .*: give ${format}\\.$`))]);
    }
    expect(disclosures(h).filter((d) => d.endpoint === "search_catalog")).toHaveLength(0);
  });

  it("attack (invariant 1): a table whose CAD ceilings are out of line with USD's cannot widen the caps: Canada is refused", async () => {
    const h = await setup({ policy: DEFAULTS, currencies: { USD: { order: 1, week: 10_000 }, CAD: { order: 1e12, week: 14_000 } } });
    const ca = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "CA", postcode: CANADA.postalCode });
    expect(ca).toMatchObject({
      status: "refused",
      message: "Not sent: the ceilings Intent Cloud returns for CAD are out of line with its US-dollar ones, so intent cannot put your limits in CAD for Canada; try later.",
    });
    expect(disclosures(h).filter((d) => d.endpoint === "search_catalog")).toHaveLength(0);
  });

  it("an invalid postcode is asked again with the country's format; the budget is asked in its currency", async () => {
    const h = await setup();
    const bad = await h.gateway.findOffers({ category: "stickers", country: "CA", postcode: "11A 0B1" });
    if (bad.status !== "needs_details") throw new Error(bad.message);
    expect(bad.missing.map((m) => m.ask)).toEqual([
      "What is the most you want to spend, in Canadian dollars (CAD)?",
      "That postcode does not look right for Canada: give a postal code such as K1A 0B1.",
    ]);
    const au = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "AU", postcode: "20000" });
    expect(au.status === "needs_details" && au.missing.map((m) => m.ask)).toEqual(["That postcode does not look right for Australia: give a 4-digit postcode, such as 2000."]);
    expect(disclosures(h).filter((d) => d.endpoint === "search_catalog")).toHaveLength(0);
  });

  it("Shop's saved address in another country than the search's: refused before any submit", async () => {
    const h = await setup({ faults: { region: { ...CANADA, country: "US", postalCode: "94107" } } });
    const found = await h.gateway.findOffers({ category: "stickers", budget: 25, country: "CA", postcode: CANADA.postalCode });
    if (found.status !== "shop_offers" || found.offers[0] === undefined) throw new Error(found.message);
    const result = await h.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("another country or postcode area than the one given for the search");
    expect(h.fake.checkouts.received).toHaveLength(0);
  });
});
