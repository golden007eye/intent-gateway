// Allow-list projection of Shop's answers (plan G7a; invariant 3). Shop answers with the buyer's email, phone, names,
// picture, full saved addresses and a per-instrument payment `credential {type, token}` (get_account, even under the
// scope `openid personal_agent`), and checkouts echo the buyer and the delivery address (S1 steps 3 and 6). Nothing of
// that leaves this file: each reader below copies out only the fields it names, so any field Shop adds is dropped by
// default.
//
// Kept: the budget left and whether the connection can still read the account; the checkout's sha256 reference (the
// id itself may hold a credential), its status, lines {variant_ref, quantity, title}, store domain, merchant origin,
// total, order id and whether it offers the agent budget as payment; from search_orders, each order's reference,
// total, merchant origin and time only. The ship-to ZIP is compared here, in memory, and only
// `match | differs | unknown` is kept. From an error, only the HTTP status, the JSON-RPC numeric code, Shop's error
// code token and a fixed local label are kept: Shop's message can carry identity and never reaches a tool result,
// stderr or the chain.
//
// The field names are the ones Shop returned in the S1 spike (2026-10-18; UCP 2026-08-25).
import { checkoutRefHash, coarsePostcode } from "../contract/index.ts";
import { findIdentity, ORDER_REF_AT } from "../privacy/index.ts";
import {
  type BudgetRenewal,
  type CatalogHit,
  RAIL_CODE,
  type ShipToMatch,
  type WalletAccount,
  type WalletCheckout,
  type WalletCheckoutStatus,
  type WalletLine,
  type WalletMoney,
  type WalletOrder,
  type WalletOrders,
  type WalletTotals,
  WalletRailError,
} from "../wallet/index.ts";
import type { WireResponse } from "./rpc.ts";

type Json = Record<string, unknown>;

/** A tool's answer: its structured content, whether Shop marked it an error, and the first error message's code. */
export interface ToolAnswer {
  readonly content: Json;
  readonly isError: boolean;
  /** The code of the answer's first error message (`checkout_completion_ineligible`) when it fits RAIL_CODE, else null. */
  readonly railCode: string | null;
}

/** Labels for JSON-RPC error codes; the message Shop sent with them is never read. */
const RPC_LABELS: Readonly<Record<number, string>> = {
  [-32700]: "Shop could not parse the request",
  [-32600]: "Shop refused the request as invalid",
  [-32601]: "Shop does not have that method",
  [-32602]: "Shop refused the request's arguments or tool",
  [-32603]: "Shop had an internal error",
};

/** Labels for the tool-level error codes S1 saw; any other code is named by its token only. */
const RAIL_LABELS: Readonly<Record<string, string>> = {
  checkout_completion_ineligible: "Shop says an agent cannot complete this checkout; it needs the buyer at the merchant's checkout",
  invalid_checkout_id: "Shop does not accept that checkout id",
};

/** The fixed label for a tool-level error with this code. */
export function railLabel(code: string | null): string {
  return (code === null ? undefined : RAIL_LABELS[code]) ?? "Shop refused the request";
}

/**
 * Reads one MCP answer. Throws WalletRailError, naming only a status, a code and a fixed label, for every transport
 * or JSON-RPC error: 401/403 (a bad or expired token, S1 step 8), and a JSON-RPC error at any HTTP status (Shop
 * answers a schema error or an unknown tool with HTTP 400 and -32602). A tool-level error (HTTP 200, `isError: true`,
 * `ucp.status: "error"`) is returned with `isError` set, for the caller to refuse.
 */
