// The outcome model's tables (contract 1.6.0, Appendix G, as amended): which states each completion mode has, which
// sources Intent Cloud reads itself, each source's assurance cap, and R5a's precedence between outcomes. Pure.
import type { CompletionMode, OutcomeSource, OutcomeState } from "../contract/index.ts";

/** The outcome states of each completion mode (Appendix G "Outcome states"). */
export const MODE_STATES: Readonly<Record<CompletionMode, ReadonlySet<OutcomeState>>> = {
  handoff: new Set(["handed_off", "checkout_expired", "mismatch", "reported", "ordered"]),
  shop_agent: new Set(["completing", "indeterminate", "failed", "mismatch", "reported", "ordered"]),
};

/** States after which nothing more happens to the purchase. */
export const TERMINAL_STATES: ReadonlySet<OutcomeState> = new Set(["ordered", "mismatch", "failed", "checkout_expired"]);

/** The sources Intent Cloud reads itself: the only ones its outcome statements may name. */
export const CLOUD_SOURCES: ReadonlySet<OutcomeSource> = new Set(["merchant_api", "signed_webhook", "staging_webhook", "checkout_page", "gateway_report"]);

/** Sources whose outcomes are `reported` at most (the sources table's assurance cap). */
export const REPORTED_ONLY_SOURCES: ReadonlySet<OutcomeSource> = new Set(["checkout_page", "gateway_report"]);

/** What a gateway may say it observed (`reported.source`, and the gateway's own outcomes). */
export const GATEWAY_SOURCES: ReadonlySet<OutcomeSource> = new Set(["shop_api", "gateway_precheck"]);

/** The states a gateway report can carry (R4), so the states of `reported.state` (R5, Update 2). */
export const REPORT_STATES: ReadonlySet<string> = new Set(["completing", "indeterminate", "ordered", "mismatch", "failed"]);

/** `OrderRef` as amended: a merchant reference or a canonical Shopify order id; the pattern matches the whole value. */
export const ORDER_REF = /^(?:[A-Za-z0-9#-]{1,64}|gid:\/\/shopify\/Order\/[0-9]{1,20})$/;

/** The part of an outcome R5a's precedence reads. */
export interface OutcomeHead {
  readonly state: string;
  readonly source: string;
  readonly assurance: string;
}

/**
 * R5a (vector o4, precedence rows): may outcome `next` replace `current`? A terminal verified outcome is final; a
 * verified outcome replaces any reported one; a reported outcome never replaces a verified one, and replaces a
 * reported one only from the same source.
 */
export function replaces(current: OutcomeHead, next: OutcomeHead): boolean {
  if (current.assurance === "verified") return !TERMINAL_STATES.has(current.state as OutcomeState) && next.assurance === "verified";
  if (next.assurance === "verified") return true;
  return current.source === next.source;
}
