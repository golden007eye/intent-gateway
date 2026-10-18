// The Shop wallet adapter (plan G7a; ADR-0017): the WalletAdapter port over the developer's own Shop account.
// It sends through two callers the disclosure core provides (log before send, invariant 2), one per destination:
// `shop` (Shop's MCP server) and `shop_accounts` (token refresh and revocation). It returns only projections
// (project.ts).
//
// Rules kept here, before anything is sent, each as the S1 spike observed Shop (2026-10-18):
// - Delivery: create_checkout carries the lines only, no address and no address id; Shop fills the buyer's preferred
//   saved address itself. An answer that asks for address fields throws AddressFieldsRequiredError and is never
//   retried with fields (plan kill criterion K4; invariant 3).
// - create_checkout is sent once per call and never retried: Shop makes a new checkout for a replayed idempotency key.
//   A send that may have reached Shop with no usable answer is CheckoutUnconfirmedError.
// - Payment: complete_checkout pays with the checkout's `delegated_budget` instrument only (the buyer's agent budget,
//   no Shop prompt), forwarded exactly as Shop offered it plus `selected: true`; never the Shop Pay card beside it.
//   No budget instrument: CompletionRefusedError(`no_budget_instrument`), nothing sent. An instrument that carries a
//   billing address, or anything else findIdentity flags, is refused before the send (AddressFieldsRequiredError).
// - Tokens: an access token about to expire, or one Shop answers 401 to, is refreshed through the account server
//   (logged first, the refresh token digested), and the new tokens are handed to `onCredentials` for the vault. Only
//   a read (get_account, get_checkout, search_orders) is sent again after a refresh; create_checkout and
//   complete_checkout never are.
// - Every idempotency key is a UUID v4 (Shop's schema: `format: uuid`).
import { randomUUID } from "node:crypto";
import { findIdentity } from "../privacy/index.ts";
import {
  AddressFieldsRequiredError,
  type CheckoutIdStore,
  type CheckoutLocator,
  type CheckoutRequest,
  CheckoutUnconfirmedError,
  type CompleteOptions,
  CompletionRefusedError,
  memoryCheckoutIds,
  type SendCondition,
  type WalletAdapter,
  type WalletCheckout,
  WalletRailError,
} from "../wallet/index.ts";
import { refreshTokens, ShopLinkError } from "./oauth.ts";
import {
  asksForAddressFields,
  budgetInstrument,
  checkoutOf,
  ORDERS_PAGE,
  projectAccount,
  projectCheckout,
  projectOrders,
  railLabel,
  readToolAnswer,
  record,
  STORE_DOMAIN,
  type ToolAnswer,
} from "./project.ts";
import { REVOKE, type ShopTool, ShopTransportError, type WireResponse } from "./rpc.ts";

/** A disclosed caller (src/disclosure's DisclosedWallet in shape): logs, then sends, one request. */
export interface ShopCaller {
  call(operation: string, payload: unknown, options?: { purchase?: string; unless?: SendCondition }): Promise<WireResponse>;
}

/** The linked account's tokens, as the wallet vault keeps them (written by `intent wallet link shop`, plan G8). */
export interface ShopCredentials {
  /** The Shop OAuth client the tokens were issued to: refresh and revocation name it. */
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** When the access token expires (milliseconds since the epoch), or null/absent when Shop did not say. */
  readonly expiresAt?: number | null;
}

/** The vault text for Shop credentials: `{"v":1,"client_id","access_token","refresh_token"[,"expires_at"]}`. */
export function shopCredentialsText(credentials: ShopCredentials): string {
  const expires = typeof credentials.expiresAt === "number" ? { expires_at: credentials.expiresAt } : {};
  return JSON.stringify({ v: 1, client_id: credentials.clientId, access_token: credentials.accessToken, refresh_token: credentials.refreshToken, ...expires });
}

/**
 * Shop credentials from the vault text, or null when it holds none the adapter can use. The client id is the one the
 * wallet was linked with, kept in the vault; `fallbackClientId` stands in only for a vault written before the client
 * id was kept there (no `client_id`), and is then written into the vault at the next refresh.
 */
