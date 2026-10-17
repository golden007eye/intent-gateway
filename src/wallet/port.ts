// The wallet port: what the gateway asks of a wallet rail, in our terms (plan G6, D1). A wallet adapter (the Shop
// adapter, later others on the same port) implements it behind the disclosure log; nothing here sends anything.
//
// Every value is one the gateway may hold: no buyer name, postal address, email, phone or card ever crosses this
// port (invariant 3). A ship-to is compared inside the adapter and only the verdict comes back.

/** The wallet rails the gateway knows. */
export const WALLET_RAILS = ["shop"] as const;
export type WalletRail = (typeof WALLET_RAILS)[number];

export function isWalletRail(value: string): value is WalletRail {
  return (WALLET_RAILS as readonly string[]).includes(value);
}

/**
 * What a `wallet` chain entry may record. `linked` and `unlinked` bodies are exactly {rail, action, revoked}: no
 * token, no account detail. A `checked` body (`intent wallet check`, plan G12) is exactly CHECKED_KEYS: counts and a
 * total over a period, never an order, a merchant or anything about the buyer.
 */
export const WALLET_ACTIONS = ["linked", "unlinked", "checked"] as const;

/** The keys of a `checked` entry body, and nothing else. */
export const CHECKED_KEYS = ["rail", "action", "since", "order_count", "unmatched_count", "unmatched_total_minor", "complete"] as const;
const LINK_KEYS = ["rail", "action", "revoked"] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Why a `wallet` entry body does not have its action's exact shape, or null when it does. Pure. */
export function walletEntryProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "is not an object";
  const fields = body as Record<string, unknown>;
  const allowed: readonly string[] = fields.action === "checked" ? CHECKED_KEYS : LINK_KEYS;
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  // Names only: an extra key's value may be the very secret this check keeps out.
  if (extra.length > 0) return `holds fields a wallet entry never has (${extra.sort().join(", ")}), which may be a credential or buyer identity`;
  const { rail, action } = fields;
  if (typeof rail !== "string" || !isWalletRail(rail)) return `names no known wallet rail (${WALLET_RAILS.join(", ")})`;
  if (typeof action !== "string" || !(WALLET_ACTIONS as readonly string[]).includes(action)) return `names no known action (${WALLET_ACTIONS.join(", ")})`;
  if (action !== "checked") return typeof fields.revoked === "boolean" ? null : "has no boolean revoked";
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const { since, order_count: orders, unmatched_count: unmatched, unmatched_total_minor: total, complete } = fields;
  if (typeof since !== "string" || !ISO_INSTANT.test(since) || Number.isNaN(Date.parse(since))) return "has no ISO 8601 UTC since";
  if (!count(orders) || !count(unmatched) || !count(total)) return "has counts or a total that are not non-negative integers";
  if (unmatched > orders) return "counts more unmatched orders than orders";
  if (typeof complete !== "boolean") return "has no boolean complete";
  return null;
}

/** Amounts are integer minor units (cents) with their ISO 4217 currency, as everywhere else in the gateway. */
export interface WalletMoney {
  readonly amountMinor: number;
  readonly currency: string;
}

/** The linked account as the gateway needs it: how much the rail lets the gateway spend (null when it sets no budget). */
export interface WalletAccount {
  readonly budgetRemaining: WalletMoney | null;
}

export interface WalletLine {
  readonly variantRef: string;
  readonly quantity: number;
  /** Advisory only: a title never decides a binding check. */
  readonly title: string;
}

/** Whether the wallet's ship-to ZIP matches the signed snapshot's; the ZIP itself never crosses the port. */
export type ShipToMatch = "match" | "differs" | "unknown";

/** A checkout's state in our terms. `buyer_review`: the rail asks the buyer before it completes. */
export type WalletCheckoutStatus = "open" | "processing" | "buyer_review" | "completed" | "failed" | "not_found";

/**
 * Where a checkout lives on the rail. Shop names a store by its `*.myshopify.com` domain, which is not the storefront
 * origin an offer shows; the adapter records the domain the rail reports and never compares it with an origin (that
 * binding check is the gateway's, ADR-0017).
 */
