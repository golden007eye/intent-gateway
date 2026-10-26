// The Shop wallet adapter against the fake Shop, through the disclosure core (plan G7a acceptance 1-5; ADR-0017).
// Attack cases: buyer identity in every Shop answer and error never reaches the chain, a tool result, an error
// message or a later send; a card number and a spend-request tool are never touched; address fields and address ids
// are never sent (create_checkout carries the lines only; an answer asking for fields is never retried; a forced
// street address is blocked with a `block` entry); a payment instrument carrying a billing address is never
// forwarded; the card is never paid with; Shop's real token names never reach audit.jsonl. The fake answers with the
// shapes the S1 spike captured (2026-10-18).
import * as fsp from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED } from "../../test/support/trust-kit.ts";
import { connectShop, createDisclosedWallet, DisclosureBlockedError, openWalletSession, type WalletSession } from "../disclosure/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { runVerify } from "../verify/index.ts";
import { AddressFieldsRequiredError, CheckoutUnconfirmedError, CompletionRefusedError, type WalletAdapter, WalletRailError } from "../wallet/index.ts";
import {
  FAKE_ADDRESS_ID,
  FAKE_BUDGET_MINOR,
  FAKE_BUYER,
  FAKE_OTHER_VARIANT,
  FAKE_PAN,
  FAKE_PICTURE_URL,
  FAKE_STORE,
  FAKE_STOREFRONT,
  FAKE_VARIANT,
  type FakeShop,
  type FakeShopFaults,
  SHIPPING_MINOR,
  startFakeShop,
  UNIT_PRICE_MINOR,
} from "../wallet-shop-fake/index.ts";
import { createShopAdapter, createShopMcpTransport, MCP_PROTOCOL, SHOP_TOOLS, ShopRequestError, ShopTransportError, shopCredentialsText } from "./index.ts";

type Json = Record<string, unknown>;
const ZIP = FAKE_BUYER.zip;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Fixed UUID v4s, so every run sends the same bytes. Both have leading digit groups that form a Luhn-valid run, which
// the card check once read as a PAN, refusing a random fraction of checkouts.
const CREATE_UUID = "52738107-9017-4321-abcd-ef0123456789";
const COMPLETE_UUID = "87654321-1002-4000-8000-0000000000ab";
/** The complete_checkout idempotency key. */
const KEY = COMPLETE_UUID;
// A fixed Shop checkout id for the test that scans raw outbound bodies: the fake's random hex id can hold a 13 to 19
// digit run that passes Luhn. The disclosure core lets exactly that Shop-issued id through (SHOP_OPAQUE_IDS, covered in
// disclosure/wallet.test.ts); a bare findIdentity has no such exemption, so these values hold no digit run that long.
const FIXED_CHECKOUT: FakeShopFaults = { checkoutToken: "fixedcheckout", checkoutKey: "fixedkey" };

let store: Store;
let shop: FakeShop;
let dir: string;
afterEach(async () => {
  await (store as Store | undefined)?.close().catch(() => undefined);
  await (shop as FakeShop | undefined)?.close();
});

interface Harness {
  wallet: WalletAdapter;
  session: WalletSession;
}

/** The vault texts the adapter handed back after a token refresh (what the CLI saves to the vault). */
let saved: string[] = [];

async function setup(faults: FakeShopFaults = {}, extra: { expiresAt?: number; now?: () => number } = {}): Promise<Harness> {
  shop = await startFakeShop({ faults });
  dir = join(await fsp.mkdtemp(join(tmpdir(), "shop-")), "data");
  store = await openStore(dir);
  saved = [];
  const session = openWalletSession(store);
  const vaultText = shopCredentialsText({ clientId: shop.clientId, accessToken: shop.accessToken, refreshToken: shop.refreshToken, expiresAt: extra.expiresAt ?? null });
  const saveVaultText = (text: string): Promise<void> => {
    saved.push(text);
    return Promise.resolve();
  };
  return {
    session,
    wallet: connectShop(session, { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText, newKey: () => CREATE_UUID, saveVaultText, ...(extra.now === undefined ? {} : { now: extra.now }) }),
  };
}