export function parseShopCredentials(text: string, fallbackClientId?: string): ShopCredentials | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const v = record(value);
  if (v?.v !== 1 || typeof v.access_token !== "string" || v.access_token === "") return null;
  const stored = typeof v.client_id === "string" && v.client_id !== "" ? v.client_id : null;
  // A client_id that is there but not a usable string is a damaged vault, not an older one: no fallback.
  const clientId = stored ?? (v.client_id === undefined ? (fallbackClientId ?? null) : null);
  if (clientId === null) return null;
  const refresh = typeof v.refresh_token === "string" && v.refresh_token !== "" ? v.refresh_token : null;
  const expiresAt = Number.isSafeInteger(v.expires_at) && (v.expires_at as number) > 0 ? (v.expires_at as number) : null;
  return { clientId, accessToken: v.access_token, refreshToken: refresh, expiresAt };
}

/**
 * Body paths of a Shop MCP request whose values are digested in the log, besides the `authorization` header and
 * every key whose last word is `token` (privacy's isSecretKey): the payment instrument's credential (S1: Shop puts
 * `credential {type, token}` on each instrument it offers), and the checkout id of get_checkout and
 * complete_checkout, which carries a credential (`?key=`).
 */
export const SHOP_SECRET_PATHS: readonly string[] = ["params.arguments.checkout.payment.instruments[0].credential", "params.arguments.id"];

/**
 * The checkout id get_checkout and complete_checkout send back to Shop, let through the identity scan (ADR-0019):
 * Shop issues it, and its random token or key can read as a card number by chance (a run of 13 to 19 digits that
 * passes Luhn), which would refuse the purchase's own checkout read. Only a whole value of exactly this shape: a
 * Checkout gid with an alphanumeric token and an optional alphanumeric `?key=`, so no text, `@` or space fits.
 */
export const SHOP_OPAQUE_IDS: readonly { readonly path: string; readonly pattern: RegExp }[] = [
  { path: "params.arguments.id", pattern: /^gid:\/\/shopify\/Checkout\/[A-Za-z0-9]{1,128}(?:\?key=[A-Za-z0-9]{1,256})?$/ },
];

/**
 * Body paths of a request to Shop's account server whose values are digested in the log: the device code (token
 * requests), a refresh token (a refresh request) and the token being revoked. privacy's secret keys already cover
 * each one; they are named here too, so the account server's credentials stay digested whatever privacy's list
 * becomes.
 */
export const SHOP_ACCOUNTS_SECRET_PATHS: readonly string[] = ["device_code", "refresh_token", "token"];

/** How long before its stated expiry an access token is refreshed. */
export const REFRESH_MARGIN_MS = 60_000;

