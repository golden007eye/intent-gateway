// How the gateway reads an outcome Intent Cloud states (contract 1.6.0, Appendix G rules O1 and O2, M1). Pure.
//
// - O2: Intent Cloud's word is recorded as Intent Cloud's report, beside the gateway's own binding result over the
//   values the statement carries. The gateway never upgrades it.
// - M1: only a verified outcome statement is acted on. An outcome with no statement, or a statement refused by any
//   rule (its signature, or a content rule it breaks even though Intent Cloud signed it), shows nothing
//   (`state_shown: null`): the gateway never derives a state of its own from a statement it refused.
// - O1, on read: `ordered` is shown only when the statement verified and the gateway's own re-run of the result rule,
//   with its own total check against the approved snapshot, gives `ok`; otherwise nothing is shown.
import type { Binding, CompletionMode, OutcomeState } from "../contract/index.ts";
import { bindingResult, type BindingChecks, shipToOptional, totalMatches } from "./binding.ts";

/** What the statement verification said: valid, or refused by a rule, and whether Intent Cloud's signature held. */
export type StatementCheck = { readonly ok: true } | { readonly ok: false; readonly refused_by: string; readonly signed: boolean };

export interface CloudReading {
  /** The state the gateway shows for Intent Cloud's report, or null when nothing is acted on. */
  readonly state_shown: OutcomeState | null;
  /** The gateway's re-run of binding-v1's result over the statement's checks, with its own total check; null without a binding. */
  readonly local_binding: Binding | null;
}

const BINDING_KEY = "binding";

/**
 * Reads Intent Cloud's outcome (the statement's `outcome`) for an approval in `mode` whose snapshot total is
 * `approvedMinor`, given what the statement verification said.
 */
export function readCloudOutcome(
  outcome: unknown,
  approvedMinor: number,
  check: StatementCheck,
  approved: { readonly currency: string; readonly rule: Binding["rule_version"] } = { currency: "USD", rule: "binding-v1" },
): CloudReading {
  const o = record(outcome);
  const state = typeof o.state === "string" ? o.state : "";
  const local = localBinding(o, approvedMinor, approved.currency, approved.rule);
  if (!check.ok) return { state_shown: null, local_binding: local };
  if (state === "ordered" && local?.result !== "ok") return { state_shown: null, local_binding: local };
  return { state_shown: state as OutcomeState, local_binding: local };
}

/** The ApprovalStatus.state a shown outcome stands for (Appendix G's table), for the tool result's short word. */
export function shownStatus(state: OutcomeState, mode: CompletionMode): "approved" | "handed_off" | "ordered" {
  if (state === "ordered") return "ordered";
  return mode === "handoff" ? "handed_off" : "approved";
}

/** The statement's checks with check 5 re-run by the gateway against the approved total, and the result rule re-run. */
function localBinding(o: Record<string, unknown>, approvedMinor: number, currency: string, rule: Binding["rule_version"]): Binding | null {
  const cloud = record(o[BINDING_KEY]);
  const checks = record(cloud.checks);
  const names = ["merchant_origin", "checkout_ref", "line", "ship_to", "total"] as const;
  if (!names.every((n) => checks[n] === "match" || checks[n] === "differs" || checks[n] === "unknown")) return null;
  const mine = { ...(checks as BindingChecks), total: totalMatches(approvedMinor, o.final_total, currency) ? "match" : "differs" } as BindingChecks;
  const source = typeof o.source === "string" ? o.source : "";
  return { rule_version: rule, result: bindingResult(mine, shipToOptional(source)), checks: mine };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
