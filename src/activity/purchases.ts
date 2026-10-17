// The actions of one purchase, grouped: the search before it, the cart (with its approval request), the agent's
// approval-status checks and the verified approval, joined by the approval handle. Pure, like buildActivity; the
// panel's purchase timeline reads it. It says what the chain holds, never what Intent Cloud does next (invariant 5).
import type { Activity, Delivery } from "./activity.ts";

/**
 * Where a purchase stands, from the chain alone: `approved` (a verified Approval is chained), `waiting` (an approval
 * was asked for and has not expired), `expired` (asked for, expired, none chained, or a status check's observation
 * says so), `rejected` (a status check's observation says Intent Cloud returned `rejected`), `refused` (the gateway
 * refused what came back), or the cart request's delivery when no approval was asked for.
 */
export type PurchaseState = "approved" | OutcomeShown | "waiting" | "expired" | "rejected" | "refused" | Delivery;

/**
 * What happened after the approval, as the chain shows it (plan G5): the gateway's own one-tap evidence, else Intent
 * Cloud's verified statement (the `outcome` entry's state_shown, never more).
 */
export const OUTCOME_SHOWN = ["completing", "indeterminate", "ordered", "mismatch", "failed", "handed_off", "checkout_expired", "reported"] as const;
export type OutcomeShown = (typeof OUTCOME_SHOWN)[number];
const SHOWN: ReadonlySet<string> = new Set(OUTCOME_SHOWN);

export interface Purchase {
  /** The cart action's first seq. */
  readonly seq: number;
  readonly state: PurchaseState;
  /** The last search before the cart, when there is one. */
  readonly search: Activity | null;
  readonly cart: Activity;
  /** The agent's approval-status checks for this cart's approval, in chain order. */
  readonly checks: Activity[];
  /** The verified, chained Approval. */
  readonly approval: Activity | null;
}

const DELIVERIES: ReadonlySet<string> = new Set(["acknowledged", "unacknowledged", "not_sent", "maybe_sent", "discarded"]);

/** Each cart in the activity list as a purchase, in chain order. `now` decides whether a waiting approval expired. */
export function buildPurchases(activities: readonly Activity[], now: number): Purchase[] {
  const purchases: Purchase[] = [];
  let search: Activity | null = null;
  for (const activity of activities) {
    if (activity.action === "search") search = activity;
    if (activity.action !== "cart") continue;
    const handle = activity.facts.approval_handle;
    const same = (a: Activity) => handle !== undefined && a.facts.approval_handle === handle;
    const checks = activities.filter((a) => a.action === "status" && same(a));
    const approval = activities.find((a) => a.action === "approval" && same(a)) ?? null;
    purchases.push({ seq: activity.seq, state: stateOf(activity, approval, now), search, cart: activity, checks, approval });
  }
  return purchases;
}

function stateOf(cart: Activity, approval: Activity | null, now: number): PurchaseState {
  if (cart.outcome === "refused") return "refused";
  if (approval !== null) {
    const shown = approval.facts.outcome_state;
    return shown !== undefined && SHOWN.has(shown) ? (shown as OutcomeShown) : "approved";
  }
  // The latest approval state an observation recorded (src/activity's observe); absent on chains without observations.
  if (cart.facts.approval_state === "rejected") return "rejected";
  if (cart.facts.approval_state === "expired") return "expired";
  if (cart.facts.approval_handle !== undefined) {
    const expires = cart.facts.expires_at === undefined ? Number.NaN : Date.parse(cart.facts.expires_at);
    return expires <= now ? "expired" : "waiting";
  }
  // No approval asked for and nothing refused: the outcome is the worst delivery of the cart's requests.
  return DELIVERIES.has(cart.outcome) ? (cart.outcome as Delivery) : "maybe_sent";
}
