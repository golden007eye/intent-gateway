// Decides whether one outbound request may leave the gateway under a policy. The input types are the policy's
// own small view of a request; the gateway maps the contract's request and offer types onto them.
import { isCoarse } from "../shipto/index.ts";
import { excludedHead, headText } from "./keywords.ts";
import { CLOUD_BASELINE, categoryBlocked, type CompletionMode, EXCLUDED_CATEGORIES, normalizeCategory, meet, merchantMatches, normalizeMerchant, type Policy, type Spend } from "./policy.ts";

/** A search the agent asks the gateway to send to Intent Cloud. */
export interface SearchRequest {
  readonly kind: "search";
  /** The exact product asked for: free text, checked for a blocked category's words like the category. */
  readonly product?: string;
  readonly category?: string;
  readonly must_haves?: readonly string[];
  readonly budget_usd?: number;
  /** The coarse postcode the search would send (policy v1's name: for the US, the 5-digit ZIP). */
  readonly ship_to_zip?: string;
  /** ISO 3166-1 alpha-2 of `ship_to_zip`; absent means US. */
  readonly ship_to_country?: string;
  /** Past purchases or searches offered as context. Policy v1 never shares them. */
  readonly history?: readonly unknown[];
}

/**
 * The offer a cart would be created for. `price_usd` is the unit price in whole units of `currency` (policy v1's
 * name; absent `currency` means USD): a price in Canadian dollars is checked against the caps in CAD.
 */
export interface Offer {
  readonly merchant: string;
  readonly category: string;
  readonly price_usd: number;
  readonly quantity: number;
  readonly currency?: string;
}

export interface CartRequest {
  readonly kind: "cart";
  readonly offer: Offer;
  /** How the purchase would be completed. Absent means `handoff`, the only mode a cart has before one-tap. */
  readonly completion_mode?: CompletionMode;
}

export type Outbound = SearchRequest | CartRequest;

/** A purchase the gateway already approved: its time (ms since epoch) and its total, in `currency` (absent: USD). */
export interface Purchase {
  readonly at: number;
  readonly total_usd: number;
  readonly currency?: string;
}

/** Intent Cloud's ceilings per currency (its currency table), in minor units: what the caps scale by. */
export type Ceilings = Readonly<Record<string, { readonly order: number; readonly week: number }>>;

/** The policy's caps in one currency's minor units; absent where the policy sets none. */
export interface CapsMinor {
  readonly per_order_usd?: number;
  readonly per_day_usd?: number;
  readonly per_week_usd?: number;
}

