// The fake Shop: Shop's MCP server and its account server (the OAuth device flow and revocation), on 127.0.0.1
// (plans G7a, G8). It plays Shop as
// its public tool schemas and the S1 kit describe it, including what makes Shop hard to hold safely:
// - MCP 2026-07-28, stateless: `initialize` is refused; each request must carry `Mcp-Method` (equal to the body's
//   method), `Mcp-Protocol-Version` and `params._meta` naming the protocol version, and `Mcp-Name` for a tool call.
//   A request that breaks this is answered 400 and recorded in `protocolErrors`.
// - get_account answers with the buyer's name, email, phone, saved addresses and order history, always.
// - A checkout echoes its delivery address fields; idempotency keys must be UUIDs (`format: uuid`).
// Fault switches (FakeShopFaults) cover the attack and failure cases of plans G7a and G7b. Nothing here reaches a
// real Shop server.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_PROTOCOL = "2026-07-28";
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
/** A card number the fake puts in get_account when `spendRequestTool` is on. */
export const FAKE_PAN = "4111 1111 1111 1111";
export const FAKE_ADDRESS_ID = "gid://shopify/MailingAddress/7001";
export const FAKE_STORE = "sticker-store.myshopify.com";
export const FAKE_STOREFRONT = "https://stickers.example";
export const FAKE_VARIANT = "gid://shopify/ProductVariant/4401";
export const FAKE_OTHER_VARIANT = "gid://shopify/ProductVariant/9999";
export const UNIT_PRICE_MINOR = 500;
export const SHIPPING_MINOR = 399;

export interface FakeShopFaults {
  /** complete_checkout completes, then the connection is cut before any answer. */
  dropCompleteAnswer?: boolean;
  /** Added to every checkout total. */
  totalAboveMinor?: number;
  /** The checkout holds another variant than the one asked for. */
  otherVariant?: boolean;
  /** complete_checkout leaves the checkout asking the buyer (requires_escalation). */
  buyerReview?: boolean;
  /** create_checkout is refused: the merchant does not take Shop agent checkouts. */
  ineligible?: boolean;
  /** The buyer's identity in every answer, error messages included. */
  identityEverywhere?: boolean;
  /** tools/list advertises a spend-request tool, and get_account carries a card number. */
  spendRequestTool?: boolean;
  /** Saved addresses have no id, and an id-only destination is refused: Shop would need the address fields (K4). */
  requiresAddressFields?: boolean;
  /** The offered payment instrument carries a billing address. */
  billingAddressOnInstrument?: boolean;
  /** The revocation endpoint's status (200 by default). */
  revokeStatus?: number;
  /** Whether a repeated idempotency key returns the first result (true by default). */
  idempotency?: boolean;
  /** The saved address's id, in place of FAKE_ADDRESS_ID (a hostile id: a query with a token, address text). */
  addressId?: string;
  /** The `?key=` credential in every checkout id (random by default). */
  checkoutKey?: string;
  /**
   * The token endpoint's answers to device-code polls, in order (the last one repeats): `ok` issues the tokens, the
   * others are RFC 8628 errors. ["ok"] by default.
   */
  deviceAnswers?: readonly DeviceAnswer[];
  /** The device authorization's `interval` (seconds; 5 by default) and `expires_in` (600 by default). */
  deviceInterval?: number;
  deviceExpiresIn?: number;
  /** The token answer carries no refresh token (Shop documents none for a public client). */
  noRefreshToken?: boolean;
  /** search_orders says another page of orders exists. */
  moreOrders?: boolean;
  /** complete_checkout waits this long before it completes and answers (plan G7b test 4a). */
  completeDelayMs?: number;
  /** complete_checkout cuts the connection before it completes anything: the checkout stays open. */
  dropCompleteUnapplied?: boolean;
  /** These tools are answered with the given HTTP status and no result (`{get_checkout: 500}`). */
  toolHttpStatus?: Readonly<Record<string, number>>;
  /** Every checkout read reports this storefront URL, ZIP or variant instead of its own (a checkout changed after its quote). */
  merchantUrl?: string;
  shipToZip?: string;
  viewVariant?: string;
  /** get_checkout answers not_found for every checkout. */
  forgetCheckouts?: boolean;
}