export function readToolAnswer(response: WireResponse): ToolAnswer {
  const { status } = response;
  if (status === 401 || status === 403) throw new WalletRailError(status, null, "Shop refused the token (expired or revoked): link the wallet again");
  const message = parseMessage(response);
  const error = record(message?.error);
  if (error !== null) {
    const code = Number.isInteger(error.code) ? (error.code as number) : null;
    throw new WalletRailError(status, code, (code === null ? undefined : RPC_LABELS[code]) ?? "Shop answered with an error");
  }
  if (status < 200 || status >= 300) throw new WalletRailError(status, null, "Shop answered with an HTTP error");
  if (message === null) throw new WalletRailError(status, null, "Shop's answer is not a JSON-RPC message");
  const result = record(message.result);
  if (result === null) throw new WalletRailError(status, null, "Shop's answer has no result");
  const content = structured(result) ?? {};
  const isError = result.isError === true || record(content.ucp)?.status === "error";
  return { content, isError, railCode: errorCode(content) };
}

function errorCode(content: Json): string | null {
  const code = [...list(content.messages), ...list(checkoutOf(content).messages)].find((m) => m.type === "error")?.code;
  return typeof code === "string" && RAIL_CODE.test(code) ? code : null;
}

function parseMessage(response: WireResponse): Json | null {
  const text = Buffer.from(response.body).toString("utf8");
  const type = response.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  // A streamed answer: the last `data:` line holds the JSON-RPC response.
  const json = type.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1)
    : text;
  try {
    return record(JSON.parse(json ?? "") as unknown);
  } catch {
    return null;
  }
}

/** structuredContent, else the first text content parsed as JSON. */
function structured(result: Json): Json | null {
  const content = record(result.structuredContent);
  if (content !== null) return content;
  const first = Array.isArray(result.content) ? record((result.content as unknown[])[0]) : null;
  if (typeof first?.text !== "string") return null;
  try {
    return record(JSON.parse(first.text) as unknown);
  } catch {
    return null;
  }
}

/**
 * get_account's warnings when the buyer removed the connection in the Shop app: the token still answers, but the
 * account's details, addresses, budget and cards are gone (S1 step 12b). Any one of them reads as not connected.
 */
export const CONNECTION_GONE = ["claims_unavailable", "addresses_unavailable", "budget_unavailable", "payment_instruments_unavailable"] as const;

/**
 * What the gateway keeps from get_account: the budget left and whether the connection still reads the account.
 * The budget is the one `payment.instruments[]` entry whose `display` has `remaining_amount` (integer minor units),
 * in the answer's top-level `currency` (S1 step 4). None, several, or a value that is not a non-negative integer
 * gives null: unknown, never assumed. The same entry's `limit` (integer minor units) and `renewal_type` (one of the
 * known words) are kept as the limit, with `renews_at` when it is an ISO 8601 UTC instant. The connections page is the `manage_connection` link
 * (S1: https://shop.app/account/connections), kept only when it is an https URL on shop.app with no credentials,
 * query or fragment; any other link gives null. With no such link at all, S1's page (SHOP_CONNECTIONS_URL).
 */
export function projectAccount(content: Json): WalletAccount {
  const warnings = list(content.messages).map((m) => m.code);
  const connected = !warnings.some((code) => (CONNECTION_GONE as readonly unknown[]).includes(code));
  const budget = connected ? budgetOf(content) : null;
  return { budgetRemaining: budget?.remaining ?? null, budgetLimit: budget?.limit ?? null, manageUrl: manageUrlOf(content), connected };
}

const RENEWALS: readonly BudgetRenewal[] = ["daily", "weekly", "monthly", "yearly"];
/** An ISO 8601 UTC instant to the second (or millisecond), the only shape of `renews_at` that is kept and printed. */
const RENEWS_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** The only host a connections page is taken from. */
export const SHOP_APP_HOST = "shop.app";

