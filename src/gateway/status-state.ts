// What `ApprovalStatus.state` must be for an outcome (contract 1.6.0, Appendix G; vector o3), so the gateway repeats
// Intent Cloud's word only when `state` and `outcome` agree: `state` never claims more than `outcome` (`ordered` iff
// the outcome is `ordered`), and every post-approval state carries a proof. Pure.
import { z } from "zod";
import type { ApprovalState, CompletionMode, Outcome, OutcomeState } from "../contract/index.ts";

/** Rule O1's demand on an `ordered` outcome. A schema, so no code reads `.binding` (src/ lint forbids that name). */
const VerifiedOk = z.object({ assurance: z.literal("verified"), binding: z.object({ result: z.literal("ok") }) });

/** The approval states whose status carries a proof (Appendix E); every 1.6.0 post-approval state is one of them. */
export const PROOF_STATES: ReadonlySet<ApprovalState> = new Set(["approved", "handed_off", "ordered"]);

/** Outcome states after which nothing more happens to the purchase (Appendix G). */
export const TERMINAL_OUTCOMES: ReadonlySet<OutcomeState> = new Set(["ordered", "mismatch", "failed", "checkout_expired"]);

/** The 1.6.0 `state` for an outcome in a completion mode (Appendix G's table). */
export function statusState(outcome: OutcomeState, mode: CompletionMode): ApprovalState {
  if (outcome === "ordered") return "ordered";
  return mode === "handoff" ? "handed_off" : "approved";
}

/**
 * Why a 1.6.0 status's `state` and `outcome` disagree, or null when they agree: with an outcome, `state` must be
 * statusState(outcome, mode), and an `ordered` outcome must be verified with binding ok (rule O1). Without one,
 * `state` behaves as in 1.5.0 (Appendix G), so there is nothing to compare.
 */
export function statusProblem(state: ApprovalState, outcome: Outcome | undefined, mode: CompletionMode): string | null {
  if (outcome === undefined) return null;
  const expected = statusState(outcome.state, mode);
  if (state !== expected) return `state is ${state}, but a ${mode} outcome ${outcome.state} means ${expected}`;
  if (outcome.state === "ordered" && !VerifiedOk.safeParse(outcome).success) {
    return "an ordered outcome must be verified with binding ok (rule O1)";
  }
  return null;
}
