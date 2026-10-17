// The Shop wallet adapter against the fake Shop, through the disclosure core (plan G7a acceptance 1-5; ADR-0017).
// Attack cases: buyer identity in every Shop answer and error never reaches the chain, a tool result, an error
// message or a later send; a card number and a spend-request tool are never touched; address fields are never sent
// (no create_checkout when Shop would need them; a forced street address is blocked with a `block` entry); a payment
// instrument carrying a billing address is never forwarded; Shop's real token names never reach audit.jsonl.
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
import { AddressFieldsRequiredError, type WalletAdapter, WalletRailError } from "../wallet/index.ts";
import {
  FAKE_ADDRESS_ID,
  FAKE_BUYER,
  FAKE_OTHER_VARIANT,
  FAKE_PAN,
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

async function setup(faults: FakeShopFaults = {}): Promise<Harness> {
  shop = await startFakeShop({ faults });
  dir = join(await fsp.mkdtemp(join(tmpdir(), "shop-")), "data");
  store = await openStore(dir);
  const session = openWalletSession(store);
  const vaultText = shopCredentialsText({ clientId: shop.clientId, accessToken: shop.accessToken, refreshToken: shop.refreshToken });
  return { session, wallet: connectShop(session, { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, vaultText, newKey: () => CREATE_UUID }) };
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
    expect([...SHOP_TOOLS].sort()).toEqual(["complete_checkout", "create_checkout", "get_account", "get_checkout", "search_orders"]);
  });

  it("every request carries Mcp-Method, Mcp-Name, the protocol version and params._meta; no initialize is ever sent", async () => {
    const { wallet } = await setup();
    await wallet.account();
    const checkout = await wallet.createCheckout(request);
    await wallet.getCheckout(checkout, purchase, ZIP);
    expect(shop.protocolErrors).toEqual([]);
    expect(shop.calls.map((c) => c.method)).toEqual(["tools/call", "tools/call", "tools/call", "tools/call"]);
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
    expect(account).toEqual({ budgetRemaining: { amountMinor: 5000, currency: "USD" } });
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
  it("creates by saved-address id only, completes once with a UUID v4 key, and projects every answer", async () => {
    const { wallet } = await setup();
    const created = await wallet.createCheckout(request);
    expect(created).toEqual({
      checkoutRef: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
      storeDomain: FAKE_STORE,
      status: "open",
      merchantOrigin: FAKE_STOREFRONT,
      lines: [{ variantRef: FAKE_VARIANT, quantity: 1, title: "Holographic sticker" }],
      total: { amountMinor: UNIT_PRICE_MINOR + SHIPPING_MINOR, currency: "USD" },
      shipTo: "match",
      orderRef: null,
    });
    const create = shop.calls.find((c) => c.tool === "create_checkout")?.body.params as Json;
    const args = create.arguments as Json;
    expect(args.checkout).toEqual({
      line_items: [{ item: { id: FAKE_VARIANT }, quantity: 1 }],
      fulfillment: { methods: [{ type: "shipping", destinations: [{ id: FAKE_ADDRESS_ID, type: "shipping_address" }], selected_destination_id: FAKE_ADDRESS_ID }] },
    });
    expect((args.meta as Json)["idempotency-key"]).toBe(CREATE_UUID);
    expect(CREATE_UUID).toMatch(UUID_V4);

    const done = await wallet.completeCheckout(created, purchase, KEY, ZIP);
    expect(done).toMatchObject({ status: "completed", orderRef: expect.stringMatching(/^gid:\/\/shopify\/Order\/\d+$/) as unknown, shipTo: "match" });
    expect(shop.completeCount).toBe(1);
    const complete = shop.calls.find((c) => c.tool === "complete_checkout")?.body.params as Json;
    expect(((complete.arguments as Json).meta as Json)["idempotency-key"]).toBe(KEY);

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
    await expect(wallet.completeCheckout(created, purchase, "ik_AAAAAAAAAAAAAAAAAAAAAA")).rejects.toBeInstanceOf(TypeError);
    expect(shop.completeCount).toBe(0);
  });

  it("projects the fake's failure modes: buyer review, another variant, a higher total, an ineligible store", async () => {
    let h = await setup({ buyerReview: true, otherVariant: true, totalAboveMinor: 100 });
    const created = await h.wallet.createCheckout(request);
    expect(created.lines[0]?.variantRef).toBe(FAKE_OTHER_VARIANT);
    expect(created.total?.amountMinor).toBe(UNIT_PRICE_MINOR + SHIPPING_MINOR + 100);
    expect(await h.wallet.completeCheckout(created, purchase, KEY)).toMatchObject({ status: "buyer_review", orderRef: null });
    await store.close();
    await shop.close();
    h = await setup({ ineligible: true });
    await expect(h.wallet.createCheckout(request)).rejects.toBeInstanceOf(WalletRailError);
  });

  it("a lost complete_checkout answer: logged, sent once, unacknowledged; the error names no content", async () => {
    const { wallet } = await setup({ dropCompleteAnswer: true });
    const created = await wallet.createCheckout(request);
    await expect(wallet.completeCheckout(created, purchase, KEY)).rejects.toBeInstanceOf(ShopTransportError);
    expect(shop.completeCount).toBe(1);
    expect(store.entries().at(-1)?.kind).toBe("unacknowledged");
  });
});

