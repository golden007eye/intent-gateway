// The `outcome` chain entry (ADR-0015): what the gateway concluded about a purchase after its approval, and from
// what. Two bases:
// - `cloud`: Intent Cloud stated an outcome. The entry holds Intent Cloud's words ({state, source, assurance}),
//   whether its statement verified, the statement itself as canonical JSON (so `intent verify` re-checks it offline),
//   the gateway's own binding re-run and the state it showed. Written once per distinct outcome and shown state.
// - `local`: the gateway's own verdict from evidence it holds (its precheck refusal, or Shop's checkout read over
//   TLS): written by the one-tap completion (plan G7b). Its binding inputs never hold a raw checkout id, only its hash.
// Only a `local` outcome can free spend-cap room, never a `cloud` one (contract §6). Pure.
import { z } from "zod";
import { Binding, OutcomeSource, OutcomeState } from "../contract/index.ts";

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Minor = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const CloudOutcomeEntry = z.strictObject({
  handle: z.string().min(1).max(80),
  basis: z.literal("cloud"),
  /** sha256 of JCS(outcome) as the status served it (the statement's `outcome` when the status had none). */
  outcome_hash: Hex64,
  /** Intent Cloud's words, as served; null when no outcome could be read at all. */
  cloud: z.strictObject({ state: OutcomeState, source: OutcomeSource, assurance: z.enum(["verified", "reported"]) }).nullable(),
  statement_verified: z.boolean(),
  /**
   * The rule the statement failed: Appendix G statement validity, or the gateway's own (m1; schema; identity, when the
   * statement held what looks like buyer identity and so was not kept).
   */
  refused_by: z.string().min(1).max(40).optional(),
  /** The outcome statement, canonical JSON; absent when none came, or when it held what looks like buyer identity. */
  statement_jcs: z.string().min(1).max(16_384).optional(),
  local_binding: Binding.optional(),
  /** What the gateway showed: never more than the verified statement (O1, invariant 5); null when nothing was acted on. */
  state_shown: OutcomeState.nullable(),
  /** The order Intent Cloud's statement names, only when something was shown. */
  order_ref: z.string().min(1).max(64).optional(),
  final_total_minor: Minor.optional(),
});
export type CloudOutcomeEntry = z.infer<typeof CloudOutcomeEntry>;

export const LocalOutcomeEntry = z.strictObject({
  handle: z.string().min(1).max(80),
  basis: z.literal("local"),
  state: OutcomeState,
  source: z.enum(["shop_api", "gateway_precheck"]),
  /** Why, for a `failed` (`precheck:total`, `not_sent`, `budget`, …). */
  reason: z.string().min(1).max(80).optional(),
  order_ref: z.string().min(1).max(64).optional(),
  final_total_minor: Minor.optional(),
  /** The observed order and context the binding ran on, as the chain may hold them (checkout ref as its hash). */
  binding_inputs: z.strictObject({ observed: z.record(z.string(), z.unknown()), context: z.record(z.string(), z.unknown()) }).optional(),
  local_binding: Binding.optional(),
  state_shown: OutcomeState,
});
export type LocalOutcomeEntry = z.infer<typeof LocalOutcomeEntry>;

export const OutcomeEntry = z.discriminatedUnion("basis", [CloudOutcomeEntry, LocalOutcomeEntry]);
export type OutcomeEntry = z.infer<typeof OutcomeEntry>;

/** A chain entry as the store returns it; this module reads only `kind` and `body`. */
export interface OutcomeChainEntry {
  readonly kind: string;
  readonly body: unknown;
}

/** The `outcome` entries for one approval, in chain order, that parse. */
export function outcomesFor(entries: readonly OutcomeChainEntry[], handle: string): OutcomeEntry[] {
  const found: OutcomeEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "outcome") continue;
    const parsed = OutcomeEntry.safeParse(e.body);
    if (parsed.success && parsed.data.handle === handle) found.push(parsed.data);
  }
  return found;
}

/**
 * Whether the gateway holds local evidence that an approved purchase charged nothing, so its reservation may be freed
 * (contract §6): its latest `local` outcome is `failed`, read from Shop (`shop_api`: the checkout is terminal and not
 * completed), or its own precheck refusal (`gateway_precheck`) while no `complete_checkout` disclosure at all was
 * logged after the purchase's approval (log-before-send proves nothing was sent). The precheck branch fails closed: it
 * does not rely on a disclosure naming its purchase, so any such send after the approval keeps the room. A `cloud`
 * outcome never frees room: a compromised Intent Cloud must not widen spending.
 */
export function chargedNothing(entries: readonly OutcomeChainEntry[], handle: string): boolean {
  const local = outcomesFor(entries, handle).filter((o): o is LocalOutcomeEntry => o.basis === "local").at(-1);
  if (local?.state !== "failed") return false;
  if (local.source === "shop_api") return true;
  const approvedAt = entries.findIndex((e) => e.kind === "approval" && (e.body as { handle?: unknown } | null)?.handle === handle);
  return !entries.some((e, i) => {
    if (i < approvedAt || e.kind !== "disclosure" || typeof e.body !== "object" || e.body === null) return false;
    return (e.body as { endpoint?: unknown }).endpoint === "complete_checkout";
  });
}
