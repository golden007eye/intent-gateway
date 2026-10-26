// Merging the providers' offers, and the policy filter on them (G5). The filter runs on what came back, before the
// agent sees anything: the policy (met with Intent Cloud's baseline, so it can only narrow, invariant 1), the
// excluded categories (excluded.ts), the budget and the per-order, daily and weekly caps.
import { categoryBlocked, type Ceilings, CLOUD_BASELINE, evaluate, meet, merchantMatches, type Policy, type Purchase } from "../policy/index.ts";
import { excludedGroup } from "./excluded.ts";
import type { SearchMoney, SearchOffer } from "./types.ts";

/** The most offers one search returns to the agent. */
export const MAX_OFFERS = 20;

/**
 * The providers' offers as one list, in provider order and each provider's own order, with no variant twice: an offer
 * is the same as an earlier one when both name the same store and variant. At most MAX_OFFERS.
 */
export function mergeOffers(lists: readonly (readonly SearchOffer[])[]): SearchOffer[] {
  const seen = new Set<string>();
  const merged: SearchOffer[] = [];
  for (const list of lists) {
    for (const offer of list) {
      const key = `${offer.storeDomain.toLowerCase()}|${offer.variantRef}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(offer);
      if (merged.length >= MAX_OFFERS) return merged;
    }
  }
  return merged;
}

export interface FilterContext {
  /** The category the search named, if any: checked against the policy's blocked categories on every offer. */
  readonly category?: string;
  readonly budget: SearchMoney | null;
  /** The search's currency (its ship-to country's): an offer in another one cannot be checked against the caps. */
  readonly currency: string;
  /** Intent Cloud's ceilings per currency, which scale the policy's USD caps to `currency` (policy's capsIn). */
  readonly ceilings: Ceilings | null;
  /** Earlier purchases, for the daily and weekly caps (the gateway's spendHistory). */
  readonly history: readonly Purchase[];
  readonly now: number;
}

export interface Filtered {
  readonly kept: SearchOffer[];
  readonly hidden: number;
  /** The rule names that hid offers, sorted: never the merchant, title or price that matched one. */
  readonly rules: readonly string[];
}

function hostOf(origin: string | null): string | null {
  if (origin === null) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * The rules one offer breaks, or none. A store has two names: its myshopify domain and its storefront host. The block
 * list drops an offer when either name matches; the allow list keeps it only when one of them matches. The binding of
 * a purchase (G6) is to the myshopify domain, which a storefront host cannot change.
 */
export function offerProblems(policy: Policy, offer: SearchOffer, context: FilterContext): string[] {
  const effective = meet(policy, CLOUD_BASELINE);
  const problems: string[] = [];
  const names = [offer.storeDomain, hostOf(offer.storefrontOrigin)].filter((n): n is string => n !== null);
  if (names.some((n) => merchantMatches(n, effective.merchants.block))) problems.push("merchants.block");
  const allow = effective.merchants.allow;
  if (allow !== undefined && !names.some((n) => merchantMatches(n, allow))) problems.push("merchants.allow");
  const categories = [...(context.category === undefined ? [] : [context.category]), ...offer.categories];
  if (categories.some((c) => categoryBlocked(c, effective.categories.block))) problems.push("categories.block");
  if (excludedGroup(offer) !== null) problems.push("excluded_categories");
  if (offer.price.currency !== context.currency || !Number.isSafeInteger(offer.price.amountMinor) || offer.price.amountMinor < 0) {
    problems.push("currency");
    return problems;
  }
  const budget = context.budget;
  if (budget !== null && (budget.currency !== offer.price.currency || offer.price.amountMinor > budget.amountMinor)) problems.push("budget");
  // The caps (in the search's currency) and the merchant's form, as for any offer: evaluate's own rounding and history.
  const verdict = evaluate(
    policy,
    { kind: "cart", offer: { merchant: offer.storeDomain, category: "", price_usd: offer.price.amountMinor / 100, quantity: 1, currency: offer.price.currency } },
    context.history,
    context.now,
    context.ceilings,
  );
  for (const b of verdict.blocked) if (b.rule.startsWith("spend.") || b.rule === "offer.merchant" || b.rule === "history_invalid") problems.push(b.rule);
  return problems;
}

/** The offers the policy lets the agent see, how many it hid, and the rules that hid them. */
export function filterOffers(policy: Policy, offers: readonly SearchOffer[], context: FilterContext): Filtered {
  const kept: SearchOffer[] = [];
  const rules = new Set<string>();
  for (const offer of offers) {
    const problems = offerProblems(policy, offer, context);
    if (problems.length === 0) kept.push(offer);
    else for (const rule of problems) rules.add(rule);
  }
  return { kept, hidden: offers.length - kept.length, rules: [...rules].sort() };
}
