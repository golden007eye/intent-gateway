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

/**
 * The linked account as the gateway needs it. `budgetRemaining`: how much the rail's budget for this connection has
 * left, or null when the rail shows none or shows it in a shape the adapter does not read (never assumed: one tap
 * then hands off). `connected`: false when the rail says this connection can no longer read the account (Shop: the
 * buyer removed it in the Shop app, while the token itself still answers, S1 step 12b).
 */
export interface WalletAccount {
  readonly budgetRemaining: WalletMoney | null;
  /**
   * The budget's limit, in the same currency, and how often it renews as the rail names it (`monthly`, `weekly`,
   * `daily`, `yearly`; null for any other word or none), and when it next renews (an ISO 8601 UTC instant as the rail
   * gives it; null when it gives none): null when the rail shows no budget or no limit.
   */
  readonly budgetLimit: { readonly amount: WalletMoney; readonly renewal: BudgetRenewal | null; readonly renewsAt: string | null } | null;
  /** The rail's own page where the buyer manages this connection (Shop: an https URL on shop.app), or null. */
  readonly manageUrl: string | null;
  readonly connected: boolean;
  /** The account's currency as the rail names it (ISO 4217), when it names one: what a budget would be in. */
  readonly currency?: string | null;
}

export type BudgetRenewal = "daily" | "weekly" | "monthly" | "yearly";

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
  /**
   * Whether the rail offers to pay the checkout from the buyer's agent budget (Shop: a `delegated_budget`
   * instrument). One tap pays only that way; a checkout that offers only a card is never completed (S1 step 6).
   */
  readonly budgetOffered: boolean;
  /**
   * The checkout's four totals in `total.currency` minor units (contract 1.7.0 `CheckoutTotals`), or null when the rail
   * gave them in a shape that does not add up to its total (a discount line included): never guessed.
   */
  readonly totals?: WalletTotals | null;
  /**
   * The destination's country, its full postcode and its coarse postcode (contract 1.7.1 "Coarse postcodes"), or null
   * when the rail shows no single destination. `postalCodeCoarse` is null when the postcode has no coarse form there.
   * The full `postalCode` is for binding check 4 only (Appendix G: coarse() takes the full postcode): it stays in
   * memory and is never logged, chained, sent or shown (invariant 3); the adapter makes it non-enumerable, so a
   * spread or JSON.stringify of the checkout drops it.
   */
  readonly shipToArea?: { readonly country: string; readonly postalCode: string; readonly postalCodeCoarse: string | null } | null;
  /**
   * The rail's own page where the buyer can finish this checkout (Shop's `continue_url`), for a hand-off; null when
   * none. It may carry a credential in its query, so the gateway never logs or shows it except in the submit that needs it.
   */
  readonly continueUrl?: string | null;
}

export interface WalletTotals {
  readonly subtotal: number;
  readonly shipping: number;
  readonly tax: number;
  readonly total: number;
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
  /**
   * The condition of the create_checkout send itself (SendCondition): true when another process creates for this
   * purchase, or an earlier create may have reached the rail, so nothing is logged or sent.
   */
  readonly sendUnless?: SendCondition;
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
   * Sends the lines only: no address and no address id. The rail fills delivery from the account (Shop: the
   * preferred saved address, S1 step 6). Sent once per call and never retried. Throws AddressFieldsRequiredError when
   * the rail answers that it needs address fields (nothing more is sent), and CheckoutUnconfirmedError when the
   * request may have reached the rail but no usable answer came back.
   */
  createCheckout(request: CheckoutRequest): Promise<WalletCheckout>;
  /**
   * Sent at most once per purchase (plan G7b step 6); a lost answer is reconciled with getCheckout, never re-sent.
   * `idempotencyKey` is a UUID v4. Pays with the rail's agent budget only (`budgetOffered`): with none offered it
   * throws CompletionRefusedError (`no_budget_instrument`) and sends nothing. Throws AddressFieldsRequiredError, with
   * no completion sent, when completing would forward a postal address (a billing address on the payment instrument).
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
   * Asks the rail to revoke the gateway's tokens: the refresh token and the access token, one request each (Shop
   * keeps an access token working after its refresh token is revoked, S1 step 12). `revoked` only when the rail
   * acknowledged every revocation; `not_sent` when there was no token or client to revoke with, so nothing was sent
   * (invariant 5: say only what was sent and answered). Revoking does not remove the connection in the rail's app.
   */
  revoke(): Promise<RevokeResult>;
  /**
   * Searches the rail's catalog (G5, ADR-0021), logged first like every other send. Only a rail that has a catalog
   * implements it (Shop: `search_catalog`). Returns projected products only: never the rail's own words.
   */
  searchCatalog?(query: CatalogQuery): Promise<readonly CatalogHit[]>;
}

