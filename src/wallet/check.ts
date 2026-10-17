// The out-of-band check (plan G12, refinement 6): which orders a wallet rail reported that no chained gateway purchase
// names. Pure: the CLI fetches the orders (a disclosed send) and the chain, this file only compares them.
//
// A gateway purchase names its order in an `outcome` entry (the one-tap completion and the outcome module write
// them). This file reads only `order_ref` strings in an outcome body, at any depth up to OUTCOME_DEPTH, so it holds
// whichever outcome shape (Intent Cloud's report or a wallet reading) names the order. Everything else in the chain is
// ignored: an order with no outcome entry is unmatched, whatever else the chain says.
import { CHECKED_KEYS, type WalletOrder, type WalletRail } from "./port.ts";

/** The only currency the gateway spends in (US delivery only): totals in another currency are counted, never summed. */
export const CHECK_CURRENCY = "USD";
const OUTCOME_DEPTH = 4;

/** The order references that the chain's `outcome` entries name. */
export function chainedOrderRefs(entries: readonly { readonly kind: string; readonly body: unknown }[]): Set<string> {
  const refs = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > OUTCOME_DEPTH || typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "order_ref" && typeof inner === "string" && inner !== "") refs.add(inner);
      else walk(inner, depth + 1);
    }
  };
  for (const entry of entries) if (entry.kind === "outcome") walk(entry.body, 0);
  return refs;
}

export interface WalletCheck {
  /** The start of the period, ISO 8601 UTC. */
  readonly since: string;
  /** The orders in the period, oldest first. An order with no usable time is kept: its period cannot be told. */
  readonly orders: readonly WalletOrder[];
  /** The orders in the period that no outcome entry names, oldest first. */
  readonly unmatched: readonly WalletOrder[];
  /** The sum of the unmatched orders' totals in CHECK_CURRENCY, in minor units. */
  readonly unmatchedTotalMinor: number;
  /** Unmatched orders whose total is missing or in another currency, so not in unmatchedTotalMinor. */
  readonly unmatchedUntotalled: number;
  /** False when the rail reported more orders than it returned. */
  readonly complete: boolean;
}

/** Compares the rail's orders since `since` with the order references the chain names. */
export function checkOrders(reported: { readonly orders: readonly WalletOrder[]; readonly complete: boolean }, chained: ReadonlySet<string>, since: Date): WalletCheck {
  const from = since.getTime();
  const orders = reported.orders
    .filter((o) => o.createdAt === null || Date.parse(o.createdAt) >= from)
    .toSorted((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const unmatched = orders.filter((o) => !chained.has(o.orderRef));
  const totalled = unmatched.filter((o) => o.total?.currency === CHECK_CURRENCY);
  return {
    since: since.toISOString(),
    orders,
    unmatched,
    unmatchedTotalMinor: totalled.reduce((sum, o) => sum + (o.total?.amountMinor ?? 0), 0),
    unmatchedUntotalled: unmatched.length - totalled.length,
    complete: reported.complete,
  };
}

/** The `wallet` entry body for a check: exactly CHECKED_KEYS, counts and a total only. */
export function checkedEntry(rail: WalletRail, check: WalletCheck): Record<(typeof CHECKED_KEYS)[number], unknown> {
  return {
    rail,
    action: "checked",
    since: check.since,
    order_count: check.orders.length,
    unmatched_count: check.unmatched.length,
    unmatched_total_minor: check.unmatchedTotalMinor,
    complete: check.complete,
  };
}