const purchase = "ap_TEST0001";
const request = { purchase, storeDomain: FAKE_STORE, lines: [{ variantRef: FAKE_VARIANT, quantity: 1 }], shipToPostalCode: ZIP };
const audit = () => readFileSync(join(dir, "audit.jsonl"), "utf8");
const sentTools = () => shop.calls.map((c) => c.tool);
/** Every logged request body, decoded: what the chain says was sent. */
const loggedBodies = () =>
  store
    .entries()
    .filter((e) => e.kind === "disclosure")
    .map((e) => Buffer.from((e.body as Json).body_b64 as string, "base64").toString("utf8"));
const buyerStrings = Object.values(FAKE_BUYER).filter((v) => v !== FAKE_BUYER.zip);

async function verified(): Promise<void> {
  await store.close();
  const report = await runVerify({ dataDir: dir, pinnedRootKeys: PINNED, now: new Date(), skipSupplyChain: true });
  expect(report.checks.filter((c) => !c.ok)).toEqual([]);
}

describe("the wire: MCP 2026-07-28, stateless, tools on the allow-list only", () => {
  it("allows exactly get_account, create_checkout, complete_checkout, get_checkout and search_orders (test 5)", () => {
    expect([...SHOP_TOOLS].sort()).toEqual(["complete_checkout", "create_checkout", "get_account", "get_checkout", "search_catalog", "search_orders"]);
  });

  it("every request carries Mcp-Method, Mcp-Name, the protocol version and params._meta; no initialize is ever sent", async () => {
    const { wallet } = await setup();
    await wallet.account();
    const checkout = await wallet.createCheckout(request);
    await wallet.getCheckout(checkout, purchase, ZIP);
    expect(shop.protocolErrors).toEqual([]);
    expect(shop.calls.map((c) => c.method)).toEqual(["tools/call", "tools/call", "tools/call"]);
    for (const call of shop.calls) {
      expect(call.headers).toMatchObject({ "mcp-method": "tools/call", "mcp-name": call.tool, "mcp-protocol-version": MCP_PROTOCOL });
      expect((call.body.params as Json)._meta).toEqual({
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "intent-gateway", version: expect.any(String) as unknown },
      });
    }
  });

  it("attack (raw card): a spend-request tool is advertised and a PAN is in get_account; the tool is never called, the PAN never chained (test 2)", async () => {
    const { wallet, session } = await setup({ spendRequestTool: true });
    const account = await wallet.account();
    expect(account).toEqual({
      budgetRemaining: { amountMinor: FAKE_BUDGET_MINOR, currency: "USD" },
      budgetLimit: { amount: { amountMinor: 15000, currency: "USD" }, renewal: "monthly", renewsAt: "2026-11-01T00:00:00Z" },
      manageUrl: "https://shop.app/account/connections",
      connected: true,
      currency: "USD",
    });
    expect(JSON.stringify(account)).not.toContain("4111");
    // Even asked directly, the transport refuses the tool before anything is logged or sent.
    const raw = createDisclosedWallet(createShopMcpTransport({ url: shop.mcpUrl, accessToken: shop.accessToken, clientVersion: "0" }), session, { destination: "shop" });
    await expect(raw.call("create_spend_request", {})).rejects.toBeInstanceOf(ShopRequestError);
    expect(sentTools()).toEqual(["get_account"]);
    expect(store.entries().filter((e) => e.kind === "disclosure")).toHaveLength(1);
    for (const digits of [FAKE_PAN, FAKE_PAN.replace(/ /g, "")]) expect(audit()).not.toContain(digits);
  });
});