/** One refusal: the outbound field at fault, the policy rule that refused it, and why. */
export interface Blocked {
  readonly path: string;
  readonly rule: string;
  readonly reason: string;
  /**
   * A search's `categories.block` only: the excluded group (`alcohol`) or the policy's own blocked category that the
   * field names. Always a word from the keyword lists or the policy, never the request's own text.
   */
  readonly named?: string;
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

/** Spend counts only purchases in the same currency, as Intent Cloud counts its week. */
function spentWithin(history: readonly Purchase[], now: number, windowMs: number, currency: string): number {
  return history.filter((p) => p.at > now - windowMs && (p.currency ?? "USD") === currency).reduce((sum, p) => sum + cents(p.total_usd), 0);
}

/**
 * The policy's caps (whole USD) in `currency`'s minor units: each USD cap × (the currency's ceiling / the USD ceiling),
 * the order ceilings for per_order and per_day and the week ceilings for per_week, floored to a whole minor unit. USD
 * caps need no table. Null when they cannot be scaled (scalable): then no cap in that currency exists.
 */
export function capsIn(spend: Spend, currency: string, ceilings: Ceilings | null): CapsMinor | null {
  if (!scalable(currency, ceilings)) return null;
  const usd = ceilings?.USD;
  const own = currency === "USD" ? undefined : ceilings?.[currency];
  const caps: { -readonly [K in keyof CapsMinor]: number } = {};
  for (const key of ["per_order_usd", "per_day_usd", "per_week_usd"] as const) {
    const cap = spend[key];
    if (cap === undefined) continue;
    if (usd === undefined || own === undefined) {
      caps[key] = cap * 100;
      continue;
    }
    const [num, den] = key === "per_week_usd" ? [own.week, usd.week] : [own.order, usd.order];
    caps[key] = Number((BigInt(cap) * 100n * BigInt(num)) / BigInt(den));
  }
  return caps;
}

/**
 * The narrowest and widest a currency's ceiling may be against the USD one, per order and per week, for the policy's
 * caps to be scaled by it. Intent Cloud's ratios are 0.8 to 1.5 today; outside these bounds a table could widen a cap
 * without limit, and a policy may only narrow (invariant 1), so the currency is treated as unsupported.
 */
export const RATIO_BOUNDS = Object.freeze({ min: 0.25, max: 4 });

/**
 * Whether the USD caps can be put in `currency`: always for USD; otherwise the table must list USD and the currency,
 * with a USD ceiling above zero and both of the currency's ratios to it within RATIO_BOUNDS.
 */
export function scalable(currency: string, ceilings: Ceilings | null): boolean {
  if (currency === "USD") return true;
  const usd = ceilings?.USD;
  const own = ceilings !== null && Object.hasOwn(ceilings, currency) ? ceilings[currency] : undefined;
  if (usd === undefined || own === undefined || usd.order <= 0 || usd.week <= 0) return false;
  // min ≤ own/usd ≤ max, compared without dividing.
  const within = (o: number, u: number): boolean => o * (1 / RATIO_BOUNDS.min) >= u && o <= u * RATIO_BOUNDS.max;
  return within(own.order, usd.order) && within(own.week, usd.week);
}

/** A cap for a sentence: `$20` in USD, `CAD 28` (or `CAD 28.50`) otherwise. */
export function capText(minor: number, currency: string): string {
  const amount = minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
  return currency === "USD" ? `$${amount}` : `${currency} ${amount}`;
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
    const { currency } = entry;
    const valid =
      typeof at === "number" &&
      Number.isFinite(at) &&
      typeof total === "number" &&
      Number.isFinite(total) &&
      total >= 0 &&
      (currency === undefined || (typeof currency === "string" && /^[A-Z]{3}$/.test(currency)));
    if (!valid) {
      out.push({
        path: `purchase_history[${String(i)}]`,
        rule: "history_invalid",
        reason: "a purchase needs a finite time and a finite total ≥ 0",
      });
    }
  });
}

/** Category names for an excluded group that are no product keyword: a "spirits" category is alcohol. */
const CATEGORY_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  alcohol: ["spirits", "liquor", "liquors", "alcoholic beverages", "alcoholic drinks"],
  tobacco: ["e-cigarettes", "e-cigarette", "vape products"],
});

/**
 * The blocked category a product or must-have is, read from its head noun only (excludedHead), or the words of a
 * single-level category the policy itself blocks at its end (`cheap electronics`, `power-tools` as "power tools").
 * Null for anything a modifier merely names: "Bourbon vanilla extract", "wine gums", "shotgun microphone".
 */
function headCategory(text: string, blocked: readonly string[]): string | null {
  const group = excludedHead(text);
  if (group !== null) return group;
  const head = headText(text);
  for (const category of blocked) {
    if (category.includes("/") || EXCLUDED_CATEGORIES.includes(category)) continue;
    const words = category.split("-").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+");
    if (new RegExp(`(?<![\\p{L}\\p{N}])${words}(?:e?s)?$`, "u").test(head)) return category;
  }
  return null;
}

/** The excluded group a category field names: a level whose head noun is a keyword, or one of CATEGORY_WORDS. */
function namedCategory(category: string, blocked: readonly string[]): string | null {
  for (const level of normalizeCategory(category).split("/")) {
    const words = level.replace(/[-_]+/g, " ").trim();
    const named = headCategory(words, blocked);
    if (named !== null) return named;
    for (const [group, names] of Object.entries(CATEGORY_WORDS)) if (names.includes(words) || names.includes(level)) return group;
  }
  return null;
}

/**
 * The request check is an early courtesy, not the enforcement: it refuses only the obvious cases, a category that is
 * or names an excluded or blocked one, and a product or must-have whose head noun is one ("single malt whisky",
 * "gift card", "nicotine pouches"). A modifier never refuses a search, so "Bourbon vanilla extract" is sent; what
 * comes back is still checked against the search's category, and Shop results are screened by keyword anywhere in
 * the title (src/search/excluded.ts), which is the enforcement. The reason names the category group only, never the
 * free text.
 */
