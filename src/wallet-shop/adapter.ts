// The Shop wallet adapter (plan G7a; ADR-0017): the WalletAdapter port over the developer's own Shop account.
// It sends through two callers the disclosure core provides (log before send, invariant 2), one per destination:
// `shop` (Shop's MCP server) and `shop_accounts` (revocation). It returns only projections (project.ts).
//
// Invariant 3 rules kept here, before anything is sent:
// - Delivery is chosen by the account's saved-address id only, never by address fields. With no saved-address id
//   the adapter throws AddressFieldsRequiredError and sends no create_checkout; a create_checkout answer that asks
//   for address fields throws the same and is never retried with fields (plan kill criterion K4).
// - complete_checkout forwards the payment instrument exactly as Shop offered it (Shop's rule), so an instrument
//   that carries a billing address, or anything else findIdentity flags, is refused before the send:
//   AddressFieldsRequiredError("payment"). The adapter does not strip it and try again: whether Shop needs it is
//   open (K4), and a money path does not improvise.
// - Every idempotency key is a UUID v4 (Shop's schema: `format: uuid`).
import { randomUUID } from "node:crypto";
import { findIdentity } from "../privacy/index.ts";
import {
  AddressFieldsRequiredError,
  type CheckoutLocator,
  type CheckoutRequest,
  type WalletAdapter,
  type WalletCheckout,
  WalletRailError,
} from "../wallet/index.ts";
import {
  asksForAddressFields,
  checkoutOf,
  ORDERS_PAGE,
  projectAccount,
  projectCheckout,
  projectOrders,
  readToolAnswer,
  record,
  STORE_DOMAIN,
  type ToolAnswer,
} from "./project.ts";
import { REVOKE, type ShopTool, type WireResponse } from "./rpc.ts";

/** A disclosed caller (src/disclosure's DisclosedWallet in shape): logs, then sends, one request. */
export interface ShopCaller {
  call(operation: string, payload: unknown, options?: { purchase?: string }): Promise<WireResponse>;
}