/**
 * An order search_orders returns. Each one is answered with the buyer's name, email, phone, shipping address and line
 * text besides these fields, as Shop's order history holds them.
 */
export interface FakeOrder {
  readonly id: string;
  readonly totalMinor: number;
  readonly currency?: string;
  /** ISO 8601. */
  readonly createdAt: string;
}

export type DeviceAnswer = "ok" | "authorization_pending" | "slow_down" | "expired_token" | "access_denied";

/** One request to the account server's device flow, as received. */
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
  /** The latest grant's tokens: one pair at start, and a new pair for each device-flow grant. */
  readonly accessToken: string;
  readonly refreshToken: string;
  /** The Shop Pay token inside the offered payment instrument. */
  readonly instrumentToken: string;
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
  /** The account's order history, as search_orders answers it; a completed checkout adds its order. Tests may replace it. */
  orders: FakeOrder[];
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

export async function startFakeShop(options: { faults?: FakeShopFaults; clientId?: string } = {}): Promise<FakeShop> {
  const token = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;
  // Each grant is a token pair; revoking either token ends its grant only (Shop's connection removal).
  const grants: { access: string; refresh: string }[] = [];
  const grant = () => {
    const pair = { access: token("shpat_fake_access"), refresh: token("shprt_fake_refresh") };
    grants.push(pair);
    return pair;
  };
  grant();
  const current = () => grants[grants.length - 1] as { access: string; refresh: string };
  const instrumentToken = token("spt_fake_instrument");
  const deviceCode = token("fake_device_code");
  const userCode = "WDJB-MJHT";
  const oauthRequests: FakeOAuthRequest[] = [];
  let polls = 0;
  const revoked = new Set<string>();
  const checkouts = new Map<string, Checkout>();
  const byKey = new Map<string, unknown>();
  const calls: FakeShopCall[] = [];
  const revocations: FakeRevocation[] = [];
  const protocolErrors: string[] = [];
  let completeCount = 0;
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
    orders: [{ id: "gid://shopify/Order/4001", totalMinor: 899, createdAt: new Date(Date.now() - 86_400_000).toISOString() }],
    close: () => Promise.resolve(),
  };

  const identity = (): Record<string, unknown> => (shop.faults.identityEverywhere === true ? { buyer: { ...FAKE_BUYER } } : {});
  const errorText = (text: string): string =>
    shop.faults.identityEverywhere === true ? `${text} for ${FAKE_BUYER.first_name} ${FAKE_BUYER.last_name} <${FAKE_BUYER.email}>` : text;

  const addressId = (): string => shop.faults.addressId ?? FAKE_ADDRESS_ID;

  function address(): Record<string, unknown> {
    return {
      first_name: FAKE_BUYER.first_name,
      last_name: FAKE_BUYER.last_name,
      address1: FAKE_BUYER.address1,
      city: FAKE_BUYER.city,
      province_code: "CA",
      postal_code: FAKE_BUYER.zip,
      country_code: "US",
      phone: FAKE_BUYER.phone,
    };
  }

  function account(): Record<string, unknown> {
    const addresses = [shop.faults.requiresAddressFields === true ? address() : { id: addressId(), ...address() }];
    return {
      account: {
        name: `${FAKE_BUYER.first_name} ${FAKE_BUYER.last_name}`,
        email: FAKE_BUYER.email,
        phone: FAKE_BUYER.phone,
        budget: { remaining: { amount: 5000, currency: "USD" }, period: "total" },
        ...(shop.faults.requiresAddressFields === true ? {} : { preferred_address_id: addressId() }),
        addresses,
        orders: [{ id: "gid://shopify/Order/4001", shipping_address: address(), email: FAKE_BUYER.email }],
        payment: {
          instruments: [{ type: "shop_pay", display: { brand: "visa", last_digits: "4242" } }],
          ...(shop.faults.spendRequestTool === true ? { card_number: FAKE_PAN } : {}),
        },
      },
    };
  }

  function view(c: Checkout): Record<string, unknown> {
    const amount = UNIT_PRICE_MINOR * c.quantity;
    const instrument: Record<string, unknown> = {
      id: "pi_1",
      handler_id: "shop_pay",
      type: "shop_pay",
      credential: { type: "shop_token", token: instrumentToken },
      display: { brand: "visa", last_digits: "4242" },
      ...(shop.faults.billingAddressOnInstrument === true ? { billing_address: address() } : {}),
    };
    return {
      checkout: {
        id: c.id,
        status: c.status,
        currency: "USD",
        line_items: [{ id: "li_1", item: { id: shop.faults.viewVariant ?? c.variant, title: "Holographic sticker" }, quantity: c.quantity }],
        totals: [
          { type: "subtotal", amount },
          { type: "fulfillment", amount: SHIPPING_MINOR },
          { type: "total", amount: amount + SHIPPING_MINOR + (shop.faults.totalAboveMinor ?? 0) },
        ],
        merchant: { domain: c.shop, url: shop.faults.merchantUrl ?? FAKE_STOREFRONT },
        // Shop echoes the chosen destination's address fields.
        fulfillment: {
          methods: [
            {
              id: "m1",
              type: "shipping",
              destinations: [{ id: c.destinationId, type: "shipping_address", ...address(), ...(shop.faults.shipToZip === undefined ? {} : { postal_code: shop.faults.shipToZip }) }],
              selected_destination_id: c.destinationId,
            },
          ],
        },
        payment: { instruments: [instrument] },
        ...(c.orderId === null ? {} : { order: { id: c.orderId, permalink_url: `${FAKE_STOREFRONT}/orders/1` } }),
        ...identity(),
      },
    };
  }

  /** An MCP tool result: structured content plus a text copy, as Shop sends it. */
  const result = (content: Record<string, unknown>, isError = false) => ({ structuredContent: content, content: [{ type: "text", text: JSON.stringify(content) }], isError });
  const toolError = (code: string, path: string | null, text: string) =>
    result({ messages: [{ type: "error", code, ...(path === null ? {} : { path }), content: errorText(text) }], ...identity() }, true);

  function remember(key: unknown, answer: () => unknown): unknown {
    if (shop.faults.idempotency !== false && typeof key === "string" && byKey.has(key)) return byKey.get(key);
    const value = answer();
    if (typeof key === "string") byKey.set(key, value);
    return value;
  }

  function callTool(name: string, args: Record<string, unknown>): unknown {
    const meta = (args.meta ?? {}) as Record<string, unknown>;
    const key = meta["idempotency-key"];
    switch (name) {
      case "get_account":
        return result({ ...account(), ...identity() });
      case "create_spend_request":
        return result({ card: { number: FAKE_PAN } });
      case "search_orders":
        return result({
          orders: shop.orders.map((o) => ({
            id: o.id,
            name: `#${o.id.split("/").at(-1) ?? ""}`,
            created_at: o.createdAt,
            currency: o.currency ?? "USD",
            totals: [{ type: "total", amount: o.totalMinor }],
            merchant: { domain: FAKE_STORE, url: `${FAKE_STOREFRONT}/orders?customer=${encodeURIComponent(FAKE_BUYER.email)}` },
            customer: { first_name: FAKE_BUYER.first_name, last_name: FAKE_BUYER.last_name, email: FAKE_BUYER.email, phone: FAKE_BUYER.phone },
            email: FAKE_BUYER.email,
            shipping_address: address(),
            billing_address: address(),
            line_items: [{ item: { id: FAKE_VARIANT, title: `Engraved for ${FAKE_BUYER.first_name} ${FAKE_BUYER.last_name}` }, quantity: 1 }],
            note: `Leave at ${FAKE_BUYER.address1}, call ${FAKE_BUYER.phone}`,
          })),
          pagination: { has_next_page: shop.faults.moreOrders === true },
          ...identity(),
        });
      case "create_checkout": {
        if (typeof key !== "string" || !UUID.test(key)) return toolError("invalid", "$.meta.idempotency-key", "idempotency-key must be a uuid");
        if (typeof args.shop !== "string" || !/\.myshopify\.com$/.test(args.shop)) return toolError("invalid", "$.shop", "unknown shop");
        if (shop.faults.ineligible === true) return toolError("merchant_ineligible", null, "this store does not accept agent checkouts");
        const checkout = (args.checkout ?? {}) as Record<string, unknown>;
        const line = ((checkout.line_items ?? []) as Record<string, unknown>[])[0] ?? {};
        const method = (((checkout.fulfillment ?? {}) as Record<string, unknown>).methods as Record<string, unknown>[] | undefined)?.[0];
        const destination = (method?.destinations as Record<string, unknown>[] | undefined)?.[0];
        if (shop.faults.requiresAddressFields === true || typeof destination?.id !== "string" || destination.id !== addressId()) {
          return toolError("missing", "$.checkout.fulfillment.methods[0].destinations[0].address1", "a shipping address is required");
        }
        return remember(key, () => {
          const c: Checkout = {
            // A UCP checkout id carries a credential in its query, as Shopify's do.
            id: `gid://shopify/Checkout/${randomBytes(8).toString("hex")}?key=${shop.faults.checkoutKey ?? randomBytes(16).toString("hex")}`,
            shop: args.shop as string,
            variant: shop.faults.otherVariant === true ? FAKE_OTHER_VARIANT : String((line.item as Record<string, unknown> | undefined)?.id),
            quantity: typeof line.quantity === "number" ? line.quantity : 1,
            destinationId: destination.id as string,
            status: "ready_for_complete",
            orderId: null,
          };
          checkouts.set(c.id, c);
          return result(view(c));
        });
      }
      case "get_checkout": {
        const c = shop.faults.forgetCheckouts === true ? undefined : checkouts.get(String(args.id));
        return c === undefined ? toolError("not_found", "$.id", "checkout not found") : result(view(c));
      }
      case "complete_checkout": {
        completeCount++;
        if (typeof key !== "string" || !UUID.test(key)) return toolError("invalid", "$.meta.idempotency-key", "idempotency-key must be a uuid");
        const c = checkouts.get(String(args.id));
        if (c === undefined) return toolError("not_found", "$.id", "checkout not found");
        return remember(key, () => {
          if (shop.faults.buyerReview === true) c.status = "requires_escalation";
          else {
            c.status = "completed";
            c.orderId = `gid://shopify/Order/${String(++orders)}`;
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
      revocations.push({ token: form.get("token") ?? "", tokenTypeHint: form.get("token_type_hint"), clientId: form.get("client_id"), contentType: headers["content-type"] ?? "" });
      const status = shop.faults.revokeStatus ?? 200;
      if (status === 200) {
        // Revoking either token ends its grant, as Shop's connection removal does.
        const ended = grants.find((g) => g.access === form.get("token") || g.refresh === form.get("token"));
        if (ended !== undefined) {
          revoked.add(ended.access);
          revoked.add(ended.refresh);
        }
      }
      send(status, status === 200 ? {} : { error: "server_error", error_description: errorText("revocation failed") });
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
      if (form.grant_type !== "urn:ietf:params:oauth:grant-type:device_code" || form.device_code !== deviceCode) {
        send(400, { error: "invalid_grant" });
        return;
      }
      const answers = shop.faults.deviceAnswers ?? ["ok"];
      const answer = answers[Math.min(polls++, answers.length - 1)] ?? "ok";
      if (answer !== "ok") {
        send(400, { error: answer, error_description: errorText(answer) });
        return;
      }
      const issued = grant();
      send(200, {
        access_token: issued.access,
        token_type: "Bearer",
        expires_in: 3600,
        scope: form.scope ?? "openid personal_agent",
        ...(shop.faults.noRefreshToken === true ? {} : { refresh_token: issued.refresh }),
        // An id token names the buyer; the gateway must drop it.
        id_token: `fake.${Buffer.from(JSON.stringify({ email: FAKE_BUYER.email })).toString("base64url")}.sig`,
      });
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
    if (bearer === undefined || !grants.some((g) => g.access === bearer) || revoked.has(bearer)) {
      send(401, rpcError(body.id, -32001, "invalid token"), { "www-authenticate": 'Bearer error="invalid_token"' });
      return;
    }
    const forced = shop.faults.toolHttpStatus?.[tool];
    if (forced !== undefined) {
      send(forced, { error: "server_error" });
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
    const answer = callTool(tool, (params.arguments ?? {}) as Record<string, unknown>);
    if (answer === null) {
      send(200, rpcError(body.id, -32602, `unknown tool ${tool}`));
      return;
    }
    if (tool === "complete_checkout" && shop.faults.dropCompleteAnswer === true) {
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