describe("a purchase's Shop calls", () => {
  it("creates with the lines only (Shop fills the preferred address), completes once with the agent budget and a UUID v4 key, and projects every answer", async () => {
    const { wallet } = await setup(FIXED_CHECKOUT);
    const created = await wallet.createCheckout(request);
    expect(created).toEqual({
      checkoutRef: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
      storeDomain: FAKE_STORE,
      status: "open",
      // S1: a checkout names no merchant; the gateway binds the store instead (complete.ts).
      merchantOrigin: null,
      lines: [{ variantRef: FAKE_VARIANT, quantity: 1, title: "Holographic sticker" }],
      total: { amountMinor: UNIT_PRICE_MINOR + SHIPPING_MINOR, currency: "USD" },
      shipTo: "match",
      orderRef: null,
      budgetOffered: true,
      totals: { subtotal: UNIT_PRICE_MINOR, shipping: SHIPPING_MINOR, tax: 0, total: UNIT_PRICE_MINOR + SHIPPING_MINOR },
      shipToArea: { country: "US", postalCodeCoarse: expect.stringMatching(/^[0-9]{5}$/) as unknown },
      continueUrl: expect.stringMatching(/^https:\/\//) as unknown,
    });
    // One send: no get_account first, and no address or address id in it.
    expect(sentTools()).toEqual(["create_checkout"]);
    const create = shop.calls.find((c) => c.tool === "create_checkout")?.body.params as Json;
    const args = create.arguments as Json;
    expect(args).toEqual({ shop: FAKE_STORE, checkout: { line_items: [{ item: { id: FAKE_VARIANT }, quantity: 1 }] }, meta: { "idempotency-key": CREATE_UUID } });
    expect(JSON.stringify(shop.calls)).not.toContain(FAKE_ADDRESS_ID);
    expect(CREATE_UUID).toMatch(UUID_V4);

    const done = await wallet.completeCheckout(created, purchase, KEY, { shipToPostalCode: ZIP, sendUnless: () => false });
    expect(done).toMatchObject({ status: "completed", orderRef: expect.stringMatching(/^gid:\/\/shopify\/Order\/\d+$/) as unknown, shipTo: "match", storeDomain: FAKE_STORE });
    expect(shop.completeCount).toBe(1);
    // Paid with the delegated budget, never the Shop Pay card offered beside it (S1 step 6).
    expect(shop.paidWith).toEqual(["delegated_budget"]);
    const complete = shop.calls.find((c) => c.tool === "complete_checkout")?.body.params as Json;
    expect(((complete.arguments as Json).meta as Json)["idempotency-key"]).toBe(KEY);
    const sentInstruments = (((complete.arguments as Json).checkout as Json).payment as Json).instruments as Json[];
    expect(sentInstruments).toHaveLength(1);
    expect(sentInstruments[0]).toMatchObject({ type: "delegated_budget", selected: true, id: expect.stringMatching(/^shop_/) as unknown });

    expect(await wallet.getCheckout(created, purchase, "10001")).toMatchObject({ status: "completed", shipTo: "differs" });
    expect(await wallet.getCheckout(created, purchase)).toMatchObject({ shipTo: "unknown" });
    // Each send names its purchase in the chain, locally; the handle is never in what was sent.
    const disclosures = store.entries().filter((e) => e.kind === "disclosure");
    expect(disclosures.every((e) => (e.body as Json).purchase === purchase && (e.body as Json).destination === "shop")).toBe(true);
    for (const body of loggedBodies()) expect(body).not.toContain(purchase);
    // No outbound body carries an address field or any identity.
    for (const call of shop.calls) expect(findIdentity(call.body, { mcpEnvelope: true })).toEqual([]);
    await verified();
  });

  it("refuses an idempotency key that is not a UUID v4 (no ik_ keys): nothing is sent", async () => {
    const { wallet } = await setup();
    const created = await wallet.createCheckout(request);
    await expect(wallet.completeCheckout(created, purchase, "ik_AAAAAAAAAAAAAAAAAAAAAA", { sendUnless: () => false })).rejects.toBeInstanceOf(TypeError);
    expect(shop.completeCount).toBe(0);
  });

  it("projects the fake's failure modes: buyer review, another variant, a higher total, a refused or ineligible store", async () => {
    let h = await setup({ buyerReview: true, otherVariant: true, totalAboveMinor: 100 });
    const created = await h.wallet.createCheckout(request);
    expect(created.lines[0]?.variantRef).toBe(FAKE_OTHER_VARIANT);
    expect(created.total?.amountMinor).toBe(UNIT_PRICE_MINOR + SHIPPING_MINOR + 100);
    expect(await h.wallet.completeCheckout(created, purchase, KEY, { sendUnless: () => false })).toMatchObject({ status: "buyer_review", orderRef: null });
    await store.close();
    await shop.close();
    // A tool error (S1 step 8 shape): Shop's code kept, its message never.
    h = await setup({ createRefused: true, identityEverywhere: true });
    const refused = await h.wallet.createCheckout(request).catch((e: unknown) => e);
    expect(refused).toMatchObject({ name: "WalletRailError", httpStatus: 200, railCode: "merchant_unavailable" });
    expect((refused as Error).message).not.toContain(FAKE_BUYER.email);
    await store.close();
    await shop.close();
    // S1 step 11: a store agents cannot complete at answers a checkout asking the buyer, with no instrument.
    h = await setup({ ineligible: true });
    expect(await h.wallet.createCheckout(request)).toMatchObject({ status: "buyer_review", budgetOffered: false });
  });

  it("complete_checkout answered checkout_completion_ineligible (a tool error): an error carrying Shop's code, never a success", async () => {
    const { wallet } = await setup({ completeIneligible: true });
    const created = await wallet.createCheckout(request);
    const error = await wallet.completeCheckout(created, purchase, KEY, { sendUnless: () => false }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "WalletRailError", httpStatus: 200, railCode: "checkout_completion_ineligible" });
    expect(shop.completeCount).toBe(1);
  });

  it("no agent budget offered (only the card): CompletionRefusedError no_budget_instrument, and no complete_checkout is sent", async () => {
    for (const faults of [{ noBudgetInstrument: true }, { twoBudgetInstruments: true }] as FakeShopFaults[]) {
      const { wallet } = await setup(faults);
      const created = await wallet.createCheckout(request);
      expect(created.budgetOffered).toBe(false);
      const error = await wallet.completeCheckout(created, purchase, KEY, { sendUnless: () => false }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CompletionRefusedError);
      expect((error as CompletionRefusedError).reason).toBe("no_budget_instrument");
      expect(shop.completeCount).toBe(0);
      expect(shop.paidWith).toEqual([]);
      await store.close();
      await shop.close();
    }
  });

  it("attack (idempotency, S1 step 6 --replay): a create_checkout whose answer is lost is never sent again; CheckoutUnconfirmedError", async () => {
    for (const faults of [{ dropCreateAnswer: true }, { toolHttpStatus: { create_checkout: 502 } }] as FakeShopFaults[]) {
      const { wallet } = await setup(faults);
      const error = await wallet.createCheckout(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CheckoutUnconfirmedError);
      expect(shop.calls.filter((c) => c.tool === "create_checkout")).toHaveLength(1);
      expect(sentTools()).toEqual(["create_checkout"]);
      await store.close();
      await shop.close();
    }
    // A create that never left (no connection) is plain "not sent", not unconfirmed.
    await setup();
    const vaultText = shopCredentialsText({ clientId: shop.clientId, accessToken: shop.accessToken, refreshToken: null });
    const offline = connectShop(openWalletSession(store), { mcpUrl: "http://127.0.0.1:1/mcp", authUrl: shop.authUrl, vaultText, newKey: () => CREATE_UUID });
    const notSent = await offline.createCheckout(request).catch((e: unknown) => e);
    expect(notSent).toBeInstanceOf(ShopTransportError);
    expect((notSent as ShopTransportError).neverLeft).toBe(true);
  });

  it("a lost complete_checkout answer: logged, sent once, unacknowledged; the error names no content", async () => {
    const { wallet } = await setup({ dropCompleteAnswer: true });
    const created = await wallet.createCheckout(request);
    await expect(wallet.completeCheckout(created, purchase, KEY, { sendUnless: () => false })).rejects.toBeInstanceOf(ShopTransportError);
    expect(shop.completeCount).toBe(1);
    expect(store.entries().at(-1)?.kind).toBe("unacknowledged");
  });
});