export interface ShopAdapterOptions {
  readonly mcp: ShopCaller;
  readonly accounts: ShopCaller;
  /**
   * Null when the vault holds no usable tokens: every call then fails, and revoke sends nothing. Usable credentials
   * always name the client the tokens were issued to, which is the one refresh and revocation name.
   */
  readonly credentials: ShopCredentials | null;
  /**
   * Called with the new tokens after each refresh, before the request is sent again: the caller points the MCP
   * transport at the new access token and keeps the tokens in the vault. An error here fails the call.
   */
  readonly onCredentials?: (credentials: ShopCredentials) => Promise<void>;
  /** A UUID v4 for create_checkout; tests may fix it. */
  readonly newKey?: () => string;
  /** Milliseconds since the epoch, for the access token's expiry; Date.now by default. */
  readonly now?: () => number;
  /**
   * Where Shop's raw checkout ids are kept between processes (ADR-0019): the encrypted checkout vault in production,
   * so a restarted gateway can still reconcile a checkout it may have completed. In memory only by default.
   */
  readonly checkoutIds?: CheckoutIdStore;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VARIANT = /^gid:\/\/shopify\/ProductVariant\/[0-9]{1,20}$/;
/** The tools that only read: the only ones sent again after a token refresh. */
const READS: ReadonlySet<ShopTool> = new Set(["get_account", "get_checkout", "search_orders"]);
const RELINK = "Shop refused the token and it could not be refreshed: link the wallet again";

export function createShopAdapter(options: ShopAdapterOptions): WalletAdapter {
  const newKey = options.newKey ?? randomUUID;
  const now = options.now ?? Date.now;
  let current = options.credentials;

  /** Exchanges the refresh token for new tokens; a refusal means the wallet has to be linked again. */
  async function renew(): Promise<void> {
    const credentials = current;
    if (credentials === null || credentials.refreshToken === null) throw new WalletRailError(401, null, RELINK);
    let renewed: ShopCredentials;
    try {
      renewed = await refreshTokens(options.accounts, credentials, now);
    } catch (error) {
      if (error instanceof ShopLinkError) throw new WalletRailError(401, null, RELINK);
      // The account server was not reached: the request the refresh was for went no further (a create_checkout it
      // was for made no checkout, so it is not read as unconfirmed).
      if (error instanceof ShopTransportError) throw new WalletRailError(0, null, "the Shop token could not be refreshed: Shop's account server cannot be reached");
      throw error;
    }
    current = renewed;
    await options.onCredentials?.(renewed);
  }

  const expiring = (): boolean => typeof current?.expiresAt === "number" && current.refreshToken !== null && now() >= current.expiresAt - REFRESH_MARGIN_MS;

  async function tool(name: ShopTool, args: unknown, purchase?: string, unless?: SendCondition): Promise<ToolAnswer> {
    if (current === null) throw new WalletRailError(0, null, "no Shop token in the wallet vault: link the wallet again");
    if (expiring()) await renew();
    const send = async (): Promise<ToolAnswer> =>
      readToolAnswer(await options.mcp.call(name, args, { ...(purchase === undefined ? {} : { purchase }), ...(unless === undefined ? {} : { unless }) }));
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof WalletRailError) || error.httpStatus !== 401) throw error;
      // A 401 (S1: an expired or bad token) is refreshed; only a read is sent again, once.
      await renew();
      if (!READS.has(name)) throw new WalletRailError(401, null, "Shop refused the token; it was refreshed, and this request was not sent again");
      return send();
    }
  }

  function refused(answer: ToolAnswer): void {
    if (answer.isError) throw new WalletRailError(200, null, railLabel(answer.railCode), answer.railCode);
  }

  // Shop's checkout ids by their sha256 reference: an id carries a credential (`?key=`), so it is never returned,
  // recorded or logged in clear (SHOP_SECRET_PATHS digests it in each request). Held in memory, and in the checkout
  // id store (encrypted at rest in production) so a restarted gateway can still reach the checkout.
  const checkoutIds = new Map<string, string>();
  const kept = options.checkoutIds ?? memoryCheckoutIds();

  async function hold(answer: ToolAnswer, store: string, shipToPostalCode: string | undefined): Promise<WalletCheckout> {
    const { checkout, checkoutId } = projectCheckout(answer.content, store, shipToPostalCode);
    if (checkoutIds.get(checkout.checkoutRef) !== checkoutId) {
      checkoutIds.set(checkout.checkoutRef, checkoutId);
      await kept.set(checkout.checkoutRef, checkoutId);
    }
    return checkout;
  }

  async function held(checkout: CheckoutLocator): Promise<string> {
    const id = checkoutIds.get(checkout.checkoutRef) ?? (await kept.get(checkout.checkoutRef));
    if (id === null) throw new WalletRailError(0, null, "this gateway does not hold that checkout's id");
    checkoutIds.set(checkout.checkoutRef, id);
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
      return projectAccount(answer.content);
    },

    async createCheckout(request: CheckoutRequest) {
      checkStore(request.storeDomain);
      for (const line of request.lines) {
        if (!VARIANT.test(line.variantRef) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) {
          throw new TypeError("a Shop line is a ProductVariant gid and a positive quantity");
        }
      }
      const key = newKey();
      if (!UUID_V4.test(key)) throw new TypeError("a Shop idempotency key is a UUID v4");
      let answer: ToolAnswer;
      try {
        answer = await tool(
          "create_checkout",
          { shop: request.storeDomain, checkout: { line_items: request.lines.map((l) => ({ item: { id: l.variantRef }, quantity: l.quantity })) }, meta: { "idempotency-key": key } },
          request.purchase,
          request.sendUnless,
        );
      } catch (error) {
        throw unconfirmed(error);
      }
      if (asksForAddressFields(answer.content)) throw new AddressFieldsRequiredError("delivery");
      refused(answer);
      try {
        return await hold(answer, request.storeDomain, request.shipToPostalCode);
      } catch (error) {
        // Shop answered without a checkout the gateway can hold: one may exist all the same.
        throw error instanceof WalletRailError ? new CheckoutUnconfirmedError(error) : error;
      }
    },

    async completeCheckout(checkout: CheckoutLocator, purchase: string, idempotencyKey: string, completeOptions: CompleteOptions) {
      const { shipToPostalCode, precheck, sendUnless } = completeOptions;
      checkStore(checkout.storeDomain);
      if (!UUID_V4.test(idempotencyKey)) throw new TypeError("a Shop idempotency key is a UUID v4");
      const id = await held(checkout);
      // The fresh read the completer precheck runs on (contract Appendix G step 1): this process, no cached read.
      const read = await tool("get_checkout", { shop: checkout.storeDomain, id }, purchase);
      refused(read);
      const fresh = await hold(read, checkout.storeDomain, shipToPostalCode);
      const refusal = precheck?.(fresh) ?? null;
      if (refusal !== null) throw new CompletionRefusedError(refusal, fresh);
      // The agent budget, never the card Shop offers beside it (S1 step 6).
      const instrument = budgetInstrument(checkoutOf(read.content));
      if (instrument === null) throw new CompletionRefusedError("no_budget_instrument", fresh);
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
        sendUnless,
      );
      refused(answer);
      return hold(answer, checkout.storeDomain, shipToPostalCode);
    },

    async getCheckout(checkout: CheckoutLocator, purchase: string, shipToPostalCode?: string) {
      checkStore(checkout.storeDomain);
      const answer = await tool("get_checkout", { shop: checkout.storeDomain, id: await held(checkout) }, purchase);
      refused(answer);
      return hold(answer, checkout.storeDomain, shipToPostalCode);
    },

    async release(checkout: CheckoutLocator) {
      checkoutIds.delete(checkout.checkoutRef);
      await kept.delete(checkout.checkoutRef);
    },

    async orders() {
      // One page and no filter; a cursor would be a value from Shop sent back unread. The period is applied to the
      // projected times (src/wallet checkOrders).
      const answer = await tool("search_orders", { pagination: { limit: ORDERS_PAGE } });
      refused(answer);
      return projectOrders(answer.content);
    },

    async revoke() {
      const credentials = current;
      if (credentials === null) return "not_sent";
      // Both tokens: Shop answered 200 to the refresh token's revocation and kept the access token working (S1 step 12).
      const tokens: [string, string][] = [...(credentials.refreshToken === null ? [] : [[credentials.refreshToken, "refresh_token"] as [string, string]]), [credentials.accessToken, "access_token"]];
      let acknowledged = 0;
      let failure: Error | null = null;
      for (const [token, hint] of tokens) {
        try {
          const response = await options.accounts.call(REVOKE, { token, token_type_hint: hint, client_id: credentials.clientId });
          // RFC 7009: 200 means the server holds the token revoked. Anything else is not revoked (invariant 5).
          if (response.status === 200) acknowledged++;
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (failure !== null && acknowledged === 0) throw failure;
      return acknowledged === tokens.length ? "revoked" : "not_revoked";
    },
  };
}

/**
 * What a failed create_checkout send means: refused by Shop (an HTTP 4xx answer, the token included) or never sent (no
 * connection, refused by the log), so no checkout exists; or anything else (a timeout, a cut connection, a 5xx or an
 * unreadable answer), so one may exist: CheckoutUnconfirmedError.
 */
function unconfirmed(error: unknown): unknown {
  if (error instanceof ShopTransportError) return error.neverLeft ? error : new CheckoutUnconfirmedError(error);
  if (error instanceof WalletRailError) return error.httpStatus === 0 || (error.httpStatus >= 400 && error.httpStatus < 500) ? error : new CheckoutUnconfirmedError(error);
  return error;
}
