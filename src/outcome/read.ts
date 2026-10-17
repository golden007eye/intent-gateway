// How the gateway reads an outcome Intent Cloud states (contract 1.6.0, Appendix G rules O1 and O2, M1). Pure.
//
// - O2: Intent Cloud's word is recorded as Intent Cloud's report, beside the gateway's own binding result over the
//   values the statement carries. The gateway never upgrades it.
// - M1: only a verified outcome statement is acted on. An outcome with no statement, a statement that does not verify,
//   or one whose signature does not hold, shows nothing (`state_shown: null`).
// - O1, on read: a statement Intent Cloud did sign but that breaks a content rule claims more than it shows. It is
//   not verified, and the gateway shows only the lesser state its own reading supports: an `ordered` or `mismatch`
//   whose total or binding result does not hold shows `mismatch` (an order may exist and it does not match what the
//   buyer approved); one whose source or assurance cannot carry an order shows `reported`. Never `ordered`.
// - `ordered` is shown only when the statement verified and the gateway's own re-run of the result rule, with its own
//   total check against the approved snapshot, gives `ok`.
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

/** Refusals of a signed statement that still show an order may exist that does not match: shown `mismatch`. */
const SHOWN_MISMATCH: ReadonlySet<string> = new Set(["final_total", "binding_result"]);
/** Refusals of a signed statement whose source or assurance cannot carry an order: shown `reported`. */
const SHOWN_REPORTED: ReadonlySet<string> = new Set(["assurance", "o1"]);
const ORDER_STATES: ReadonlySet<string> = new Set(["ordered", "mismatch"]);

const BINDING_KEY = "binding";

/**
 * Reads Intent Cloud's outcome (the statement's `outcome`) for an approval in `mode` whose snapshot total is
 * `approvedMinor`, given what the statement verification said.
 */
export function readCloudOutcome(outcome: unknown, approvedMinor: number, check: StatementCheck): CloudReading {
  const o = record(outcome);
  const state = typeof o.state === "string" ? o.state : "";
  const local = localBinding(o, approvedMinor);
  if (!check.ok) {
    if (!check.signed) return { state_shown: null, local_binding: local };
    if (SHOWN_MISMATCH.has(check.refused_by) && ORDER_STATES.has(state)) return { state_shown: "mismatch", local_binding: local };
    if (SHOWN_REPORTED.has(check.refused_by) && (ORDER_STATES.has(state) || state === "reported")) return { state_shown: "reported", local_binding: local };
    return { state_shown: null, local_binding: local };
  }
  if (state === "ordered") {
    if (local?.result === "ok") return { state_shown: "ordered", local_binding: local };
    return { state_shown: local?.result === "mismatch" ? "mismatch" : "reported", local_binding: local };
  }
  return { state_shown: state as OutcomeState, local_binding: local };
}

/** The ApprovalStatus.state a shown outcome stands for (Appendix G's table), for the tool result's short word. */
export function shownStatus(state: OutcomeState, mode: CompletionMode): "approved" | "handed_off" | "ordered" {
  if (state === "ordered") return "ordered";
  return mode === "handoff" ? "handed_off" : "approved";
}

/** The statement's checks with check 5 re-run by the gateway against the approved total, and the result rule re-run. */
function localBinding(o: Record<string, unknown>, approvedMinor: number): Binding | null {
  const cloud = record(o[BINDING_KEY]);
  const checks = record(cloud.checks);
  const names = ["merchant_origin", "checkout_ref", "line", "ship_to", "total"] as const;
  if (!names.every((n) => checks[n] === "match" || checks[n] === "differs" || checks[n] === "unknown")) return null;
  const mine = { ...(checks as BindingChecks), total: totalMatches(approvedMinor, o.final_total) ? "match" : "differs" } as BindingChecks;
  const source = typeof o.source === "string" ? o.source : "";
  return { rule_version: "binding-v1", result: bindingResult(mine, shipToOptional(source)), checks: mine };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