describe("invariant 3: Shop's buyer identity never gets past the projection", () => {
  it("attack (identity, test 1): email, phone, names, picture, full address, card and credential in every answer and error stay out of the chain, results, errors and sends", async () => {
    const { wallet } = await setup({ identityEverywhere: true });
    const outputs: unknown[] = [];
    outputs.push(await wallet.account());
    const created = await wallet.createCheckout(request);
    outputs.push(created, await wallet.getCheckout(created, purchase, ZIP), await wallet.completeCheckout(created, purchase, KEY, { shipToPostalCode: ZIP, sendUnless: () => false }));
    // A checkout reference this process does not hold: refused locally, its error naming nothing.
    const missing = await wallet.getCheckout({ storeDomain: FAKE_STORE, checkoutRef: "gid://shopify/Checkout/0" }, purchase).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(WalletRailError);
    outputs.push((missing as Error).message);
    // A JSON-RPC error with identity in its message (a bad token).
    const broken = connectShop(openWalletSession(store), { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText: shopCredentialsText({ clientId: "c", accessToken: "wrong", refreshToken: null }) });
    const refused = await broken.account().catch((e: unknown) => e);
    expect(refused).toMatchObject({ name: "WalletRailError", httpStatus: 401 });
    outputs.push((refused as Error).message);

    const seen = JSON.stringify(outputs);
    const chain = audit();
    // The order history's order id too ("gid://shopify/Order/4001"); a digest may contain any short digit run.
    // The account's picture URL, its card's holder name and payment token, and the address id too.
    for (const value of [...buyerStrings, "shopify/Order/4001", FAKE_PICTURE_URL, shop.accountCardToken, FAKE_ADDRESS_ID, "Apt 4"]) {
      expect(seen).not.toContain(value);
      expect(chain).not.toContain(value);
      for (const body of loggedBodies()) expect(body).not.toContain(value);
      for (const call of shop.calls) expect(JSON.stringify(call.body)).not.toContain(value);
    }
    for (const entry of store.entries()) expect(findIdentity(entry.body), entry.kind).toEqual([]);
  });
});

