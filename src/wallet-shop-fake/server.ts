// The fake Shop: Shop's MCP server and its account server (the OAuth device flow, token refresh and revocation), on
// 127.0.0.1 (plans G7a, G8). Its answers have the shapes the S1 spike captured from the real Shop (2026-10-18; UCP
// 2026-08-25), filled with made-up data only, including what makes Shop hard to hold safely:
// - MCP 2026-07-28, stateless: `initialize` is refused; each request must carry `Mcp-Method` (equal to the body's
//   method), `Mcp-Protocol-Version` and `params._meta` naming the protocol version, and `Mcp-Name` for a tool call.
//   A request that breaks this is answered 400 and recorded in `protocolErrors`.
// - get_account answers with the buyer's email, picture URL, full saved addresses with names and phone, a card with
//   its last digits and holder name, and a payment `credential {type, token}`, whatever the scope.
// - create_checkout takes the lines alone and fills delivery with the preferred saved address itself (a new
//   destination id), echoing the buyer's email, phone and the full address. It offers two instruments: the Shop Pay
//   card (`selected: false`) and the agent budget (`delegated_budget`, `selected: true`).
// - create_checkout replayed with the same idempotency key makes a NEW checkout (S1 step 6 --replay).
// - complete_checkout answers synchronously with the order; a completed checkout offers no instrument any more.
// - A tool error is HTTP 200 with `isError: true`, `ucp.status: "error"` and `messages[{code, severity}]`; a schema
//   error or an unknown tool is HTTP 400 with JSON-RPC -32602; a bad token is HTTP 401.
// - The token answer has `access_token`, `expires_in: 3600`, a `refresh_token`, `scope` and `access_type`, no id
//   token. Revoking the refresh token leaves the access token working (S1 step 12); removing the connection in the
//   app (`connectionRemoved`) leaves the token answering with warnings and no account data (S1 step 12b).
// Fault switches (FakeShopFaults) cover the attack and failure cases of plans G7a, G7b and G8. Nothing here reaches
// a real Shop server.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_PROTOCOL = "2026-07-28";
const UCP_VERSION = "2026-08-25";
/** The buyer the fake answers with: every one of these strings must stay out of the chain and every tool result. */
export const FAKE_BUYER = {
  first_name: "Jane",
  last_name: "Doe-Fakename",
  email: "jane.doe@buyer.example",
  phone: "+1 415 555 2671",
  address1: "123 Main St",
  city: "Springfield",
  zip: "94107",
} as const;
/** The buyer's picture URL in get_account: personal, never kept. */
export const FAKE_PICTURE_URL = "https://cdn.shop.example/b/user-content/jane-doe-fakename.jpg";
/** The last digits of the buyer's Shop Pay card, as get_account and checkouts show them. */
export const FAKE_CARD_LAST4 = "4242";
/** A card number the fake puts in get_account when `spendRequestTool` is on. */
export const FAKE_PAN = "4111 1111 1111 1111";
/** The preferred saved address's id: a UUID, as S1 saw (never sent by the gateway). */
export const FAKE_ADDRESS_ID = "6f9c1e2a-0b7d-4c3e-9a51-2d8e4f7a1b30";
export const FAKE_STORE = "sticker-store.myshopify.com";
export const FAKE_STOREFRONT = "https://stickers.example";
export const FAKE_VARIANT = "gid://shopify/ProductVariant/4401";
export const FAKE_OTHER_VARIANT = "gid://shopify/ProductVariant/9999";
export const UNIT_PRICE_MINOR = 500;
export const SHIPPING_MINOR = 399;
/** The budget the fake's account has left by default (minor units, USD). */
export const FAKE_BUDGET_MINOR = 5000;
/** A second store search_catalog returns, so a merge has two stores to keep apart. */
export const FAKE_OTHER_STORE = "paper-goods.myshopify.com";
export const FAKE_OTHER_STOREFRONT = "https://paper.example";

/**
 * The fake catalog search_catalog answers from (G5), in the shape S1 step 5 saw: products with `variants[]`, each
 * variant with its gid, title, price {amount, currency}, availability and seller {domain, url}. It holds the demo's
 * one-tap sticker, a sticker sheet at a second store, and two items the gateway must drop: a CBD product and a
 * digital gift card.
 */
