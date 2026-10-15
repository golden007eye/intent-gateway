// Decides whether one outbound request may leave the gateway under a policy. The input types are the policy's
// own small view of a request; the gateway maps the contract's request and offer types onto them.
import { CLOUD_BASELINE, categoryBlocked, meet, merchantMatches, type Policy } from "./policy.ts";

/** A search the agent asks the gateway to send to Intent Cloud. */
export interface SearchRequest {
  readonly kind: "search";
  readonly category?: string;
  readonly must_haves?: readonly string[];
  readonly budget_usd?: number;
  readonly ship_to_zip?: string;
  /** Past purchases or searches offered as context. Policy v1 never shares them. */
  readonly history?: readonly unknown[];
}

/** The offer a cart would be created for. */
export interface Offer {
  readonly merchant: string;
  readonly category: string;
  readonly price_usd: number;
  readonly quantity: number;
}

export interface CartRequest {
  readonly kind: "cart";
  readonly offer: Offer;
}

export type Outbound = SearchRequest | CartRequest;

/** A purchase the gateway already approved: its time (ms since epoch) and its total. */
export interface Purchase {
  readonly at: number;
  readonly total_usd: number;
}

/** One refusal: the outbound field at fault, the policy rule that refused it, and why. */
export interface Blocked {
  readonly path: string;
  readonly rule: string;
  readonly reason: string;
}

export interface Decision {
  readonly send: boolean;
  readonly blocked: readonly Blocked[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const US_ZIP = /^\d{5}$/;

// Money is compared in whole cents so that sums of prices like 0.1 + 0.2 do not trip a cap.
const cents = (usd: number): number => Math.round(usd * 100);

function spentWithin(history: readonly Purchase[], now: number, windowMs: number): number {
  return history.filter((p) => p.at > now - windowMs).reduce((sum, p) => sum + cents(p.total_usd), 0);
}

function checkSearch(p: Policy, s: SearchRequest, out: Blocked[]): void {
  if (s.category !== undefined && categoryBlocked(s.category, p.categories.block)) {
    out.push({ path: "category", rule: "categories.block", reason: `category "${s.category}" is blocked` });
  }
  if (s.ship_to_zip !== undefined) {
    if (p.share.ship_to === "none") {
      out.push({ path: "ship_to_zip", rule: "share.ship_to", reason: "the policy shares no ship-to postcode" });
    } else if (!US_ZIP.test(s.ship_to_zip)) {
      out.push({ path: "ship_to_zip", rule: "share.ship_to", reason: "only a 5-digit US ZIP may be shared" });
    }
  }
  if (s.history !== undefined && s.history.length > 0) {
    out.push({ path: "history", rule: "share.history", reason: "the policy shares no history" });
  }
}

function checkCart(p: Policy, o: Offer, history: readonly Purchase[], now: number, out: Blocked[]): void {
  if (merchantMatches(o.merchant, p.merchants.block)) {
    out.push({ path: "offer.merchant", rule: "merchants.block", reason: `merchant "${o.merchant}" is blocked` });
  }
  if (p.merchants.allow !== undefined && !merchantMatches(o.merchant, p.merchants.allow)) {
    out.push({ path: "offer.merchant", rule: "merchants.allow", reason: `merchant "${o.merchant}" is not allowed` });
  }
  if (categoryBlocked(o.category, p.categories.block)) {
    out.push({ path: "offer.category", rule: "categories.block", reason: `category "${o.category}" is blocked` });
  }
  if (!Number.isSafeInteger(o.quantity) || o.quantity < 1 || o.quantity > p.quantity.max) {
    out.push({ path: "offer.quantity", rule: "quantity.max", reason: `quantity must be 1 to ${String(p.quantity.max)}` });
  }
  if (!Number.isFinite(o.price_usd) || o.price_usd < 0) {
    out.push({ path: "offer.price_usd", rule: "offer.price_usd", reason: "price must be a finite amount ≥ 0" });
    return;
  }
  const total = cents(o.price_usd) * (Number.isSafeInteger(o.quantity) && o.quantity > 0 ? o.quantity : 1);
  const caps = [
    ["per_order_usd", 0, "per order"],
    ["per_day_usd", DAY_MS, "per day"],
    ["per_week_usd", WEEK_MS, "per week"],
  ] as const;
  for (const [key, windowMs, label] of caps) {
    const cap = p.spend[key];
    if (cap === undefined) continue;
    const spent = windowMs === 0 ? 0 : spentWithin(history, now, windowMs);
    if (spent + total > cap * 100) {
      out.push({ path: "offer.price_usd", rule: `spend.${key}`, reason: `over the $${String(cap)} ${label} limit` });
    }
  }
}

/**
 * Applies the policy, met with Intent Cloud's baseline, to one outbound request. `history` holds earlier
 * purchases for the daily (24 h) and weekly (7 × 24 h) limits, counted back from `now`.
 */
export function evaluate(
  policy: Policy,
  outbound: Outbound,
  history: readonly Purchase[],
  now: number = Date.now(),
): Decision {
  const effective = meet(policy, CLOUD_BASELINE);
  const blocked: Blocked[] = [];
  if (outbound.kind === "search") checkSearch(effective, outbound, blocked);
  else checkCart(effective, outbound.offer, history, now, blocked);
  return { send: blocked.length === 0, blocked };
}