describe("invariant 3: Shop's buyer identity never gets past the projection", () => {
  it("attack (identity, test 1): name, email, phone, address and order history in every answer and error stay out of the chain, results, errors and sends", async () => {
    const { wallet } = await setup({ identityEverywhere: true });
    const outputs: unknown[] = [];
    outputs.push(await wallet.account());
    const created = await wallet.createCheckout(request);
    outputs.push(created, await wallet.getCheckout(created, purchase, ZIP), await wallet.completeCheckout(created, purchase, KEY, ZIP));
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
    for (const value of [...buyerStrings, "shopify/Order/4001"]) {
      expect(seen).not.toContain(value);
      expect(chain).not.toContain(value);
      for (const body of loggedBodies()) expect(body).not.toContain(value);
      for (const call of shop.calls) expect(JSON.stringify(call.body)).not.toContain(value);
    }
    for (const entry of store.entries()) expect(findIdentity(entry.body), entry.kind).toEqual([]);
  });
});

describe("plan kill criterion K4: no address fields ever leave", () => {
  it("attack (K4 regression, test 3): Shop would need address fields, so no create_checkout is sent", async () => {
    const { wallet } = await setup({ requiresAddressFields: true });
    const error = await wallet.createCheckout(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressFieldsRequiredError);
    expect((error as AddressFieldsRequiredError).step).toBe("delivery");
    expect(sentTools()).toEqual(["get_account"]);
    expect(audit()).not.toContain(FAKE_BUYER.address1);
  });

  it("attack: a saved-address id with a query (a token, address text) is never used, so nothing is sent with it", async () => {
    for (const hostile of [`${FAKE_ADDRESS_ID}?model_name=CustomerAddress&customer_access_token=SECRET-ADDR-TOKEN`, `${FAKE_ADDRESS_ID}?city=Springfield`]) {
      const { wallet } = await setup({ addressId: hostile });
      const error = await wallet.createCheckout(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AddressFieldsRequiredError);
      expect((error as AddressFieldsRequiredError).step).toBe("delivery");
      expect(sentTools()).toEqual(["get_account"]);
      expect(audit()).not.toContain("SECRET-ADDR-TOKEN");
      for (const body of loggedBodies()) expect(body).not.toContain("?");
      await store.close();
      await shop.close();
    }
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
    const error = await wallet.completeCheckout(created, purchase, KEY).catch((e: unknown) => e);
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
    await wallet.completeCheckout(created, purchase, KEY);
    expect(await wallet.revoke()).toBe("revoked");
    expect(shop.revocations).toEqual([{ token: shop.refreshToken, tokenTypeHint: "refresh_token", clientId: shop.clientId, contentType: "application/x-www-form-urlencoded" }]);
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
    const revoke = store.entries().find((e) => e.kind === "disclosure" && (e.body as Json).endpoint === "revoke")?.body as Json;
    expect(revoke).toMatchObject({ destination: "shop_accounts", redacted: [{ at: "body.token" }] });
    // After the revocation Shop refuses the token: the adapter says so in its own words.
    await expect(wallet.account()).rejects.toMatchObject({ httpStatus: 401 });
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
        return Promise.resolve(answer({ account: { preferred_address_id: FAKE_ADDRESS_ID } }));
      },
    };
    const wallet = createShopAdapter({ mcp, accounts: mcp, credentials: { clientId: "c", accessToken: "a", refreshToken: null }, newKey: () => "ik_AAAAAAAAAAAAAAAAAAAAAA" });
    await expect(wallet.createCheckout(request)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual(["get_account"]);
  });

  it("attack: a checkout id carrying ?key= flows through create, get and complete; the key is never in the chain, a result or an error", async () => {
    const { wallet } = await setup({ checkoutKey: "SECRET-CHECKOUT-KEY" });
    const created = await wallet.createCheckout(request);
    const outputs: unknown[] = [created, await wallet.getCheckout(created, purchase, ZIP), await wallet.completeCheckout(created, purchase, KEY, ZIP)];
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
    for (const value of [...buyerStrings, "Engraved"]) {
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
