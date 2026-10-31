// Policy test cases (cases.yaml): sample requests with the decision the policy must reach. `intent policy test`
// and the seed-library tests run them.
import { z } from "zod";
import { evaluate, type Decision, type Outbound, type Purchase } from "./evaluate.ts";
import { DOCUMENT, PolicyError, joinPath, parseStrictYaml } from "./parse.ts";
import type { Policy } from "./policy.ts";

export const MAX_CASES_BYTES = 256 * 1024;
/** `now` for a case that names none, so a case file runs the same on every day. */
export const CASE_EPOCH = "2026-01-01T00:00:00Z";

const instant = z.iso.datetime({ offset: true });
const text = z.string().max(1000);

const outbound = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("search"),
    product: text.optional(),
    category: text.optional(),
    must_haves: z.array(text).max(50).optional(),
    budget_usd: z.number().optional(),
    ship_to_zip: text.optional(),
    ship_to_country: text.optional(),
    history: z.array(z.unknown()).optional(),
  }),
  z.strictObject({
    kind: z.literal("cart"),
    offer: z.strictObject({ merchant: text, category: text, price_usd: z.number(), quantity: z.number() }),
    completion_mode: z.enum(["handoff", "one_tap"]).optional(),
  }),
]);

const caseSchema = z.strictObject({
  name: z.string().min(1).max(200),
  now: instant.optional(),
  history: z.array(z.strictObject({ at: instant, total_usd: z.number().nonnegative() })).optional(),
  outbound,
  expect: z.strictObject({ send: z.boolean(), blocked: z.array(z.string()).optional() }),
});

const casesSchema = z.array(caseSchema).min(1).max(1000);

export interface CaseResult {
  readonly name: string;
  readonly pass: boolean;
  readonly decision: Decision;
  /** The rules (`Blocked.rule`) the case expects to refuse it, sorted; empty when it expects a send. */
  readonly expected: { readonly send: boolean; readonly blocked: readonly string[] };
}

const ruleSet = (rules: Iterable<string>): string[] => [...new Set(rules)].sort();

/** Runs every case in a cases.yaml against `policy`. Throws PolicyError (POLICY_INVALID) for a malformed file. */
export function runCases(policy: Policy, casesYaml: string): CaseResult[] {
  const parsed = casesSchema.safeParse(parseStrictYaml(casesYaml, MAX_CASES_BYTES));
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as z.core.$ZodIssue;
    const path = issue.path.reduce<string>((at, key) => joinPath(at, typeof key === "number" ? key : String(key)), "");
    throw new PolicyError("POLICY_INVALID", path === "" ? DOCUMENT : path, issue.message);
  }
  return parsed.data.map((c) => {
    const history: Purchase[] = (c.history ?? []).map((h) => ({ at: Date.parse(h.at), total_usd: h.total_usd }));
    const decision = evaluate(policy, c.outbound as Outbound, history, Date.parse(c.now ?? CASE_EPOCH));
    const expected = { send: c.expect.send, blocked: ruleSet(c.expect.blocked ?? []) };
    const actual = ruleSet(decision.blocked.map((b) => b.rule));
    const pass = decision.send === expected.send && actual.join("\n") === expected.blocked.join("\n");
    return { name: c.name, pass, decision, expected };
  });
}