describe("plan kill criterion K4: no address fields ever leave", () => {
  it("attack (K4 regression, test 3): Shop asks for address fields; the gateway sent none, and never retries with them", async () => {
    const { wallet } = await setup({ requiresAddressFields: true });
    const error = await wallet.createCheckout(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressFieldsRequiredError);
    expect((error as AddressFieldsRequiredError).step).toBe("delivery");
    // One create, lines only: no fulfillment, destination or address id, and no second try.
    expect(sentTools()).toEqual(["create_checkout"]);
    const args = (shop.calls[0]?.body.params as Json).arguments as Json;
    expect(Object.keys(args.checkout as Json)).toEqual(["line_items"]);
    expect(audit()).not.toContain(FAKE_BUYER.address1);
  });

  it("attack: the account's saved-address ids never reach a send, even after get_account read them", async () => {
    const { wallet } = await setup();
    await wallet.account();
    const created = await wallet.createCheckout(request);
    await wallet.completeCheckout(created, purchase, KEY, { shipToPostalCode: ZIP, sendUnless: () => false });
    for (const call of shop.calls) expect(JSON.stringify(call.body)).not.toMatch(/destination|fulfillment|address/);
    for (const body of loggedBodies()) expect(body).not.toContain(FAKE_ADDRESS_ID);
  });

  it("attack (K4 regression, test 3): a forced street address is blocked by findIdentity with a block entry, and never sent", async () => {
    const { session } = await setup();
    const raw = createDisclosedWallet(createShopMcpTransport({ url: shop.mcpUrl, accessToken: shop.accessToken, clientVersion: "0" }), session, { destination: "shop" });
    const forced = { shop: FAKE_STORE, checkout: { fulfillment: { methods: [{ destinations: [{ type: "shipping_address", line1: FAKE_BUYER.address1 }] }] } } };
    await expect(raw.call("create_checkout", forced, { purchase })).rejects.toBeInstanceOf(DisclosureBlockedError);
    expect(shop.calls).toEqual([]);
    const blocks = store.entries().filter((e) => e.kind === "block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body).toMatchObject({ endpoint: "create_checkout", destination: "shop", blocked: [expect.stringMatching(/^street_address at /) as unknown] });
    expect(audit()).not.toContain(FAKE_BUYER.address1);
  });

  it("attack: a payment instrument carrying a billing address is never forwarded; no complete_checkout is sent", async () => {
    const { wallet } = await setup({ billingAddressOnInstrument: true });
    const created = await wallet.createCheckout(request);
    const error = await wallet.completeCheckout(created, purchase, KEY, { sendUnless: () => false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressFieldsRequiredError);
    expect((error as AddressFieldsRequiredError).step).toBe("payment");
    expect(shop.completeCount).toBe(0);
    expect(audit()).not.toContain(FAKE_BUYER.address1);
  });
});

describe("credentials never reach the chain (G2b follow-up 3)", () => {
  it("the bearer token, the refresh token and the instrument's Shop Pay token are absent from audit.jsonl; verify passes", async () => {
    const { wallet } = await setup();
    const created = await wallet.createCheckout(request);
    await wallet.completeCheckout(created, purchase, KEY, { sendUnless: () => false });
    expect(await wallet.revoke()).toBe("revoked");
    // Both tokens: Shop keeps an access token working after its refresh token is revoked (S1 step 12).
    const form = "application/x-www-form-urlencoded";
    expect(shop.revocations).toEqual([
      { token: shop.refreshToken, tokenTypeHint: "refresh_token", clientId: shop.clientId, contentType: form },
      { token: shop.accessToken, tokenTypeHint: "access_token", clientId: shop.clientId, contentType: form },
    ]);
    const chain = audit();
    for (const secret of [shop.accessToken, shop.refreshToken, shop.instrumentToken]) {
      expect(chain).not.toContain(secret);
      for (const body of loggedBodies()) expect(body).not.toContain(secret);
    }
    const complete = store.entries().find((e) => e.kind === "disclosure" && (e.body as Json).endpoint === "complete_checkout")?.body as Json;
    expect((complete.redacted as { at: string }[]).map((r) => r.at)).toEqual([
      "headers.authorization",
      "body.params.arguments.id",
      "body.params.arguments.checkout.payment.instruments[0].credential",
    ]);
    const revokes = store.entries().filter((e) => e.kind === "disclosure" && (e.body as Json).endpoint === "revoke");
    expect(revokes).toHaveLength(2);
    for (const r of revokes) expect(r.body).toMatchObject({ destination: "shop_accounts", redacted: [{ at: "body.token" }] });
    // After the revocation Shop refuses the token, and its refresh: the adapter says to link again, in its own words.
    await expect(wallet.account()).rejects.toMatchObject({ httpStatus: 401, message: expect.stringContaining("link the wallet again") as unknown });
    await verified();
  });

  it("attack (invariant 2): when the chain cannot be appended to, neither revoke nor get_account reaches Shop", async () => {
    await setup();
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "append") return () => Promise.reject(new Error("disk full"));
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const vaultText = shopCredentialsText({ clientId: shop.clientId, accessToken: shop.accessToken, refreshToken: shop.refreshToken });
    const wallet = connectShop(openWalletSession(failing), { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText });
    await expect(wallet.revoke()).rejects.toThrow("disk full");
    await expect(wallet.account()).rejects.toThrow();
    expect(shop.revocations).toEqual([]);
    expect(shop.calls).toEqual([]);
  });

  it("refuses a create_checkout key that is not a UUID v4: nothing is sent", async () => {
    await setup();
    const calls: string[] = [];
    const answer = (content: unknown) => ({
      status: 200,
      headers: [["content-type", "application/json"]] as [string, string][],
      body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: content } })),
    });
    const mcp = {
      call: (operation: string) => {
        calls.push(operation);
        return Promise.resolve(answer({}));
      },
    };
    const wallet = createShopAdapter({ mcp, accounts: mcp, credentials: { clientId: "c", accessToken: "a", refreshToken: null }, newKey: () => "ik_AAAAAAAAAAAAAAAAAAAAAA" });
    await expect(wallet.createCheckout(request)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("attack: a checkout id carrying ?key= flows through create, get and complete; the key is never in the chain, a result or an error", async () => {
    const { wallet } = await setup({ checkoutKey: "SECRET-CHECKOUT-KEY" });
    const created = await wallet.createCheckout(request);
    const outputs: unknown[] = [created, await wallet.getCheckout(created, purchase, ZIP), await wallet.completeCheckout(created, purchase, KEY, { shipToPostalCode: ZIP, sendUnless: () => false })];
    // It did reach Shop, which needs it: the fake got the full id back on each call.
    const ids = shop.calls.filter((c) => c.tool === "get_checkout" || c.tool === "complete_checkout").map((c) => ((c.body.params as Json).arguments as Json).id);
    expect(ids.every((id) => typeof id === "string" && id.endsWith("?key=SECRET-CHECKOUT-KEY"))).toBe(true);
    // A reference from another process (or forged) reaches nothing, and its error names no id.
    const stranger = await wallet.getCheckout({ storeDomain: FAKE_STORE, checkoutRef: "sha256:00" }, purchase).catch((e: unknown) => e);
    expect(stranger).toBeInstanceOf(WalletRailError);
    outputs.push((stranger as Error).message);
    expect(JSON.stringify(outputs)).not.toContain("SECRET-CHECKOUT-KEY");
    expect(JSON.stringify(outputs)).not.toContain("gid://shopify/Checkout/");
    expect(audit()).not.toContain("SECRET-CHECKOUT-KEY");
    for (const body of loggedBodies()) expect(body).not.toContain("SECRET-CHECKOUT-KEY");
    await verified();
  });

  it("revoke with no usable token in the vault sends nothing", async () => {
    await setup();
    const empty = connectShop(openWalletSession(store), { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText: "not json" });
    expect(await empty.revoke()).toBe("not_sent");
    await expect(empty.account()).rejects.toBeInstanceOf(WalletRailError);
    await expect(empty.orders()).rejects.toBeInstanceOf(WalletRailError);
    expect(shop.revocations).toEqual([]);
    expect(shop.calls).toEqual([]);
  });
});

