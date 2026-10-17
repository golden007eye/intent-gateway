// Allow-list projection of Shop's answers (plan G7a; invariant 3). Shop answers with the buyer's name, email, phone,
// saved addresses and order history (get_account), and checkouts echo the delivery address. Nothing of that leaves
// this file: each reader below copies out only the fields it names, so any field Shop adds is dropped by default.
//
// Kept: the budget left; the checkout's sha256 reference (the id itself may hold a credential), its status, lines {variant_ref, quantity, title}, store domain, merchant
// origin, total and order id. The ship-to ZIP is compared here, in memory, and only `match | differs | unknown`
// is kept. The saved-address id is kept inside the adapter (it is how delivery is chosen) and never returned.
// From an error, only the JSON-RPC numeric code and a fixed local label are kept: Shop's message can carry
// identity and never reaches a tool result, stderr or the chain.
//
// The field names follow Shop's published tool schemas (UCP checkout) as of 2026-10-16; the budget's and the
// address id's exact shape is pending the S1 spike's captured answers (plan G0 questions 2 and 9).
import { createHash } from "node:crypto";
import { findIdentity } from "../privacy/index.ts";
import { type ShipToMatch, type WalletAccount, type WalletCheckout, type WalletCheckoutStatus, type WalletLine, type WalletMoney, WalletRailError } from "../wallet/index.ts";
import type { WireResponse } from "./rpc.ts";

type Json = Record<string, unknown>;

/** A tool's answer: its structured content, and whether Shop marked it an error. */
export interface ToolAnswer {
  readonly content: Json;
  readonly isError: boolean;
}

/** Labels for JSON-RPC error codes; the message Shop sent with them is never read. */
const RPC_LABELS: Readonly<Record<number, string>> = {
  [-32700]: "Shop could not parse the request",
  [-32600]: "Shop refused the request as invalid",
  [-32601]: "Shop does not have that method",
  [-32602]: "Shop refused the request's arguments",
  [-32603]: "Shop had an internal error",
};

/** Reads one MCP answer. Throws WalletRailError, naming only a status, a code and a fixed label, for every error. */
export function readToolAnswer(response: WireResponse): ToolAnswer {
  const { status } = response;
  if (status === 401 || status === 403) throw new WalletRailError(status, null, "Shop refused the token (expired or revoked): link the wallet again");
  if (status < 200 || status >= 300) throw new WalletRailError(status, null, "Shop answered with an HTTP error");
  const message = parseMessage(response);
  if (message === null) throw new WalletRailError(status, null, "Shop's answer is not a JSON-RPC message");
  const error = record(message.error);
  if (error !== null) {
    const code = Number.isInteger(error.code) ? (error.code as number) : null;
    throw new WalletRailError(status, code, (code === null ? undefined : RPC_LABELS[code]) ?? "Shop answered with an error");
  }
  const result = record(message.result);
  if (result === null) throw new WalletRailError(status, null, "Shop's answer has no result");
  return { content: structured(result) ?? {}, isError: result.isError === true };
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
 * A saved-address id as Shop gives it: an opaque Shopify gid, nothing that reads as an address. No query suffix: a
 * query could carry a token (`customer_access_token=`), which the log would keep in clear under `id`, or address text.
 */
export const SAVED_ADDRESS_ID = /^gid:\/\/shopify\/[A-Za-z]+\/[0-9]{1,20}$/;

/** What the adapter keeps from get_account: the budget left, and the saved-address id to choose delivery by. */
export function projectAccount(content: Json): { account: WalletAccount; savedAddressId: string | null } {
  const account = record(content.account) ?? content;
  const budget = record(account.budget);
  const remaining = money(record(budget?.remaining));
  const preferred = account.preferred_address_id;
  const addresses = Array.isArray(account.addresses) ? (account.addresses as unknown[]).map(record) : [];
  const ids = [preferred, ...addresses.map((a) => a?.id)].filter((id): id is string => isSavedAddressId(id));
  return { account: { budgetRemaining: remaining }, savedAddressId: ids[0] ?? null };
}

function isSavedAddressId(id: unknown): id is string {
  return typeof id === "string" && SAVED_ADDRESS_ID.test(id) && findIdentity(id).length === 0;
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

/**
 * How a checkout is named wherever it is kept or shown: `sha256:` and the hex SHA-256 of the id's UTF-8 bytes. The
 * id itself can hold a credential (UCP's `?key=`), so it is held in memory only, for the next call to Shop.
 */
export function checkoutRefOf(checkoutId: string): string {
  return `sha256:${createHash("sha256").update(checkoutId, "utf8").digest("hex")}`;
}

/** The raw checkout object of an answer (`checkout`, or the answer itself). */
export function checkoutOf(content: Json): Json {
  return record(content.checkout) ?? content;
}

/**
 * The checkout in our terms, and Shop's raw checkout id for the adapter to hold in memory. `requestedStore` is the
 * store the gateway asked for, kept when Shop reports none. An unknown status reads as `processing`: neither
 * completable nor terminal, so the gateway waits or reconciles.
 */
export function projectCheckout(
  content: Json,
  requestedStore: string,
  shipToPostalCode: string | undefined,
): { checkout: WalletCheckout; checkoutId: string } {
  const checkout = checkoutOf(content);
  const checkoutId = checkout.id;
  if (typeof checkoutId !== "string" || !CHECKOUT_ID.test(checkoutId)) throw new WalletRailError(200, null, "Shop's checkout has no usable id");
  return { checkout: projected(checkout, checkoutRefOf(checkoutId), requestedStore, shipToPostalCode), checkoutId };
}

function projected(checkout: Json, checkoutRef: string, requestedStore: string, shipToPostalCode: string | undefined): WalletCheckout {
  const status = typeof checkout.status === "string" ? (STATUS[checkout.status] ?? "processing") : "processing";
  const merchant = record(checkout.merchant) ?? record(checkout.seller) ?? record(checkout.shop);
  const reported = merchant?.domain;
  const order = record(checkout.order);
  const orderId = order?.id;
  return {
    checkoutRef,
    storeDomain: typeof reported === "string" && STORE_DOMAIN.test(reported) ? reported : requestedStore,
    status,
    merchantOrigin: origin(merchant?.url),
    lines: lines(checkout.line_items),
    total: total(checkout),
    shipTo: shipTo(checkout, shipToPostalCode),
    orderRef: typeof orderId === "string" && REF.test(orderId) && findIdentity(orderId).length === 0 ? orderId : null,
  };
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

function money(value: Json | null): WalletMoney | null {
  if (value === null) return null;
  const { amount, currency } = value;
  if (!Number.isSafeInteger(amount) || (amount as number) < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amountMinor: amount as number, currency };
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