function checkSearch(p: Policy, s: SearchRequest, out: Blocked[]): void {
  if (s.category !== undefined && categoryBlocked(s.category, p.categories.block)) {
    const category = s.category;
    const named = p.categories.block.find((c) => categoryBlocked(category, [c]));
    out.push({ path: "category", rule: "categories.block", reason: `category "${s.category}" is blocked`, ...(named === undefined ? {} : { named }) });
  } else if (s.category !== undefined) {
    const named = namedCategory(s.category, p.categories.block);
    if (named !== null) out.push({ path: "category", rule: "categories.block", reason: `the category names ${named}, a blocked category`, named });
  }
  const free: [string, string][] = [
    ...(s.product === undefined ? [] : [["product", s.product] as [string, string]]),
    ...(s.must_haves ?? []).map((m, i): [string, string] => [`must_haves[${String(i)}]`, m]),
  ];
  for (const [path, text] of free) {
    const named = headCategory(text, p.categories.block);
    if (named !== null) out.push({ path, rule: "categories.block", reason: `the ${path.startsWith("must") ? "must-have" : "product"} names ${named}, a blocked category`, named });
  }
  if (s.ship_to_zip !== undefined) {
    const country = s.ship_to_country ?? "US";
    if (p.share.ship_to === "none") {
      out.push({ path: "ship_to_zip", rule: "share.ship_to", reason: "the policy shares no ship-to postcode" });
    } else if (country === "US" ? !US_ZIP.test(s.ship_to_zip) : !isCoarse(country, s.ship_to_zip)) {
      const reason = country === "US" ? "only a 5-digit US ZIP may be shared" : `only the coarse part of a ${country} postcode may be shared`;
      out.push({ path: "ship_to_zip", rule: "share.ship_to", reason });
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

function checkCart(p: Policy, o: Offer, history: readonly Purchase[], now: number, ceilings: Ceilings | null, out: Blocked[]): void {
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
  const currency = o.currency ?? "USD";
  const scaled = capsIn(p.spend, currency, ceilings);
  if (scaled === null) {
    // Caps that cannot be put in this currency are never skipped: the cart is refused.
    if (Object.keys(p.spend).length > 0) {
      out.push({ path: "offer.currency", rule: "spend.currency", reason: `the limits cannot be put in ${currency}: the currency table Intent Cloud returns gives no usable ceiling for it` });
    }
    return;
  }
  const caps = [
    ["per_order_usd", 0, "per order"],
    ["per_day_usd", DAY_MS, "per day"],
    ["per_week_usd", WEEK_MS, "per week"],
  ] as const;
  for (const [key, windowMs, label] of caps) {
    const cap = scaled[key];
    if (cap === undefined) continue;
    const spent = windowMs === 0 ? 0 : spentWithin(history, now, windowMs, currency);
    if (spent + total > cap) {
      out.push({ path: "offer.price_usd", rule: `spend.${key}`, reason: `over the ${capText(cap, currency)} ${label} limit` });
    }
  }
}

/**
 * Applies the policy, met with Intent Cloud's baseline, to one outbound request. `history` holds earlier
 * purchases for the daily (24 h) and weekly (7 × 24 h) limits, counted back from `now` in the cart's currency; a
 * malformed entry refuses the request (`history_invalid`) rather than being skipped. `ceilings` (Intent Cloud's
 * currency table) scales the USD caps for a cart in another currency (capsIn); without it such a cart is refused.
 */
export function evaluate(
  policy: Policy,
  outbound: Outbound,
  history: readonly Purchase[],
  now: number = Date.now(),
  ceilings: Ceilings | null = null,
): Decision {
  const effective = meet(policy, CLOUD_BASELINE);
  const blocked: Blocked[] = [];
  checkHistory(history, blocked);
  // A bad history already refuses the request; the caps then run on none rather than on the bad entries.
  const purchases = blocked.length === 0 ? history : [];
  if (outbound.kind === "search") checkSearch(effective, outbound, blocked);
  else {
    checkCart(effective, outbound.offer, purchases, now, ceilings, blocked);
    checkCompletion(effective, outbound.completion_mode, blocked);
  }
  return { send: blocked.length === 0, blocked };
}