describe("token refresh (S1: a refresh token is issued, the access token lives 3600 s)", () => {
  const tokenGrants = () => shop.oauthRequests.filter((r) => r.path === "/oauth/token" && r.form.grant_type === "refresh_token");

  it("a 401 on a read: refreshed through the log (refresh token digested), the read sent again once, the new tokens handed to the vault", async () => {
    const { wallet } = await setup();
    const oldAccess = shop.accessToken;
    const refresh = shop.refreshToken;
    shop.expireAccessTokens();
    expect(await wallet.account()).toMatchObject({ connected: true });
    expect(tokenGrants()).toHaveLength(1);
    expect(tokenGrants()[0]?.form).toEqual({ grant_type: "refresh_token", refresh_token: refresh, client_id: shop.clientId });
    expect(shop.accessToken).not.toBe(oldAccess);
    expect(sentTools()).toEqual(["get_account", "get_account"]);
    // The second get_account carried the new token.
    expect(shop.calls[1]?.headers.authorization).toBe(`Bearer ${shop.accessToken}`);
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0] ?? "{}")).toMatchObject({ v: 1, access_token: shop.accessToken, refresh_token: refresh, expires_at: expect.any(Number) as unknown });
    // Logged before it left, the refresh token digested; the new tokens (in the answer) never in the chain.
    const grant = store.entries().find((e) => e.kind === "disclosure" && (e.body as Json).endpoint === "token")?.body as Json;
    expect(grant).toMatchObject({ destination: "shop_accounts", redacted: [{ at: "body.refresh_token" }] });
    for (const secret of [refresh, shop.accessToken, oldAccess]) expect(audit()).not.toContain(secret);
    await verified();
  });

  it("an access token past its expiry is refreshed before the send, with no 401 first; a rotated refresh token is kept", async () => {
    let now = Date.now();
    const { wallet } = await setup({ rotateRefresh: true }, { expiresAt: now + 30_000, now: () => now });
    const first = shop.refreshToken;
    now += 10_000; // inside the refresh margin (60 s)
    await wallet.orders();
    expect(tokenGrants()).toHaveLength(1);
    expect(sentTools()).toEqual(["search_orders"]);
    expect(shop.refreshToken).not.toBe(first);
    expect(JSON.parse(saved[0] ?? "{}")).toMatchObject({ refresh_token: shop.refreshToken });
  });

  it("refresh refused (invalid_grant): a 401 saying to link again, Shop's text not echoed, the read not resent", async () => {
    const { wallet } = await setup({ refuseRefresh: true, identityEverywhere: true });
    shop.expireAccessTokens();
    const error = await wallet.account().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "WalletRailError", httpStatus: 401 });
    expect((error as Error).message).toContain("link the wallet again");
    expect((error as Error).message).not.toContain(FAKE_BUYER.email);
    expect(sentTools()).toEqual(["get_account"]);
    expect(saved).toEqual([]);
  });

  it("a 401 on create_checkout: tokens refreshed, but create_checkout is not sent again", async () => {
    const { wallet } = await setup();
    shop.expireAccessTokens();
    const error = await wallet.createCheckout(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "WalletRailError", httpStatus: 401 });
    expect(shop.createCount).toBe(0);
    expect(sentTools()).toEqual(["create_checkout"]);
    expect(tokenGrants()).toHaveLength(1);
    // The next call goes out with the new token.
    await wallet.createCheckout(request);
    expect(shop.createCount).toBe(1);
  });

  it("the account server unreachable for a refresh before create_checkout: not sent, and not read as unconfirmed", async () => {
    await setup();
    const vaultText = shopCredentialsText({ clientId: shop.clientId, accessToken: shop.accessToken, refreshToken: shop.refreshToken, expiresAt: 1 });
    const wallet = connectShop(openWalletSession(store), { mcpUrl: shop.mcpUrl, authUrl: "http://127.0.0.1:1", vaultText, newKey: () => CREATE_UUID });
    const error = await wallet.createCheckout(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletRailError);
    expect(error).not.toBeInstanceOf(CheckoutUnconfirmedError);
    expect(error).toMatchObject({ httpStatus: 0 });
    expect(sentTools()).toEqual([]);
    expect(shop.createCount).toBe(0);
  });
});