export const FAKE_CATALOG: readonly Record<string, unknown>[] = Object.freeze([
  {
    id: "gid://shopify/Product/7001",
    title: "Holographic sticker",
    url: `${FAKE_STOREFRONT}/products/holographic-sticker?variant=4401&_pos=1`,
    product_type: "Stickers",
    tags: ["sticker", "holographic"],
    media: [{ type: "image", url: `${FAKE_STOREFRONT}/cdn/holo.png` }],
    variants: [
      {
        id: FAKE_VARIANT,
        title: "Default",
        price: { amount: UNIT_PRICE_MINOR, currency: "USD" },
        availability: { available: true },
        seller: { domain: FAKE_STORE, url: FAKE_STOREFRONT },
      },
    ],
  },
  {
    id: "gid://shopify/Product/7002",
    title: "Vinyl sticker sheet",
    url: `${FAKE_OTHER_STOREFRONT}/products/vinyl-sheet`,
    product_type: "Stickers",
    tags: ["sticker"],
    variants: [
      {
        id: "gid://shopify/ProductVariant/5501",
        title: "Default",
        price: { amount: 350, currency: "USD" },
        availability: { available: true },
        seller: { domain: FAKE_OTHER_STORE, url: FAKE_OTHER_STOREFRONT },
      },
    ],
  },
  {
    id: "gid://shopify/Product/7003",
    title: "CBD calm sticker gummies",
    product_type: "Wellness",
    tags: ["sticker", "cbd"],
    variants: [
      {
        id: "gid://shopify/ProductVariant/6601",
        title: "Default",
        price: { amount: 1500, currency: "USD" },
        availability: { available: true },
        seller: { domain: FAKE_OTHER_STORE, url: FAKE_OTHER_STOREFRONT },
      },
    ],
  },
  {
    id: "gid://shopify/Product/7004",
    title: "Sticker shop e-gift card",
    product_type: "Gift Cards",
    tags: ["sticker"],
    variants: [
      {
        id: "gid://shopify/ProductVariant/6602",
        title: "$25",
        price: { amount: 2500, currency: "USD" },
        availability: { available: true },
        requires_shipping: false,
        seller: { domain: FAKE_STORE, url: FAKE_STOREFRONT },
      },
    ],
  },
]);
const CARD_ID = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40";

export interface FakeShopFaults {
  /** complete_checkout completes, then the connection is cut before any answer. */
  dropCompleteAnswer?: boolean;
  /** Added to every checkout total. */
  totalAboveMinor?: number;
  /** The checkout holds another variant than the one asked for. */
  otherVariant?: boolean;
  /** complete_checkout leaves the checkout asking the buyer (requires_escalation). */
  buyerReview?: boolean;
  /**
   * create_checkout answers as S1 step 11 saw a store that agents cannot complete at: status requires_escalation, no
   * instrument, an error message checkout_completion_ineligible (severity requires_buyer_review), `isError: false`.
   */
  ineligible?: boolean;
  /** complete_checkout answers a tool error checkout_completion_ineligible, and the checkout asks the buyer. */
  completeIneligible?: boolean;
  /** create_checkout is refused with a tool error (isError true). */
  createRefused?: boolean;
  /** The buyer's identity in every answer, error messages included. */
  identityEverywhere?: boolean;
  /** tools/list advertises a spend-request tool, and get_account carries a card number. */
  spendRequestTool?: boolean;
  /** create_checkout with no destination is refused as needing address fields (plan K4). */
  requiresAddressFields?: boolean;
  /** The offered payment instruments carry a billing address. */
  billingAddressOnInstrument?: boolean;
  /** Checkouts offer only the Shop Pay card: no agent budget (the buyer did not turn on "Allow agent to pay"). */
  noBudgetInstrument?: boolean;
  /** Checkouts offer two budget instruments (which one cannot be told). */
  twoBudgetInstruments?: boolean;
  /** get_account's budget left (minor units); null: no budget instrument (S1 step 3). FAKE_BUDGET_MINOR by default. */
  budgetMinor?: number | null;
  /** get_account's budget limit (minor units; 15000 by default) and how often it renews ("monthly" by default). */
  budgetLimitMinor?: number;
  budgetRenewal?: string;
  /** get_account's manage_connection link (S1: https://shop.app/account/connections by default); null: no such link. */
  manageConnectionUrl?: string | null;
  /** get_account's top-level currency ("USD" by default). */
  accountCurrency?: string;
  /** The buyer removed the connection in the Shop app: get_account answers warnings and no account data (S1 12b). */
  connectionRemoved?: boolean;
  /** The revocation endpoint's status (200 by default). */
  revokeStatus?: number;
  /** The host of the checkout's continue_url: the store's myshopify domain by default, as S1 saw it. */
  continueUrlHost?: string;
  /** Whether a repeated complete_checkout idempotency key returns the first result (true by default). */
  idempotency?: boolean;
  /** The `?key=` credential in every checkout id (random by default). */
  checkoutKey?: string;
  /** The token before `?` in every checkout id (16 random hex digits by default). */
  checkoutToken?: string;
  /** The order number of every completed order, the digits of its `gid://shopify/Order/<digits>` (a counter by default). */
  orderNumber?: string;
  /**
   * The token endpoint's answers to device-code polls, in order (the last one repeats): `ok` issues the tokens, the
   * others are RFC 8628 errors, and `unavailable` a proxy's HTTP 503 with an HTML body. ["ok"] by default.
   */
  deviceAnswers?: readonly DeviceAnswer[];
  /** The device authorization's `interval` (seconds; 5 by default) and `expires_in` (600 by default). */
  deviceInterval?: number;
  deviceExpiresIn?: number;
  /** The token answer carries no refresh token. */
  noRefreshToken?: boolean;
  /** The token endpoint refuses refresh grants (`invalid_grant`). */
  refuseRefresh?: boolean;
  /** A refresh grant issues a new refresh token too (rotation); by default the refresh token stays. */
  rotateRefresh?: boolean;
  /** search_orders says another page of orders exists. */
  moreOrders?: boolean;
  /** complete_checkout waits this long before it completes and answers (plan G7b test 4a). */
  completeDelayMs?: number;
  /** complete_checkout cuts the connection before it completes anything: the checkout stays open. */
  dropCompleteUnapplied?: boolean;
  /** create_checkout creates the checkout, then the connection is cut before any answer. */
  dropCreateAnswer?: boolean;
  /** These tools are answered with the given HTTP status and no result (`{get_checkout: 500}`). */
  toolHttpStatus?: Readonly<Record<string, number>>;
  /** Every checkout read reports this storefront URL as its merchant, ZIP or variant instead of its own. */
  merchantUrl?: string;
  shipToZip?: string;
  viewVariant?: string;
  /** The completed order's permalink is on this host instead of the checkout's store. */
  permalinkHost?: string;
  /** get_checkout answers invalid_checkout_id for every checkout. */
  forgetCheckouts?: boolean;
}