/** The linked account's tokens, as the wallet vault keeps them (written by `intent wallet link shop`, plan G8). */
export interface ShopCredentials {
  /** The Shop OAuth client the tokens were issued to: revocation names it. */
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/** The vault text for Shop credentials: `{"v":1,"client_id","access_token","refresh_token"}`. */
export function shopCredentialsText(credentials: ShopCredentials): string {
  return JSON.stringify({ v: 1, client_id: credentials.clientId, access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
}

/** Shop credentials from the vault text, or null when it holds none the adapter can use. */
export function parseShopCredentials(text: string): ShopCredentials | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const v = record(value);
  if (v?.v !== 1 || typeof v.client_id !== "string" || v.client_id === "" || typeof v.access_token !== "string" || v.access_token === "") return null;
  const refresh = typeof v.refresh_token === "string" && v.refresh_token !== "" ? v.refresh_token : null;
  return { clientId: v.client_id, accessToken: v.access_token, refreshToken: refresh };
}

/**
 * Body paths of a Shop MCP request whose values are digested in the log, besides the `authorization` header and
 * every key whose last word is `token` (privacy's isSecretKey): the payment instrument's credential, which is a
 * Shop Pay token under whatever name Shop gives it, and the checkout id of get_checkout and complete_checkout, which
 * can carry a credential (`?key=`).
 */
export const SHOP_SECRET_PATHS: readonly string[] = ["params.arguments.checkout.payment.instruments[0].credential", "params.arguments.id"];

/**
 * Body paths of a request to Shop's account server whose values are digested in the log: the device code (token
 * requests), a refresh token and the token being revoked. privacy's secret keys already cover each one; they are
 * named here too, so the account server's credentials stay digested whatever privacy's list becomes.
 */
export const SHOP_ACCOUNTS_SECRET_PATHS: readonly string[] = ["device_code", "refresh_token", "token"];

export interface ShopAdapterOptions {
  readonly mcp: ShopCaller;
  readonly accounts: ShopCaller;
  /**
   * Null when the vault holds no usable tokens: every call then fails, and revoke sends nothing. Usable credentials
   * always name the client the tokens were issued to, which is the one revocation names.
   */
  readonly credentials: ShopCredentials | null;
  /** A UUID v4 for create_checkout; tests may fix it. */
  readonly newKey?: () => string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VARIANT = /^gid:\/\/shopify\/ProductVariant\/[0-9]{1,20}$/;

export function createShopAdapter(options: ShopAdapterOptions): WalletAdapter {
  const newKey = options.newKey ?? randomUUID;

  async function tool(name: ShopTool, args: unknown, purchase?: string): Promise<ToolAnswer> {
    if (options.credentials === null) throw new WalletRailError(0, null, "no Shop token in the wallet vault: link the wallet again");
    const response = await options.mcp.call(name, args, purchase === undefined ? {} : { purchase });
    return readToolAnswer(response);
  }

  function refused(answer: ToolAnswer): void {
    if (answer.isError) throw new WalletRailError(200, null, "Shop refused the request");
  }

  // Shop's checkout ids by their sha256 reference, in memory only: an id can carry a credential (`?key=`), so it is
  // never returned, recorded or logged in clear (SHOP_SECRET_PATHS digests it in each request).
  const checkoutIds = new Map<string, string>();

  function hold(answer: ToolAnswer, store: string, shipToPostalCode: string | undefined): WalletCheckout {
    const { checkout, checkoutId } = projectCheckout(answer.content, store, shipToPostalCode);
    checkoutIds.set(checkout.checkoutRef, checkoutId);
    return checkout;
  }

  function held(checkout: CheckoutLocator): string {
    const id = checkoutIds.get(checkout.checkoutRef);
    if (id === undefined) throw new WalletRailError(0, null, "this gateway process does not hold that checkout's id (it is kept in memory only)");
    return id;
  }

  function checkStore(store: string): void {
    if (!STORE_DOMAIN.test(store)) throw new TypeError("a Shop store is named by its myshopify.com domain");
  }

  return {
    rail: "shop",

    async account() {
      const answer = await tool("get_account", {});
      refused(answer);
      return projectAccount(answer.content).account;
    },

    async createCheckout(request: CheckoutRequest) {
      checkStore(request.storeDomain);
      for (const line of request.lines) {
        if (!VARIANT.test(line.variantRef) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) {
          throw new TypeError("a Shop line is a ProductVariant gid and a positive quantity");
        }
      }
      const account = await tool("get_account", {}, request.purchase);
      refused(account);
      const { savedAddressId } = projectAccount(account.content);
      // No opaque id to choose delivery by: Shop would need the address fields, which the gateway never sends.
      if (savedAddressId === null) throw new AddressFieldsRequiredError("delivery");
      const key = newKey();
      if (!UUID_V4.test(key)) throw new TypeError("a Shop idempotency key is a UUID v4");
      const answer = await tool(
        "create_checkout",
        {
          shop: request.storeDomain,
          checkout: {
            line_items: request.lines.map((l) => ({ item: { id: l.variantRef }, quantity: l.quantity })),
            fulfillment: {
              methods: [{ type: "shipping", destinations: [{ id: savedAddressId, type: "shipping_address" }], selected_destination_id: savedAddressId }],
            },
          },
          meta: { "idempotency-key": key },
        },
        request.purchase,
      );
      if (asksForAddressFields(answer.content)) throw new AddressFieldsRequiredError("delivery");
      refused(answer);
      return hold(answer, request.storeDomain, request.shipToPostalCode);
    },

    async completeCheckout(checkout: CheckoutLocator, purchase: string, idempotencyKey: string, shipToPostalCode?: string) {
      checkStore(checkout.storeDomain);
      if (!UUID_V4.test(idempotencyKey)) throw new TypeError("a Shop idempotency key is a UUID v4");
      const id = held(checkout);
      const current = await tool("get_checkout", { shop: checkout.storeDomain, id }, purchase);
      refused(current);
      const raw = checkoutOf(current.content);
      const offered = Array.isArray(record(raw.payment)?.instruments) ? (record(raw.payment)?.instruments as unknown[]).map(record) : [];
      const instrument = offered.find((i) => i?.selected === true) ?? offered[0] ?? null;
      if (instrument === null) throw new WalletRailError(200, null, "Shop offers no payment instrument for this checkout");
      // Forwarded exactly as offered, so identity in it would leave the gateway: refuse before the send (K4).
      if (findIdentity(instrument).length > 0) throw new AddressFieldsRequiredError("payment");
      const answer = await tool(
        "complete_checkout",
        {
          shop: checkout.storeDomain,
          id,
          checkout: { payment: { instruments: [{ ...instrument, selected: true }] } },
          meta: { "idempotency-key": idempotencyKey },
        },
        purchase,
      );
      refused(answer);
      return hold(answer, checkout.storeDomain, shipToPostalCode);
    },

    async getCheckout(checkout: CheckoutLocator, purchase: string, shipToPostalCode?: string) {
      checkStore(checkout.storeDomain);
      const answer = await tool("get_checkout", { shop: checkout.storeDomain, id: held(checkout) }, purchase);
      refused(answer);
      return hold(answer, checkout.storeDomain, shipToPostalCode);
    },

    async orders() {
      // One page and no filter: whether search_orders takes a date filter waits for S1, and a cursor would be a
      // value from Shop sent back unread. The period is applied to the projected times (src/wallet checkOrders).
      const answer = await tool("search_orders", { pagination: { limit: ORDERS_PAGE } });
      refused(answer);
      return projectOrders(answer.content);
    },

    async revoke() {
      const credentials = options.credentials;
      if (credentials === null) return "not_sent";
      const clientId = credentials.clientId;
      const token = credentials.refreshToken ?? credentials.accessToken;
      const hint = credentials.refreshToken === null ? "access_token" : "refresh_token";
      const response = await options.accounts.call(REVOKE, { token, token_type_hint: hint, client_id: clientId });
      // RFC 7009: 200 means the server holds the token revoked. Anything else is reported as not revoked (invariant 5).
      return response.status === 200 ? "revoked" : "not_revoked";
    },
  };
}