function budgetOf(content: Json): { remaining: WalletMoney; limit: WalletAccount["budgetLimit"] } | null {
  const currency = content.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  const budgets = list(record(content.payment)?.instruments)
    .map((i) => record(i.display))
    .filter((d): d is Json => d !== null && "remaining_amount" in d);
  if (budgets.length !== 1) return null;
  const { remaining_amount: remaining, limit, renewal_type: renewal, renews_at: renewsAt } = budgets[0] ?? {};
  if (!Number.isSafeInteger(remaining) || (remaining as number) < 0) return null;
  const known = RENEWALS.find((r) => r === renewal) ?? null;
  const renews = typeof renewsAt === "string" && RENEWS_AT.test(renewsAt) && !Number.isNaN(Date.parse(renewsAt)) ? renewsAt : null;
  const limited = Number.isSafeInteger(limit) && (limit as number) > 0 ? { amount: { amountMinor: limit as number, currency }, renewal: known, renewsAt: renews } : null;
  return { remaining: { amountMinor: remaining as number, currency }, limit: limited };
}

/** Shop's connections page as S1 saw it, used only when Shop's answer has no manage_connection link at all. */
export const SHOP_CONNECTIONS_URL = "https://shop.app/account/connections";

function manageUrlOf(content: Json): string | null {
  const links = list(content.links).filter((l) => l.type === "manage_connection");
  if (links.length === 0) return SHOP_CONNECTIONS_URL;
  if (links.length !== 1 || typeof links[0]?.url !== "string" || links[0].url.length > 512) return null;
  let url: URL;
  try {
    url = new URL(links[0].url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== SHOP_APP_HOST || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return url.href;
}

const STATUS: Readonly<Record<string, WalletCheckoutStatus>> = {
  incomplete: "open",
  ready_for_complete: "open",
  complete_in_progress: "processing",
  requires_escalation: "buyer_review",
  completed: "completed",
  canceled: "failed",
  cancelled: "failed",
  expired: "failed",
};
/** A myshopify store domain, as Shop names a store. */
export const STORE_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
/** A variant or order id that may be kept: no query, so no `?key=` credential can ride along. */
const REF = /^[A-Za-z0-9:/_.-]{1,256}$/;
/** A checkout id as Shop sends it. It may carry a credential (`?key=<secret>`), so it is a secret value throughout. */
const CHECKOUT_ID = /^[A-Za-z0-9:/_.?=&%-]{1,512}$/;
/** The payment instrument type that pays from the buyer's agent budget, with no Shop prompt (S1 steps 6 and 9). */
export const BUDGET_INSTRUMENT = "delegated_budget";

/**
 * How a checkout is named wherever it is kept or shown: the contract's checkout ref hash, `sha256:` and the hex
 * SHA-256 of the id up to its first `?` (Appendix G, amendment L1). The query can hold a credential (UCP's `?key=`)
 * and can differ between reads; the part before it names the checkout. An id with nothing before `?` has no ref.
 */
export function checkoutRefOf(checkoutId: string): string | null {
  return checkoutRefHash(checkoutId);
}

/** The raw checkout object of an answer (`checkout`, or the answer itself, as Shop sends it). */
export function checkoutOf(content: Json): Json {
  return record(content.checkout) ?? content;
}

/**
 * The checkout's agent-budget instrument, exactly as Shop offered it, or null. Shop offers the buyer's Shop Pay card
 * (`type: shop_pay`, `selected: false`) beside the budget (`type: delegated_budget`, an id `shop_…`,
 * `selected: true`); one tap pays with the budget only, never the card. Exactly one budget instrument with a
 * non-empty id, or none: several cannot be told apart, and picking by position is what Shop's own guidance forbids.
 */
export function budgetInstrument(checkout: Json): Json | null {
  const budgets = list(record(checkout.payment)?.instruments).filter((i) => i.type === BUDGET_INSTRUMENT && typeof i.id === "string" && i.id !== "");
  return budgets.length === 1 ? (budgets[0] ?? null) : null;
}

/**
 * The checkout in our terms, and Shop's raw checkout id for the adapter to hold. `requestedStore` is the store the
 * gateway named in its request (`shop`), kept when Shop reports none: S1 saw no merchant field on a checkout. An
 * unknown status reads as `processing`: neither completable nor terminal, so the gateway waits or reconciles.
 */
export function projectCheckout(
  content: Json,
  requestedStore: string,
  shipToPostalCode: string | undefined,
): { checkout: WalletCheckout; checkoutId: string } {
  const checkout = checkoutOf(content);
  const checkoutId = checkout.id;
  const ref = typeof checkoutId === "string" && CHECKOUT_ID.test(checkoutId) ? checkoutRefOf(checkoutId) : null;
  if (typeof checkoutId !== "string" || ref === null) throw new WalletRailError(200, null, "Shop's checkout has no usable id");
  return { checkout: projected(checkout, ref, requestedStore, shipToPostalCode), checkoutId };
}

function projected(checkout: Json, checkoutRef: string, requestedStore: string, shipToPostalCode: string | undefined): WalletCheckout {
  const status = typeof checkout.status === "string" ? (STATUS[checkout.status] ?? "processing") : "processing";
  const merchant = record(checkout.merchant) ?? record(checkout.seller) ?? record(checkout.shop);
  const order = record(checkout.order);
  const orderId = order?.id;
  // The store as Shop reports it: the host of the order's permalink once completed (S1 step 9: on the myshopify
  // domain), else a merchant domain if Shop ever sends one, else the store the gateway asked for.
  const reported = [hostOf(order?.permalink_url), merchant?.domain].find((d): d is string => typeof d === "string" && STORE_DOMAIN.test(d));
  return {
    checkoutRef,
    storeDomain: reported ?? requestedStore,
    status,
    merchantOrigin: origin(merchant?.url),
    lines: lines(checkout.line_items),
    total: total(checkout),
    shipTo: shipTo(checkout, shipToPostalCode),
    // A `gid://shopify/Order/<digits>` is not read as a card (ORDER_REF_AT): its order number passes Luhn one time in ten.
    orderRef: typeof orderId === "string" && REF.test(orderId) && findIdentity(orderId, { orderRefAt: ORDER_REF_AT.projection }).length === 0 ? orderId : null,
    budgetOffered: budgetInstrument(checkout) !== null,
    totals: totalsOf(checkout),
    shipToArea: shipToArea(checkout),
    continueUrl: continueUrlOf(checkout.continue_url),
  };
}

/**
 * The four totals (contract 1.7.0 CheckoutTotals) from Shop's `totals[]`: `subtotal`, shipping (`fulfillment` or
 * `shipping`, summed), `tax` (0 when absent) and `total`. Any other line (a discount, a fee) or a sum that is not the
 * total gives null: the gateway never submits totals it had to guess.
 */
function totalsOf(checkout: Json): WalletTotals | null {
  const lines = Array.isArray(checkout.totals) ? (checkout.totals as unknown[]).map(record) : [];
  let subtotal: number | null = null;
  let shipping = 0;
  let tax = 0;
  let totalAmount: number | null = null;
  for (const line of lines) {
    const amount = line?.amount;
    if (!Number.isSafeInteger(amount) || (amount as number) < 0) return null;
    const n = amount as number;
    if (line?.type === "subtotal") subtotal = n;
    else if (line?.type === "fulfillment" || line?.type === "shipping") shipping += n;
    else if (line?.type === "tax") tax += n;
    else if (line?.type === "total") totalAmount = n;
    else return null;
  }
  if (subtotal === null || totalAmount === null || totalAmount < 1 || subtotal + shipping + tax !== totalAmount) return null;
  return { subtotal, shipping, tax, total: totalAmount };
}

/** The selected (else the only) destination's country and coarse postcode, coarsened here; the full code is dropped. */
function shipToArea(checkout: Json): { country: string; postalCodeCoarse: string } | null {
  const destinations = selectedDestinations(checkout);
  if (destinations.length !== 1) return null;
  const d = destinations[0];
  const country = typeof d?.address_country === "string" ? d.address_country : null;
  const code = typeof d?.postal_code === "string" ? d.postal_code : null;
  if (country === null || code === null || !/^[A-Z]{2}$/.test(country)) return null;
  const coarse = coarsePostcode(country, code);
  return coarse === null ? null : { country, postalCodeCoarse: coarse };
}

/** Shop's continue_url when it is an https URL; its host is checked by the gateway before any submit (continueUrlAllowed). */
function continueUrlOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function selectedDestinations(checkout: Json): (Json | null)[] {
  const methods = Array.isArray(record(checkout.fulfillment)?.methods) ? (record(checkout.fulfillment)?.methods as unknown[]).map(record) : [];
  return methods.flatMap((m) => {
    const all = Array.isArray(m?.destinations) ? (m.destinations as unknown[]).map(record) : [];
    const selected = all.filter((d) => d !== null && d.id === m?.selected_destination_id);
    return selected.length > 0 ? selected : all.length === 1 ? all : [];
  });
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname : null;
  } catch {
    return null;
  }
}

function lines(items: unknown): WalletLine[] {
  if (!Array.isArray(items)) return [];
  return (items as unknown[]).flatMap((raw) => {
    const line = record(raw);
    const item = record(line?.item);
    const variantRef = item?.id;
    const quantity = line?.quantity;
    if (typeof variantRef !== "string" || !REF.test(variantRef) || !Number.isSafeInteger(quantity)) return [];
    const title = typeof item?.title === "string" ? item.title.slice(0, 200) : "";
    // A title is merchant content; one that reads as identity (a gift note, an engraving) is dropped.
    return [{ variantRef, quantity: quantity as number, title: findIdentity(title).length === 0 ? title : "" }];
  });
}

function total(checkout: Json): WalletMoney | null {
  const currency = checkout.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  const totals = Array.isArray(checkout.totals) ? (checkout.totals as unknown[]).map(record) : [];
  const amount = totals.find((t) => t?.type === "total")?.amount;
  return Number.isSafeInteger(amount) && (amount as number) >= 0 ? { amountMinor: amount as number, currency } : null;
}

function origin(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The selected (else the only) destination's ZIP against the snapshot's, compared here and dropped. */
function shipTo(checkout: Json, expected: string | undefined): ShipToMatch {
  const methods = Array.isArray(record(checkout.fulfillment)?.methods) ? (record(checkout.fulfillment)?.methods as unknown[]).map(record) : [];
  const destinations = methods.flatMap((m) => {
    const all = Array.isArray(m?.destinations) ? (m.destinations as unknown[]).map(record) : [];
    const selected = all.filter((d) => d !== null && d.id === m?.selected_destination_id);
    return selected.length > 0 ? selected : all.length === 1 ? all : [];
  });
  const zips = destinations.map((d) => d?.postal_code).filter((z): z is string => typeof z === "string");
  if (expected === undefined || zips.length !== 1) return "unknown";
  return (zips[0] ?? "").trim().slice(0, 5) === expected.slice(0, 5) ? "match" : "differs";
}

/** How many orders `intent wallet check` asks search_orders for: one page, never a cursor (plan G12). */
export const ORDERS_PAGE = 50;
/** A host name a seller domain may be: LDH labels, at least one dot. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * search_orders' answer in our terms (plan G12): for each order only {order_ref, total, merchant_origin, created_at}.
 * As S1 saw it (step 10), an order's `id` is Shop's own UUID, and the merchant's order is `shopify_order_id`, the
 * digits of the `gid://shopify/Order/<digits>` a completed checkout returns: order_ref is that gid, so it matches the
 * chain's outcomes. An order with no `shopify_order_id` (one Shop read from an email) keeps Shop's id as its ref.
 * `checkout_id` is an order-status URL with a credential-bearing query, not the checkout gid, and is never read. The
 * merchant origin is `https://` + `seller.domain` (the storefront's primary domain). Shop's orders carry the seller's
 * name, line text and the delivery city; none of it is read. `complete` is false when Shop says another page exists,
 * or returned a full page.
 */
export function projectOrders(content: Json): WalletOrders {
  const raw = Array.isArray(content.orders) ? (content.orders as unknown[]).map(record) : [];
  const orders = raw.flatMap((order): WalletOrder[] => {
    if (order === null) return [];
    const orderRef = orderRefOf(order);
    if (orderRef === null) return [];
    const seller = record(order.seller) ?? record(order.merchant);
    const domain = typeof seller?.domain === "string" ? seller.domain.toLowerCase() : null;
    const merchantOrigin = domain !== null && HOST.test(domain) ? `https://${domain}` : origin(seller?.url);
    // An origin is printed to the developer: one that reads as identity (a personal domain, an email-like host) is dropped.
    const safeOrigin = merchantOrigin !== null && findIdentity(merchantOrigin).length === 0 ? merchantOrigin : null;
    return [{ orderRef, total: total(order) ?? money(record(order.total)), merchantOrigin: safeOrigin, createdAt: instant(order.placed_at ?? order.created_at) }];
  });
  const page = record(content.pagination) ?? record(content.page_info);
  const more = page?.has_next_page === true || page?.hasNextPage === true || raw.length >= ORDERS_PAGE;
  return { orders, complete: !more };
}

/**
 * `gid://shopify/Order/<shopify_order_id>`, built here from digits only, so it is not scanned for a card (a 14-digit
 * order number passes Luhn about one time in ten); else Shop's own id when it is a plain reference that reads as no
 * identity; else null, and the order is dropped whole.
 */
function orderRefOf(order: Json): string | null {
  const digits = typeof order.shopify_order_id === "number" && Number.isSafeInteger(order.shopify_order_id) ? String(order.shopify_order_id) : order.shopify_order_id;
  if (typeof digits === "string" && /^[0-9]{1,20}$/.test(digits)) return `gid://shopify/Order/${digits}`;
  const id = order.id;
  return typeof id === "string" && REF.test(id) && findIdentity(id).length === 0 ? id : null;
}

function money(value: Json | null): WalletMoney | null {
  if (value === null) return null;
  const { amount, currency } = value;
  if (!Number.isSafeInteger(amount) || (amount as number) < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amountMinor: amount as number, currency };
}

/** A creation time as ISO 8601 UTC, or null when it is not a date and time. */
function instant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The most variants one search answer may yield, whatever Shop sends. */
export const MAX_CATALOG_HITS = 60;
/** A product or image URL kept from a catalog answer: https, no credentials, at most 512 characters. */
const CATALOG_URL_MAX = 512;

/**
 * search_catalog's answer in our terms (G5): for each variant only the store (`seller.domain`, a myshopify domain),
 * the storefront origin (`seller.url`), the product and variant ids, the titles, the price {amount, currency} in
 * integer minor units, availability, one image, the product page, the category words and whether it ships. As S1 saw
 * it (step 5), a product has `variants[]`, and each variant carries `id` (a ProductVariant gid), `title`,
 * `price {amount, currency}`, `availability {available}` and `seller {domain, url}`. The product-level fields (title,
 * url, media, type, tags) are read where Shop puts them and dropped when absent. A variant with no myshopify store,
 * no variant gid or no integer price is dropped whole, and so is one whose storefront reads as identity. Titles lose
 * control and format characters, those that read as identity become "", and URLs keep only their origin and path
 * (a query can carry a tracking id or a key).
 */
export function projectCatalog(content: Json): CatalogHit[] {
  const hits: CatalogHit[] = [];
  for (const product of list(content.products)) {
    const productId = typeof product.id === "string" && REF.test(product.id) ? product.id : null;
    const productTitle = cleanTitle(product.title);
    const productUrl = cleanUrl(product.url ?? product.online_store_url ?? product.onlineStoreUrl);
    const imageUrl = firstImage(product);
    const categories = categoryWords(product);
    for (const variant of list(product.variants)) {
      if (hits.length >= MAX_CATALOG_HITS) return hits;
      const seller = record(variant.seller) ?? record(product.seller);
      const store = typeof seller?.domain === "string" ? seller.domain.toLowerCase() : "";
      const variantRef = variant.id;
      const price = money(record(variant.price));
      if (!STORE_DOMAIN.test(store) || typeof variantRef !== "string" || !VARIANT_GID.test(variantRef) || price === null) continue;
      const storefront = origin(seller?.url);
      // A storefront that reads as identity drops the variant, not just the name: kept as null, the policy's block
      // list could no longer match the store by the storefront host it is known by.
      if (storefront !== null && findIdentity(storefront).length > 0) continue;
      const variantTitle = cleanTitle(variant.title);
      const shipping = variant.requires_shipping ?? product.requires_shipping;
      hits.push({
        storeDomain: store,
        storefrontOrigin: storefront,
        productRef: productId,
        variantRef,
        title: productTitle !== "" ? productTitle : variantTitle,
        variantTitle: productTitle !== "" && variantTitle !== productTitle ? variantTitle : "",
        price,
        available: record(variant.availability)?.available === true,
        imageUrl: firstImage(variant) ?? imageUrl,
        productUrl: cleanUrl(variant.url) ?? productUrl,
        categories,
        requiresShipping: typeof shipping === "boolean" ? shipping : null,
      });
    }
  }
  return hits;
}

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[0-9]{1,20}$/;

function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  // Control and format characters (a terminal escape, a bidi override) never reach the agent or a screen.
  const title = value.replace(/[\s\p{Cc}]+/gu, " ").replace(/\p{Cf}/gu, "").trim().slice(0, 120);
  // Merchant text: one that reads as identity (an engraving, a gift note) is dropped.
  return findIdentity(title).length === 0 ? title : "";
}

/** origin + path of an https URL, or null. The query and fragment are dropped. */
function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    const kept = `${url.origin}${url.pathname}`;
    return kept.length <= CATALOG_URL_MAX && findIdentity(kept).length === 0 ? kept : null;
  } catch {
    return null;
  }
}

