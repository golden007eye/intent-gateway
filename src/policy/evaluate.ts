// Decides whether one outbound request may leave the gateway under a policy. The input types are the policy's
// own small view of a request; the gateway maps the contract's request and offer types onto them.
import { CLOUD_BASELINE, categoryBlocked, type CompletionMode, meet, merchantMatches, normalizeMerchant, type Policy } from "./policy.ts";

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
  /** How the purchase would be completed. Absent means `handoff`, the only mode a cart has before one-tap. */
  readonly completion_mode?: CompletionMode;
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

// Money is compared in whole cents, rounded up, so that 3 × $20.004 counts as $60.02 and not $60. The total is
// first rounded to a millionth of a dollar so float noise (0.07 × 100 = 7.000000000000001) does not add a cent.
const cents = (usd: number): number => Math.ceil(Math.round(usd * 1e6) / 1e4);

function spentWithin(history: readonly Purchase[], now: number, windowMs: number): number {
  return history.filter((p) => p.at > now - windowMs).reduce((sum, p) => sum + cents(p.total_usd), 0);
}

/** Bad history would turn the daily and weekly caps off, so any malformed entry refuses the request. */
function checkHistory(history: readonly Purchase[], out: Blocked[]): void {
  if (!Array.isArray(history)) {
    out.push({ path: "purchase_history", rule: "history_invalid", reason: "the purchase history is not a list" });
    return;
  }
  history.forEach((p: unknown, i) => {
    const entry = typeof p === "object" && p !== null ? (p as Partial<Record<keyof Purchase, unknown>>) : {};
    const { at, total_usd: total } = entry;
    const valid =
      typeof at === "number" && Number.isFinite(at) && typeof total === "number" && Number.isFinite(total) && total >= 0;
    if (!valid) {
      out.push({
        path: `purchase_history[${String(i)}]`,
        rule: "history_invalid",
        reason: "a purchase needs a finite time and a finite total ≥ 0",
      });
    }
  });
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

function checkCompletion(p: Policy, mode: CompletionMode | undefined, out: Blocked[]): void {
  const m = mode ?? "handoff";
  // `includes` on the policy's own list, so a mode outside the schema (a typo, `auto`) is refused, never allowed.
  if (!p.completion.includes(m)) {
    out.push({
      path: "completion_mode",
      rule: "completion",
      reason: `completion mode "${m}" is not allowed; the policy allows ${p.completion.join(", ")}`,
    });
  }
}

function checkCart(p: Policy, o: Offer, history: readonly Purchase[], now: number, out: Blocked[]): void {
  if (normalizeMerchant(o.merchant) === undefined) {
    out.push({ path: "offer.merchant", rule: "offer.merchant", reason: `merchant "${o.merchant}" is not a hostname` });
  } else {
    if (merchantMatches(o.merchant, p.merchants.block)) {
      out.push({ path: "offer.merchant", rule: "merchants.block", reason: `merchant "${o.merchant}" is blocked` });
    }
    if (p.merchants.allow !== undefined && !merchantMatches(o.merchant, p.merchants.allow)) {
      out.push({ path: "offer.merchant", rule: "merchants.allow", reason: `merchant "${o.merchant}" is not allowed` });
    }
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
  const total = cents(o.price_usd * (Number.isSafeInteger(o.quantity) && o.quantity > 0 ? o.quantity : 1));
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
 * purchases for the daily (24 h) and weekly (7 × 24 h) limits, counted back from `now`; a malformed entry
 * refuses the request (`history_invalid`) rather than being skipped.
 */
export function evaluate(
  policy: Policy,
  outbound: Outbound,
  history: readonly Purchase[],
  now: number = Date.now(),
): Decision {
  const effective = meet(policy, CLOUD_BASELINE);
  const blocked: Blocked[] = [];
  checkHistory(history, blocked);
  // A bad history already refuses the request; the caps then run on none rather than on the bad entries.
  const purchases = blocked.length === 0 ? history : [];
  if (outbound.kind === "search") checkSearch(effective, outbound, blocked);
  else {
    checkCart(effective, outbound.offer, purchases, now, blocked);
    checkCompletion(effective, outbound.completion_mode, blocked);
  }
  return { send: blocked.length === 0, blocked };
}