/**
 * A catalog search in our terms (G5): the text to look for, the most one item may cost, and where it ships. Only the
 * country and the currency name a place; no postcode is sent to the rail's catalog.
 */
export interface CatalogQuery {
  readonly text: string;
  /** The highest unit price, integer minor units in `currency`; null for none. */
  readonly maxPriceMinor: number | null;
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** ISO 3166-1 alpha-2, upper case: the country it ships to. */
  readonly country: string;
  /** How many products to ask for (1 to 20). */
  readonly limit: number;
}

/**
 * One purchasable variant the rail's catalog returned, projected: the store and its storefront, the product and
 * variant ids, titles, price, availability, an image, a product page and the category words the rail gave. Nothing
 * about the buyer crosses the port (invariant 3).
 */
export interface CatalogHit {
  /** The store as the rail names it (Shop: `*.myshopify.com`). */
  readonly storeDomain: string;
  /** The storefront origin (https), or null when the rail gave none. */
  readonly storefrontOrigin: string | null;
  readonly productRef: string | null;
  readonly variantRef: string;
  readonly title: string;
  /** The variant's own title (`Default`, `Large / Blue`); "" when none. */
  readonly variantTitle: string;
  readonly price: WalletMoney;
  readonly available: boolean;
  readonly imageUrl: string | null;
  readonly productUrl: string | null;
  /** The product's type, category and tags as the rail gave them, lower case: what the excluded-category filter reads. */
  readonly categories: readonly string[];
  /** False when the rail says the item ships nothing (a digital good); null when it does not say. */
  readonly requiresShipping: boolean | null;
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
 * The rail would need the buyer's postal address (invariant 3; plan kill criterion K4): it asks for address fields
 * to choose delivery, or its payment instrument carries a billing address. Nothing more was sent
 * for the step it names; the purchase can still be handed off.
 */
export class AddressFieldsRequiredError extends Error {
  override name = "AddressFieldsRequiredError";
  readonly step: "delivery" | "payment";
  constructor(step: "delivery" | "payment") {
    super(
      step === "delivery"
        ? "not sent: the wallet asked for the buyer's address fields to choose delivery, and the gateway never sends them"
        : "not sent: completing would forward the payment instrument's billing address, which the gateway never sends",
    );
    this.step = step;
  }
}

/** A rail error code that may be kept and shown: a short lower-case token, so no message text fits. */
export const RAIL_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The rail answered with an error. Only the HTTP status, a JSON-RPC numeric code, the rail's error code token and a
 * fixed local label are kept: the rail's own message can carry buyer identity and never reaches a tool result,
 * stderr or the chain.
 */
export class WalletRailError extends Error {
  override name = "WalletRailError";
  /** The JSON-RPC error code, or null for an HTTP-level or tool-level error. */
  readonly code: number | null;
  readonly label: string;
  readonly httpStatus: number;
  /** A tool-level error's code as the rail names it (`checkout_completion_ineligible`) when it fits RAIL_CODE; else null. */
  readonly railCode: string | null;
  constructor(httpStatus: number, code: number | null, label: string, railCode: string | null = null) {
    const kept = railCode !== null && RAIL_CODE.test(railCode) ? railCode : null;
    super(`the wallet answered an error: ${label} (HTTP ${String(httpStatus)}${code === null ? "" : `, code ${String(code)}`}${kept === null ? "" : `, ${kept}`})`);
    this.httpStatus = httpStatus;
    this.code = code;
    this.label = label;
    this.railCode = kept;
  }
}

/**
 * create_checkout may have reached the rail and no usable answer came back (a timeout, a cut connection). A checkout
 * may exist; the gateway does not hold its id, so it can never complete it, and it never sends create_checkout again
 * for that purchase: Shop makes a new checkout for a replayed idempotency key (S1 step 6 `--replay`).
 */
export class CheckoutUnconfirmedError extends Error {
  override name = "CheckoutUnconfirmedError";
  constructor(cause?: unknown) {
    super("create_checkout may have reached the wallet with no usable answer; it is not sent again for this purchase", cause === undefined ? undefined : { cause });
  }
}