export interface CheckoutLocator {
  readonly storeDomain: string;
  /**
   * `sha256:<hex>` of the rail's checkout id, never the id: a UCP checkout id can carry a credential (`?key=`). This
   * is what the gateway records (G7b's `checkout_ref`). The adapter holds the id itself in memory only, so a
   * reference from before a restart no longer reaches the checkout (ADR-0017).
   */
  readonly checkoutRef: string;
}

export interface WalletCheckout extends CheckoutLocator {
  readonly status: WalletCheckoutStatus;
  /** The storefront origin the rail reports for the merchant (https only), or null when it reports none. */
  readonly merchantOrigin: string | null;
  readonly lines: readonly WalletLine[];
  readonly total: WalletMoney | null;
  readonly shipTo: ShipToMatch;
  /** The merchant's order reference once completed, else null. */
  readonly orderRef: string | null;
}

/**
 * One order the rail reported, projected (plan G12): its reference, total, merchant origin and creation time. Nothing
 * else of an order crosses the port: no lines, no address, no buyer.
 */
export interface WalletOrder {
  readonly orderRef: string;
  readonly total: WalletMoney | null;
  readonly merchantOrigin: string | null;
  /** ISO 8601 UTC, or null when the rail reported no usable time. */
  readonly createdAt: string | null;
}

/** The orders one call returned. `complete` is false when the rail reported more than it returned (another page). */
export interface WalletOrders {
  readonly orders: readonly WalletOrder[];
  readonly complete: boolean;
}

export interface CheckoutRequest {
  /** The approval handle of the purchase: kept locally with each send, never sent (plan G7b step 6b). */
  readonly purchase: string;
  /** The store as the rail names it (Shop: `*.myshopify.com`). */
  readonly storeDomain: string;
  readonly lines: readonly { readonly variantRef: string; readonly quantity: number }[];
  /** The signed snapshot's 5-digit ZIP, compared inside the adapter. */
  readonly shipToPostalCode: string;
}

/**
 * One wallet rail. Each call that reaches the rail goes through the disclosure log first (invariant 2); the adapter
 * returns only the projections above, never the rail's own words. `shipToPostalCode` is the signed snapshot's ZIP,
 * compared inside the adapter; without it `shipTo` is `unknown`.
 */
export interface WalletAdapter {
  readonly rail: WalletRail;
  account(): Promise<WalletAccount>;
  /**
   * Delivery is chosen by the account's saved-address id only. Throws AddressFieldsRequiredError, with nothing sent
   * to create the checkout, when the rail would need address fields.
   */
  createCheckout(request: CheckoutRequest): Promise<WalletCheckout>;
  /**
   * Sent at most once per purchase (plan G7b step 6); a lost answer is reconciled with getCheckout, never re-sent.
   * `idempotencyKey` is a UUID v4. Throws AddressFieldsRequiredError, with no completion sent, when completing
   * would forward a postal address (a billing address on the payment instrument).
   */
  completeCheckout(checkout: CheckoutLocator, purchase: string, idempotencyKey: string, options: CompleteOptions): Promise<WalletCheckout>;
  getCheckout(checkout: CheckoutLocator, purchase: string, shipToPostalCode?: string): Promise<WalletCheckout>;
  /**
   * Forgets the checkout's id (memory and the encrypted checkout store), once the purchase has a terminal outcome and
   * nothing needs to reach the checkout again. Sends nothing.
   */
  release(checkout: CheckoutLocator): Promise<void>;
  /** The account's recent orders as the rail reports them, projected (plan G12, `intent wallet check`). */
  orders(): Promise<WalletOrders>;
  /**
   * Asks the rail to revoke the gateway's token. `revoked` only when the rail acknowledged it; `not_sent` when there
   * was no token or client to revoke with, so nothing was sent (invariant 5: say only what was sent and answered).
   */
  revoke(): Promise<RevokeResult>;
}

export type RevokeResult = "revoked" | "not_revoked" | "not_sent";

