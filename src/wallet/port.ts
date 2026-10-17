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

/** What a `wallet` chain entry may record. Its body is exactly {rail, action, revoked}: no token, no account detail. */
export const WALLET_ACTIONS = ["linked", "unlinked"] as const;

/** Why a `wallet` entry body is not exactly {rail, action, revoked: boolean}, or null when it is. Pure. */
export function walletEntryProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "is not an object";
  const extra = Object.keys(body).filter((k) => k !== "rail" && k !== "action" && k !== "revoked");
  // Names only: an extra key's value may be the very secret this check keeps out.
  if (extra.length > 0) return `holds fields a wallet entry never has (${extra.sort().join(", ")}), which may be a credential`;
  const { rail, action, revoked } = body as Record<string, unknown>;
  if (typeof rail !== "string" || !isWalletRail(rail)) return `names no known wallet rail (${WALLET_RAILS.join(", ")})`;
  if (typeof action !== "string" || !(WALLET_ACTIONS as readonly string[]).includes(action)) return `names no known action (${WALLET_ACTIONS.join(", ")})`;
  if (typeof revoked !== "boolean") return "has no boolean revoked";
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
  completeCheckout(checkout: CheckoutLocator, purchase: string, idempotencyKey: string, shipToPostalCode?: string): Promise<WalletCheckout>;
  getCheckout(checkout: CheckoutLocator, purchase: string, shipToPostalCode?: string): Promise<WalletCheckout>;
  /**
   * Asks the rail to revoke the gateway's token. `revoked` only when the rail acknowledged it; `not_sent` when there
   * was no token or client to revoke with, so nothing was sent (invariant 5: say only what was sent and answered).
   */
  revoke(): Promise<RevokeResult>;
}

export type RevokeResult = "revoked" | "not_revoked" | "not_sent";

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