/** The first image URL a product or variant names (`media[]`, `images[]`, `image`, `featured_image`). */
function firstImage(holder: Json): string | null {
  const candidates = [...list(holder.media), ...list(holder.images), record(holder.image), record(holder.featured_image)];
  for (const candidate of candidates) {
    const url = cleanUrl(candidate?.url ?? candidate?.src);
    if (url !== null) return url;
  }
  return null;
}

/** The product's type, category and tags, lower case, each at most 60 characters, at most 20 words. */
function categoryWords(product: Json): string[] {
  const category = record(product.category);
  const raw: unknown[] = [
    product.product_type,
    product.productType,
    typeof product.category === "string" ? product.category : category?.name,
    category?.full_name,
    ...(Array.isArray(product.tags) ? (product.tags as unknown[]) : []),
  ];
  return [...new Set(raw.filter((w): w is string => typeof w === "string" && w.trim() !== "").map((w) => w.trim().toLowerCase().slice(0, 60)))].slice(0, 20);
}

/** An address-related error message on a tool answer: the rail asks for address fields (plan K4). */
export function asksForAddressFields(content: Json): boolean {
  const checkout = checkoutOf(content);
  const messages = [...list(content.messages), ...list(checkout.messages)];
  return messages.some((m) => {
    const path = typeof m.path === "string" ? m.path : "";
    const code = typeof m.code === "string" ? m.code : "";
    return m.type === "error" && (/fulfillment|destination|address/i.test(path) || /address/i.test(code));
  });
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as unknown[]).map(record).filter((m): m is Json => m !== null) : [];
}

export function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}