/** A chain entry as a send condition reads it (src/store's Entry fits). */
export interface ChainEntryView {
  readonly kind: string;
  readonly body: unknown;
}

/**
 * Compare-and-append for one send (plan G7b step 6b): the send's `disclosure` entry is appended, and the request
 * sent, only if this returns false over the chain, evaluated under the store lease. True means another process or
 * an earlier run owns the step: nothing is logged or sent.
 */
export type SendCondition = (entries: readonly ChainEntryView[]) => boolean;

export interface CompleteOptions {
  /** The signed snapshot's ZIP, compared inside the adapter. */
  readonly shipToPostalCode?: string;
  /**
   * The completer precheck (contract Appendix G): called with the checkout as read by a fresh get_checkout, in this
   * process and immediately before complete_checkout. A non-null answer is the refusal's reason: complete_checkout is
   * then never sent, and CompletionRefusedError carries the reason.
   */
  readonly precheck?: (fresh: WalletCheckout) => string | null;
  /** The condition of the complete_checkout send itself (SendCondition). */
  readonly sendUnless: SendCondition;
}

/** The completer precheck refused the fresh checkout read: complete_checkout was not sent. */
export class CompletionRefusedError extends Error {
  override name = "CompletionRefusedError";
  readonly reason: string;
  /** The fresh read the precheck refused. */
  readonly checkout: WalletCheckout;
  constructor(reason: string, checkout: WalletCheckout) {
    super(`complete_checkout not sent: the completer precheck refused the checkout (${reason})`);
    this.reason = reason;
    this.checkout = checkout;
  }
}

/**
 * Where an adapter keeps a rail's raw checkout ids between processes, by checkout ref (ADR-0019): an id can carry a
 * credential (`?key=`), so it is never in the chain; it sits encrypted beside the wallet's token, so a restarted
 * gateway can still read the checkout it may have completed.
 */
export interface CheckoutIdStore {
  get(checkoutRef: string): Promise<string | null>;
  set(checkoutRef: string, checkoutId: string): Promise<void>;
  delete(checkoutRef: string): Promise<void>;
}

/** A CheckoutIdStore held in memory only (a process that never restarts mid-purchase, or tests). */
export function memoryCheckoutIds(): CheckoutIdStore {
  const ids = new Map<string, string>();
  return {
    get: (ref) => Promise.resolve(ids.get(ref) ?? null),
    set: (ref, id) => {
      ids.set(ref, id);
      return Promise.resolve();
    },
    delete: (ref) => {
      ids.delete(ref);
      return Promise.resolve();
    },
  };
}

/**
 * The rail would need the buyer's postal address (invariant 3; plan kill criterion K4): delivery chosen by address
 * fields rather than a saved-address id, or a payment instrument that carries a billing address. Nothing was sent
 * for the step it names; the purchase can still be handed off.
 */
export class AddressFieldsRequiredError extends Error {
  override name = "AddressFieldsRequiredError";
  readonly step: "delivery" | "payment";
  constructor(step: "delivery" | "payment") {
    super(
      step === "delivery"
        ? "not sent: the wallet would need the buyer's address fields to choose delivery, and the gateway sends only a saved-address id"
        : "not sent: completing would forward the payment instrument's billing address, which the gateway never sends",
    );
    this.step = step;
  }
}

/**
 * The rail answered with an error. Only a numeric code and a fixed local label are kept: the rail's own message can
 * carry buyer identity and never reaches a tool result, stderr or the chain.
 */
export class WalletRailError extends Error {
  override name = "WalletRailError";
  /** The JSON-RPC error code, or null for an HTTP-level or tool-level error. */
  readonly code: number | null;
  readonly label: string;
  readonly httpStatus: number;
  constructor(httpStatus: number, code: number | null, label: string) {
    super(`the wallet answered an error: ${label} (HTTP ${String(httpStatus)}${code === null ? "" : `, code ${String(code)}`})`);
    this.httpStatus = httpStatus;
    this.code = code;
    this.label = label;
  }
}
