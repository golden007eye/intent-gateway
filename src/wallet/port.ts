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

export interface WalletCheckout {
  readonly checkoutRef: string;
  readonly status: WalletCheckoutStatus;
  readonly merchantOrigin: string;
  readonly lines: readonly WalletLine[];
  readonly total: WalletMoney | null;
  readonly shipTo: ShipToMatch;
  /** The merchant's order reference once completed, else null. */
  readonly orderRef: string | null;
}

export interface CheckoutRequest {
  /** The approval handle of the purchase: kept locally with each send, never sent (plan G7b step 6b). */
  readonly purchase: string;
  readonly merchantOrigin: string;
  readonly lines: readonly { readonly variantRef: string; readonly quantity: number }[];
  /** The signed snapshot's 5-digit ZIP, compared inside the adapter. */
  readonly shipToPostalCode: string;
}

/**
 * One wallet rail. Each call that reaches the rail goes through the disclosure log first (invariant 2); the adapter
 * returns only the projections above, never the rail's own words.
 */
export interface WalletAdapter {
  readonly rail: WalletRail;
  account(): Promise<WalletAccount>;
  createCheckout(request: CheckoutRequest): Promise<WalletCheckout>;
  /** Sent at most once per purchase (plan G7b step 6); a lost answer is reconciled with getCheckout, never re-sent. */
  completeCheckout(checkoutRef: string, purchase: string, idempotencyKey: string): Promise<WalletCheckout>;
  getCheckout(checkoutRef: string, purchase: string): Promise<WalletCheckout>;
  /** Asks the rail to revoke the gateway's token. True when the rail confirmed it. */
  revoke(): Promise<boolean>;
}