/**
 * An order search_orders returns. Each one is answered with the seller's name, line text, the delivery city and an
 * order-status URL with a credential besides these fields, as S1 saw; `identityEverywhere` adds the buyer.
 */
export interface FakeOrder {
  /** The merchant's order gid (`gid://shopify/Order/<digits>`): search_orders answers its digits as shopify_order_id. */
  readonly id: string;
  readonly totalMinor: number;
  readonly currency?: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** `email`: an order Shop read from an email, with no shopify_order_id and no seller domain. */
  readonly source?: "shopify" | "email";
}

export type DeviceAnswer = "ok" | "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | "unavailable";

/** One request to the account server's token endpoints, as received. */
export interface FakeOAuthRequest {
  readonly path: "/oauth/device" | "/oauth/token";
  readonly form: Readonly<Record<string, string>>;
  readonly contentType: string;
}

export interface FakeShopCall {
  readonly method: string;
  readonly tool: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

export interface FakeRevocation {
  readonly token: string;
  readonly tokenTypeHint: string | null;
  readonly clientId: string | null;
  readonly contentType: string;
}

export interface FakeShop {
  /** Shop's MCP server URL (INTENT_SHOP_MCP_URL). */
  readonly mcpUrl: string;
  /** Shop's account server URL (INTENT_SHOP_AUTH_URL). */
  readonly authUrl: string;
  /** The latest grant's tokens: one pair at start, and a new pair for each device-flow grant or refresh. */
  readonly accessToken: string;
  readonly refreshToken: string;
  /** The payment token inside each offered instrument's credential, and the one in get_account's card. */
  readonly instrumentToken: string;
  readonly accountCardToken: string;
  readonly clientId: string;
  /** The device code and user code of the device flow (fixed per fake). */
  readonly deviceCode: string;
  readonly userCode: string;
  faults: FakeShopFaults;
  readonly oauthRequests: FakeOAuthRequest[];
  readonly calls: FakeShopCall[];
  readonly revocations: FakeRevocation[];
  readonly protocolErrors: string[];
  /** How many complete_checkout calls reached the fake (whatever their answer). */
  readonly completeCount: number;
  /** How many create_checkout calls reached the fake (whatever their answer). */
  readonly createCount: number;
  /** The instrument type each complete_checkout paid with (`delegated_budget`, `shop_pay`). */
  readonly paidWith: string[];
  /** The arguments of each search_catalog call that reached the fake, in order. */
  readonly searches: Record<string, unknown>[];
  /** The account's order history, as search_orders answers it; a completed checkout adds its order. Tests may replace it. */
  orders: FakeOrder[];
  /** Every access token issued so far now answers 401, as an expired one does. */
  expireAccessTokens(): void;
  close(): Promise<void>;
}

interface Checkout {
  id: string;
  shop: string;
  variant: string;
  quantity: number;
  destinationId: string;
  status: string;
  orderId: string | null;
  budgetId: string;
  messages: Record<string, unknown>[];
}

const TOOLS = [
  "search_catalog",
  "get_product",
  "get_account",
  "create_checkout",
  "update_checkout",
  "get_checkout",
  "complete_checkout",
  "cancel_checkout",
  "search_orders",
  "get_order",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTION_GONE = ["claims_unavailable", "addresses_unavailable", "budget_unavailable", "payment_instruments_unavailable"];

export async function startFakeShop(options: { faults?: FakeShopFaults; clientId?: string } = {}): Promise<FakeShop> {
  const token = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;
  // Each grant is a token pair; each token is revoked on its own (S1: revoking the refresh token leaves the access
  // token working).
  const grants: { access: string; refresh: string }[] = [];
  const grant = (refresh?: string) => {
    const pair = { access: token("shpat_fake_access"), refresh: refresh ?? token("shprt_fake_refresh") };
    grants.push(pair);
    return pair;
  };
  grant();
  const current = () => grants[grants.length - 1] as { access: string; refresh: string };
  const instrumentToken = token("spt_fake_instrument");
  const accountCardToken = token("spt_fake_account_card");
  const deviceCode = token("fake_device_code");
  const userCode = "WDJB-MJHT";
  const oauthRequests: FakeOAuthRequest[] = [];
  let polls = 0;
  const revoked = new Set<string>();
  const expired = new Set<string>();
  const checkouts = new Map<string, Checkout>();
  const byKey = new Map<string, unknown>();
  const calls: FakeShopCall[] = [];
  const revocations: FakeRevocation[] = [];
  const protocolErrors: string[] = [];
  const paidWith: string[] = [];
  const searches: Record<string, unknown>[] = [];
  let completeCount = 0;
  let createCount = 0;
  let orders = 5000;

  const shop: FakeShop = {
    mcpUrl: "",
    authUrl: "",
    get accessToken() {
      return current().access;
    },
    get refreshToken() {
      return current().refresh;
    },
    instrumentToken,
    accountCardToken,
    clientId: options.clientId ?? "fake-shop-client",
    deviceCode,
    userCode,
    faults: { ...options.faults },
    oauthRequests,
    calls,
    revocations,
    protocolErrors,
    get completeCount() {
      return completeCount;
    },
    get createCount() {
      return createCount;
    },
    paidWith,
    searches,
    orders: [{ id: "gid://shopify/Order/4001", totalMinor: 899, createdAt: new Date(Date.now() - 86_400_000).toISOString() }],
    expireAccessTokens: () => {
      for (const g of grants) expired.add(g.access);
    },
    close: () => Promise.resolve(),
  };

  const identity = (): Record<string, unknown> => (shop.faults.identityEverywhere === true ? { customer: { ...FAKE_BUYER } } : {});
  const errorText = (text: string): string =>
    shop.faults.identityEverywhere === true ? `${text} for ${FAKE_BUYER.first_name} ${FAKE_BUYER.last_name} <${FAKE_BUYER.email}>` : text;

  /** A saved address as S1 saw one: names, street, locality, region, ZIP, country and phone. */
  function address(): Record<string, unknown> {
    return {
      first_name: FAKE_BUYER.first_name,
      last_name: FAKE_BUYER.last_name,
      street_address: FAKE_BUYER.address1,
      extended_address: "Apt 4",
      address_locality: FAKE_BUYER.city,
      address_region: "CA",
      address_country: "US",
      postal_code: FAKE_BUYER.zip,
      phone_number: FAKE_BUYER.phone,
    };
  }

  const links = (): Record<string, unknown>[] => [
    { type: "account", url: "https://shop.app/account", title: "Your Shop account" },
    ...(shop.faults.manageConnectionUrl === null
      ? []
      : [{ type: "manage_connection", url: shop.faults.manageConnectionUrl ?? "https://shop.app/account/connections", title: "Manage connected apps" }]),
  ];

  function account(): Record<string, unknown> {
    if (shop.faults.connectionRemoved === true) {
      return {
        ucp: { version: UCP_VERSION },
        signed_in: true,
        buyer: { email: FAKE_BUYER.email },
        links: links(),
        messages: CONNECTION_GONE.map((code) => ({ type: "warning", code, content: errorText(`Could not read ${code} for this connection.`) })),
      };
    }
    const budget = shop.faults.budgetMinor === undefined ? FAKE_BUDGET_MINOR : shop.faults.budgetMinor;
    return {
      ucp: { version: UCP_VERSION },
      signed_in: true,
      buyer: { email: FAKE_BUYER.email },
      picture: { type: "image", url: FAKE_PICTURE_URL },
      addresses: [{ type: "shipping_address", id: FAKE_ADDRESS_ID, ...address() }],
      preferred_address_id: FAKE_ADDRESS_ID,
      currency: shop.faults.accountCurrency ?? "USD",
      payment: {
        instruments:
          budget === null
            ? []
            : [{ handler_id: "shop_pay", type: "shop_pay", display: { limit: shop.faults.budgetLimitMinor ?? 15000, remaining_amount: budget, renewal_type: shop.faults.budgetRenewal ?? "monthly", renews_at: "2026-11-01T00:00:00Z" } }],
        ...(shop.faults.spendRequestTool === true ? { card_number: FAKE_PAN } : {}),
      },
      selectable_instruments: [
        {
          id: CARD_ID,
          handler_id: "shop_pay",
          type: "shop_pay",
          display: {
            funding_instrument: {
              type: "card",
              brand: "visa",
              last_digits: FAKE_CARD_LAST4,
              name: `${FAKE_BUYER.first_name} ${FAKE_BUYER.last_name}`,
              description: `Visa •••• ${FAKE_CARD_LAST4}`,
            },
          },
          credential: { type: "shop_token", token: accountCardToken },
        },
      ],
      preferred_instrument_id: CARD_ID,
      links: links(),
      messages: [],
      next: ["Show only returned budget amounts in the returned currency's minor units and any renewal details."],
    };
  }

  function instruments(c: Checkout): Record<string, unknown>[] {
    // A completed checkout offers none (S1 step 9); a store agents cannot complete at offers none (S1 step 11).
    if (c.status === "completed" || shop.faults.ineligible === true) return [];
    const billing = shop.faults.billingAddressOnInstrument === true ? { billing_address: address() } : {};
    const card = {
      id: CARD_ID,
      handler_id: "shop_pay",
      type: "shop_pay",
      selected: false,
      credential: { type: "shop_token", token: instrumentToken },
      display: { brand: "visa", last_digits: FAKE_CARD_LAST4, expiry_month: 12, expiry_year: 2030 },
      ...billing,
    };
    const budget = (id: string) => ({
      id,
      handler_id: "shop_pay",
      type: "delegated_budget",
      selected: true,
      // S1 saw only `type` in a checkout instrument's credential; the fake adds a token, so the tests prove that a
      // credential Shop may put there is digested in the log when the instrument is sent back.
      credential: { type: "shop_token", token: instrumentToken },
      display: { remaining_amount: FAKE_BUDGET_MINOR, limit: 15000, renewal_type: "monthly", renews_at: "2026-11-01T00:00:00Z" },
      ...billing,
    });
    if (shop.faults.noBudgetInstrument === true) return [{ ...card, selected: true }];
    return shop.faults.twoBudgetInstruments === true ? [card, budget(c.budgetId), budget(`${c.budgetId}x`)] : [card, budget(c.budgetId)];
  }

  function view(c: Checkout): Record<string, unknown> {
    const amount = UNIT_PRICE_MINOR * c.quantity;
    const token = c.id.replace(/^gid:\/\/shopify\/Checkout\//, "").replace(/\?.*$/, "");
    return {
      ucp: { version: UCP_VERSION },
      id: c.id,
      currency: "USD",
      // Shop echoes the buyer, though the gateway sent no buyer.
      buyer: {
        email: FAKE_BUYER.email,
        phone_number: FAKE_BUYER.phone,
        consent: { "dev.ucp.consent.analytics": { granted: true, source: "business", description: "Analytics and performance measurement" } },
      },
      line_items: [
        {
          id: `gid://shopify/CartLine/${randomUUID()}?cart=${token}`,
          item: { id: shop.faults.viewVariant ?? c.variant, title: "Holographic sticker", price: UNIT_PRICE_MINOR },
          quantity: c.quantity,
          totals: [{ type: "subtotal", amount, display_text: "Subtotal" }],
        },
      ],
      totals: [
        { type: "subtotal", amount, display_text: "Subtotal" },
        { type: "fulfillment", amount: SHIPPING_MINOR, display_text: "Shipping" },
        { type: "total", amount: amount + SHIPPING_MINOR + (shop.faults.totalAboveMinor ?? 0), display_text: "Total" },
      ],
      // Shop fills the preferred saved address under a new destination id, all fields echoed.
      fulfillment: {
        methods: [
          {
            id: "c2hpcHBpbmc=",
            type: "shipping",
            selected_destination_id: c.destinationId,
            destinations: [{ ...address(), ...(shop.faults.shipToZip === undefined ? {} : { postal_code: shop.faults.shipToZip }), id: c.destinationId }],
          },
        ],
      },
      // S1 saw no merchant field on a checkout; a test may add one.
      ...(shop.faults.merchantUrl === undefined ? {} : { merchant: { url: shop.faults.merchantUrl } }),
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      payment: { instruments: instruments(c) },
      ...(c.orderId === null
        ? {}
        : { order: { id: c.orderId, label: "FAKE1ORDER", permalink_url: `https://${shop.faults.permalinkHost ?? c.shop}/checkouts/cn/${token}/thank_you?key=${randomBytes(8).toString("hex")}` } }),
      messages: c.messages,
      status: c.status,
      // S1: an ineligible checkout's page is on the store's myshopify domain, a cart permalink with a key.
      ...(c.status === "completed" ? {} : { continue_url: `https://${shop.faults.continueUrlHost ?? c.shop}/cart/c/${token}?key=${randomBytes(8).toString("hex")}` }),
      next: ["Several instruments: ask which unless already chosen, not by position."],
      ...identity(),
    };
  }

  /** An MCP tool result: structured content plus a text copy, as Shop sends it. */
  const result = (content: Record<string, unknown>, isError = false) => ({ structuredContent: content, content: [{ type: "text", text: JSON.stringify(content) }], isError });
  const message = (code: string, severity: string, text: string, path: string | null = null) => ({
    type: "error",
    content_type: "plain",
    code,
    ...(path === null ? {} : { path }),
    content: errorText(text),
    severity,
  });
  /** A tool error as S1 step 8 saw it: HTTP 200, isError, ucp.status error, messages with a code and a severity. */
  const toolError = (code: string, path: string | null, text: string, severity = "unrecoverable") =>
    result({ ucp: { version: UCP_VERSION, status: "error" }, messages: [message(code, severity, text, path)], ...identity() }, true);

  function remember(key: unknown, answer: () => unknown): unknown {
    if (shop.faults.idempotency !== false && typeof key === "string" && byKey.has(key)) return byKey.get(key);
    const value = answer();
    if (typeof key === "string") byKey.set(key, value);
    return value;
  }

  function order(o: FakeOrder): Record<string, unknown> {
    const digits = o.id.split("/").at(-1) ?? "";
    const email = o.source === "email";
    return {
      id: randomUUID(),
      label: email ? "Items ordered on Thursday" : `Engraved for ${FAKE_BUYER.first_name} ${FAKE_BUYER.last_name}`,
      placed_at: o.createdAt,
      status: "paid",
      source: email ? "email" : "shopify",
      seller: email ? { name: "Some Store" } : { name: "Sticker Store", domain: new URL(FAKE_STOREFRONT).host, myshopify_domain: FAKE_STORE, shopify_shop_id: "10000000001" },
      line_items: [{ id: randomUUID(), item: { id: FAKE_VARIANT, title: `Engraved for ${FAKE_BUYER.first_name} ${FAKE_BUYER.last_name}`, price: 500 }, quantity: { total: 1, fulfilled: 0 } }],
      fulfillment: { expectations: [{ method_type: "shipping", destination: { address_locality: FAKE_BUYER.city, address_country: "US" } }] },
      // An order-status URL with a credential, not the checkout gid (S1 step 10).
      ...(email
        ? {}
        : {
            checkout_id: `${FAKE_STOREFRONT}/10000000001/orders/${randomBytes(16).toString("hex")}/authenticate?key=${randomBytes(8).toString("hex")}`,
            permalink_url: `${FAKE_STOREFRONT}/10000000001/orders/${randomBytes(16).toString("hex")}/authenticate?key=${randomBytes(8).toString("hex")}`,
            shopify_order_id: digits,
          }),
      payment_status: "paid",
      totals: [{ type: "total", amount: o.totalMinor }],
      currency: o.currency ?? "USD",
      note: `Leave at ${FAKE_BUYER.address1}, call ${FAKE_BUYER.phone}`,
      ...identity(),
    };
  }

  /** A tool call's answer; null for a tool the fake does not have (HTTP 400, -32602). */
  function callTool(name: string, args: Record<string, unknown>): unknown {
    const meta = (args.meta ?? {}) as Record<string, unknown>;
    const key = meta["idempotency-key"];
    switch (name) {
      case "get_account":
        return result({ ...account(), ...identity() });
      case "create_spend_request":
        return result({ card: { number: FAKE_PAN } });
      case "search_catalog": {
        searches.push(args);
        const catalog = (args.catalog ?? {}) as Record<string, unknown>;
        const words = (typeof catalog.query === "string" ? catalog.query : "").toLowerCase().split(/\s+/).filter((w) => w !== "");
        const max = (((catalog.filters ?? {}) as Record<string, unknown>).price as Record<string, unknown> | undefined)?.max;
        const products = FAKE_CATALOG.filter((p) => {
          const text = `${String(p.title)} ${(p.tags as string[]).join(" ")}`.toLowerCase();
          return words.length === 0 || words.some((w) => text.includes(w.replace(/s$/, "")));
        })
          .map((p): Record<string, unknown> & { variants: Record<string, unknown>[] } => ({ ...p, variants: (p.variants as Record<string, unknown>[]).filter((v) => typeof max !== "number" || ((v.price as { amount: number }).amount <= max)) }))
          .filter((p) => p.variants.length > 0)
          .map((p) => (shop.faults.identityEverywhere === true ? { ...p, title: `${String(p.title)} for ${FAKE_BUYER.email}`, ...identity() } : p));
        return result({ ucp: { version: UCP_VERSION }, products, pagination: { has_next_page: false }, ...identity() });
      }
      case "search_orders":
        return result({ ucp: { version: UCP_VERSION }, orders: shop.orders.map(order), pagination: { has_next_page: shop.faults.moreOrders === true, cursor: "eyJmYWtlIjp0cnVlfQ" }, ...identity() });
      case "create_checkout": {
        createCount++;
        if (typeof key !== "string" || !UUID.test(key)) return toolError("invalid", "$.meta.idempotency-key", "idempotency-key must be a uuid");
        if (typeof args.shop !== "string" || !/\.myshopify\.com$/.test(args.shop)) return toolError("invalid", "$.shop", "unknown shop");
        if (shop.faults.createRefused === true) return toolError("merchant_unavailable", null, "this store does not accept agent checkouts");
        const checkout = (args.checkout ?? {}) as Record<string, unknown>;
        if (shop.faults.requiresAddressFields === true && checkout.fulfillment === undefined) {
          return toolError("missing", "$.checkout.fulfillment.methods[0].destinations[0].street_address", "a shipping address is required");
        }
        const line = ((checkout.line_items ?? []) as Record<string, unknown>[])[0] ?? {};
        // Never deduplicated by key: a replay makes a new checkout (S1 step 6 --replay).
        const c: Checkout = {
          // A UCP checkout id carries a credential in its query, as Shopify's do.
          id: `gid://shopify/Checkout/${shop.faults.checkoutToken ?? randomBytes(8).toString("hex")}?key=${shop.faults.checkoutKey ?? randomBytes(16).toString("hex")}`,
          shop: args.shop,
          variant: shop.faults.otherVariant === true ? FAKE_OTHER_VARIANT : String((line.item as Record<string, unknown> | undefined)?.id),
          quantity: typeof line.quantity === "number" ? line.quantity : 1,
          destinationId: randomUUID(),
          status: shop.faults.ineligible === true ? "requires_escalation" : "ready_for_complete",
          orderId: null,
          budgetId: `shop_${randomBytes(12).toString("base64url").replace(/[-_]/g, "a")}`,
          messages:
            shop.faults.ineligible === true
              ? [message("checkout_completion_ineligible", "requires_buyer_review", "This checkout is ineligible for completion via API. Use the continue_url to complete checkout.")]
              : [],
        };
        checkouts.set(c.id, c);
        return result(view(c));
      }
      case "get_checkout": {
        const c = shop.faults.forgetCheckouts === true ? undefined : checkouts.get(String(args.id));
        return c === undefined ? toolError("invalid_checkout_id", null, "Invalid id format. Expected a Shopify Checkout GID.") : result(view(c));
      }
      case "complete_checkout": {
        completeCount++;
        if (typeof key !== "string" || !UUID.test(key)) return toolError("invalid", "$.meta.idempotency-key", "idempotency-key must be a uuid");
        const c = checkouts.get(String(args.id));
        if (c === undefined) return toolError("invalid_checkout_id", null, "Invalid id format. Expected a Shopify Checkout GID.");
        return remember(key, () => {
          const sent = ((((args.checkout ?? {}) as Record<string, unknown>).payment ?? {}) as Record<string, unknown>).instruments as Record<string, unknown>[] | undefined;
          const chosen = sent?.[0];
          const offered = instruments(c).find((i) => i.id === chosen?.id);
          if (sent?.length !== 1 || offered === undefined || chosen?.selected !== true) return toolError("invalid_instrument", "$.checkout.payment.instruments", "send one offered instrument with selected:true");
          paidWith.push(String(offered.type));
          if (shop.faults.completeIneligible === true) {
            c.status = "requires_escalation";
            return toolError("checkout_completion_ineligible", null, "This checkout is ineligible for completion via API.", "requires_buyer_review");
          }
          if (shop.faults.buyerReview === true) c.status = "requires_escalation";
          else {
            c.status = "completed";
            c.orderId = `gid://shopify/Order/${shop.faults.orderNumber ?? String(++orders)}`;
            shop.orders.push({ id: c.orderId, totalMinor: UNIT_PRICE_MINOR * c.quantity + SHIPPING_MINOR + (shop.faults.totalAboveMinor ?? 0), createdAt: new Date().toISOString() });
          }
          return result(view(c));
        });
      }
      default:
        return null;
    }
  }

  function rpcError(id: unknown, code: number, message: string) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message: errorText(message) } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]));
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && req.url === "/oauth/revoke") {
      const form = new URLSearchParams(text);
      const revoking = form.get("token") ?? "";
      revocations.push({ token: revoking, tokenTypeHint: form.get("token_type_hint"), clientId: form.get("client_id"), contentType: headers["content-type"] ?? "" });
      const status = shop.faults.revokeStatus ?? 200;
      // Each token on its own: the access token keeps working after its refresh token is revoked (S1 step 12).
      if (status === 200) {
        revoked.add(revoking);
        // An empty body, as S1 saw.
        res.writeHead(200);
        res.end();
      } else send(status, { error: "server_error", error_description: errorText("revocation failed") });
      return;
    }
    if (req.method === "POST" && (req.url === "/oauth/device" || req.url === "/oauth/token")) {
      const form = Object.fromEntries(new URLSearchParams(text));
      oauthRequests.push({ path: req.url, form, contentType: headers["content-type"] ?? "" });
      if (form.client_id !== shop.clientId) {
        send(401, { error: "invalid_client", error_description: errorText("unknown client") });
        return;
      }
      if (req.url === "/oauth/device") {
        const base = `http://${headers.host ?? "127.0.0.1"}`;
        send(200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${base}/activate`,
          verification_uri_complete: `${base}/activate?user_code=${userCode}`,
          expires_in: shop.faults.deviceExpiresIn ?? 600,
          interval: shop.faults.deviceInterval ?? 5,
        });
        return;
      }
      const tokens = (issued: { access: string; refresh: string }) => ({
        access_token: issued.access,
        token_type: "Bearer",
        expires_in: 3600,
        ...(shop.faults.noRefreshToken === true ? {} : { refresh_token: issued.refresh }),
        scope: "openid personal_agent",
        access_type: "offline",
      });
      if (form.grant_type === "refresh_token") {
        const owner = grants.find((g) => g.refresh === form.refresh_token);
        if (shop.faults.refuseRefresh === true || owner === undefined || revoked.has(owner.refresh)) {
          send(400, { error: "invalid_grant", error_description: errorText("refresh token invalid") });
          return;
        }
        send(200, tokens(grant(shop.faults.rotateRefresh === true ? undefined : owner.refresh)));
        return;
      }
      if (form.grant_type !== "urn:ietf:params:oauth:grant-type:device_code" || form.device_code !== deviceCode) {
        send(400, { error: "invalid_grant" });
        return;
      }
      const answers = shop.faults.deviceAnswers ?? ["ok"];
      const answer = answers[Math.min(polls++, answers.length - 1)] ?? "ok";
      if (answer === "unavailable") {
        res.writeHead(503, { "content-type": "text/html" });
        res.end("<html><body>Service Unavailable</body></html>");
        return;
      }
      if (answer !== "ok") {
        send(400, { error: answer, error_description: errorText(answer) });
        return;
      }
      send(200, tokens(grant()));
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      send(404, { error: "not_found" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      send(400, rpcError(null, -32700, "parse error"));
      return;
    }
    const method = typeof body.method === "string" ? body.method : "";
    const params = (body.params ?? {}) as Record<string, unknown>;
    const tool = method === "tools/call" && typeof params.name === "string" ? params.name : null;
    calls.push({ method, tool, headers, body });

    const protocol = ((params._meta ?? {}) as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"];
    const problems = [
      headers["mcp-method"] === method ? null : "Mcp-Method header missing or not the body's method",
      headers["mcp-protocol-version"] === FAKE_PROTOCOL ? null : "Mcp-Protocol-Version missing or wrong",
      protocol === FAKE_PROTOCOL ? null : "params._meta has no protocolVersion",
      tool === null || headers["mcp-name"] === tool ? null : "Mcp-Name header missing or not the tool name",
    ].filter((p): p is string => p !== null);
    if (method === "initialize") problems.push("initialize is refused: this server is stateless");
    if (problems.length > 0) {
      protocolErrors.push(...problems);
      send(400, rpcError(body.id, -32600, problems.join("; ")));
      return;
    }
    if (method === "tools/list") {
      const names = shop.faults.spendRequestTool === true ? [...TOOLS, "create_spend_request"] : TOOLS;
      send(200, { jsonrpc: "2.0", id: body.id, result: { tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) } });
      return;
    }
    if (method !== "tools/call" || tool === null) {
      send(200, rpcError(body.id, -32601, "method not found"));
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    if (bearer === undefined || !grants.some((g) => g.access === bearer) || revoked.has(bearer) || expired.has(bearer)) {
      send(401, rpcError(body.id, -32001, "invalid token"), { "www-authenticate": 'Bearer error="invalid_token"' });
      return;
    }
    const forced = shop.faults.toolHttpStatus?.[tool];
    if (forced !== undefined) {
      send(forced, { error: "server_error" });
      return;
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // A schema error: HTTP 400, JSON-RPC -32602 (S1 step 8).
    if ((tool === "get_checkout" || tool === "complete_checkout") && typeof args.id !== "string") {
      send(400, rpcError(body.id, -32602, "$.id: required property missing"));
      return;
    }
    if (tool === "complete_checkout") {
      if (shop.faults.dropCompleteUnapplied === true) {
        completeCount++;
        res.socket?.destroy();
        return;
      }
      const delay = shop.faults.completeDelayMs ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const answer = callTool(tool, args);
    if (answer === null) {
      // An unknown tool: HTTP 400, JSON-RPC -32602 (S1 step 8).
      send(400, rpcError(body.id, -32602, "Unknown tool: tool is not available in the hosted profile"));
      return;
    }
    if ((tool === "complete_checkout" && shop.faults.dropCompleteAnswer === true) || (tool === "create_checkout" && shop.faults.dropCreateAnswer === true)) {
      res.socket?.destroy();
      return;
    }
    send(200, { jsonrpc: "2.0", id: body.id, result: answer });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.socket?.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  Object.assign(shop, {
    mcpUrl: `${base}/mcp`,
    authUrl: `${base}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  });
  return shop;
}