describe("unlink and a connection removed in the Shop app (S1 steps 12, 12b)", () => {
  it("revoking the refresh token alone leaves the access token working at Shop: the adapter revokes both", async () => {
    const { wallet } = await setup();
    expect(await wallet.revoke()).toBe("revoked");
    expect(shop.revocations.map((r) => r.tokenTypeHint)).toEqual(["refresh_token", "access_token"]);
    await expect(wallet.account()).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("one revocation refused: not_revoked (invariant 5), both still sent", async () => {
    const { wallet } = await setup({ revokeStatus: 500 });
    expect(await wallet.revoke()).toBe("not_revoked");
    expect(shop.revocations).toHaveLength(2);
  });

  it("the connection removed in the app: the token answers, the account reads as not connected with no budget", async () => {
    const { wallet } = await setup({ connectionRemoved: true });
    expect(await wallet.account()).toEqual({ budgetRemaining: null, budgetLimit: null, manageUrl: "https://shop.app/account/connections", connected: false, currency: null });
  });

  it("no budget for the connection (S1 step 3), or another currency: the budget is unknown (null) or kept with its currency", async () => {
    let h = await setup({ budgetMinor: null });
    expect(await h.wallet.account()).toEqual({ budgetRemaining: null, budgetLimit: null, manageUrl: "https://shop.app/account/connections", connected: true, currency: "USD" });
    await store.close();
    await shop.close();
    h = await setup({ accountCurrency: "CAD", budgetMinor: 700 });
    expect(await h.wallet.account()).toEqual({
      budgetRemaining: { amountMinor: 700, currency: "CAD" },
      budgetLimit: { amount: { amountMinor: 15000, currency: "CAD" }, renewal: "monthly", renewsAt: "2026-11-01T00:00:00Z" },
      manageUrl: "https://shop.app/account/connections",
      connected: true,
      currency: "CAD",
    });
  });
});

describe("search_orders (plan G12, wallet check)", () => {
  it("attack (identity): orders full of the buyer's identity come back as {order_ref, total, merchant_origin, created_at} only; nothing of it is chained", async () => {
    const { wallet } = await setup({ identityEverywhere: true, moreOrders: true });
    shop.orders = [
      { id: "gid://shopify/Order/7001", totalMinor: 1250, createdAt: "2026-10-15T09:00:00.000Z" },
      { id: "gid://shopify/Order/7002", totalMinor: 700, currency: "CAD", createdAt: "2026-10-16T09:00:00.000Z" },
    ];
    const reported = await wallet.orders();
    expect(reported).toEqual({
      orders: [
        { orderRef: "gid://shopify/Order/7001", total: { amountMinor: 1250, currency: "USD" }, merchantOrigin: FAKE_STOREFRONT, createdAt: "2026-10-15T09:00:00.000Z" },
        { orderRef: "gid://shopify/Order/7002", total: { amountMinor: 700, currency: "CAD" }, merchantOrigin: FAKE_STOREFRONT, createdAt: "2026-10-16T09:00:00.000Z" },
      ],
      complete: false,
    });
    const seen = JSON.stringify(reported);
    const chain = audit();
    // Neither the buyer, the line text, nor checkout_id (an order-status URL with a credential, S1 step 10).
    for (const value of [...buyerStrings, "Engraved", "authenticate", "Sticker Store"]) {
      expect(seen).not.toContain(value);
      expect(chain).not.toContain(value);
    }
    for (const entry of store.entries()) expect(findIdentity(entry.body), entry.kind).toEqual([]);
    // Logged before it was sent: the disclosure, then the response (a digest and a size only).
    expect(store.entries().map((e) => e.kind)).toEqual(["session", "disclosure", "response"]);
    expect(sentTools()).toEqual(["search_orders"]);
    expect(loggedBodies()[0]).toContain('"arguments":{"pagination":{"limit":50}}');
    await verified();
  });

  it("attack (invariant 2): when the disclosure cannot be appended, search_orders never reaches Shop", async () => {
    await setup();
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "append") return () => Promise.reject(new Error("disk full"));
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const vaultText = shopCredentialsText({ clientId: shop.clientId, accessToken: shop.accessToken, refreshToken: shop.refreshToken });
    const wallet = connectShop(openWalletSession(failing), { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText });
    await expect(wallet.orders()).rejects.toThrow("disk full");
    expect(shop.calls).toEqual([]);
  });
});
