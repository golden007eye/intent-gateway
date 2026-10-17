// Vector o3 (contract 1.6.0, Appendix G): the gateway's state table gives every row's 1.6.0 state, every such state
// carries a proof (so the proof check still runs), and a status whose state claims more than its outcome is caught.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalState, type CompletionMode, type Outcome, OutcomeState } from "../contract/index.ts";
import { PROOF_STATES, statusProblem, statusState, TERMINAL_OUTCOMES } from "./status-state.ts";

interface O3 {
  cases: { input: { outcome_state: string; mode: CompletionMode }; expected: { "1.6.0": string; "1.5.0": string | null } }[];
}
const o3 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "o3-status-state.json"), "utf8")) as O3;
const BINDING_OK: Outcome["binding"] = {
  rule_version: "binding-v1",
  result: "ok",
  checks: { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "match", total: "match" },
};
const outcomeOf = (state: string, extra: Partial<Outcome> = {}): Outcome => ({
  state: OutcomeState.parse(state),
  source: "merchant_api",
  assurance: state === "ordered" ? "verified" : "reported",
  ...(state === "ordered" ? { binding: BINDING_OK } : {}),
  observed_at: "2026-10-16T12:05:00Z",
  ...extra,
});

describe("vector o3", () => {
  it("has the 11 rows of Appendix G's table", () => {
    expect(o3.cases).toHaveLength(11);
  });

  it.each(o3.cases.map((c) => [`${c.input.outcome_state} (${c.input.mode})`, c] as const))("%s", (_name, c) => {
    const state = ApprovalState.parse(c.expected["1.6.0"]);
    expect(statusState(OutcomeState.parse(c.input.outcome_state), c.input.mode)).toBe(state);
    // Every post-approval state carries a proof, so the gateway's proof check runs for every row.
    expect(PROOF_STATES.has(state)).toBe(true);
    expect(statusProblem(state, outcomeOf(c.input.outcome_state), c.input.mode)).toBeNull();
  });

  it("names every outcome state of the contract", () => {
    expect([...new Set(o3.cases.map((c) => c.input.outcome_state))].sort()).toEqual([...OutcomeState.options].sort());
  });
});

describe("statusProblem", () => {
  it("passes a status without an outcome, as 1.5.0 states behave", () => {
    for (const state of ApprovalState.options) expect(statusProblem(state, undefined, "handoff")).toBeNull();
  });

  // Attack cases: Intent Cloud's state must never claim more than its outcome.
  it.each([
    ["ordered with a handed_off outcome", "ordered", "handed_off", "handoff"],
    ["ordered with a completing outcome", "ordered", "completing", "shop_agent"],
    ["handed_off for a shop_agent outcome", "handed_off", "failed", "shop_agent"],
    ["approved for a hand-off outcome", "approved", "handed_off", "handoff"],
  ] as const)("refuses %s", (_name, state, outcome, mode) => {
    expect(statusProblem(state, outcomeOf(outcome), mode)).not.toBeNull();
  });

  it("refuses an ordered outcome that is not verified with binding ok (rule O1)", () => {
    expect(statusProblem("ordered", outcomeOf("ordered", { assurance: "reported" }), "handoff")).toMatch(/O1/);
    expect(statusProblem("ordered", outcomeOf("ordered", { binding: { rule_version: "binding-v1", result: "mismatch", checks: { merchant_origin: "match", checkout_ref: "match", line: "differs", ship_to: "match", total: "match" } } }), "handoff")).toMatch(/O1/);
  });

  it("names the terminal outcomes of Appendix G", () => {
    expect([...TERMINAL_OUTCOMES].sort()).toEqual(["checkout_expired", "failed", "mismatch", "ordered"]);
  });
});
