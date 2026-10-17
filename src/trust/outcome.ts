// Outcome statements (contract 1.6.0, Appendix G "Outcome statement", as amended M2): Intent Cloud's Ed25519
// signature, by an approval key of a verified key statement, over "intent-outcome-v1\n" || JCS(statement without
// cloud_signature), base64url without padding; and the statement's validity for one approval. Pure; no I/O.
//
// Every refusal names the rule it failed (`refused_by`, the names of vector o2: cloud_signature, snapshot_hash,
// binding_result, required_fields, final_total, mode, order_ref, assurance, source; plus the gateway's own: schema,
// approval_handle, v1_snapshot, unknown_kid, not_verified, statement_expired, o1), and whether Intent Cloud's
// signature held (`signed`): the content rules run only after it did, so a content refusal is a signed claim.
import { verify } from "node:crypto";
import { z } from "zod";
import { type AnySnapshot, ApprovalHandle, Binding, Ed25519Signature, LedgerRef, OutcomeSource, OutcomeState, type SnapshotV2, Timestamp } from "../contract/index.ts";
import { PINNED_HOSTS } from "../config/index.ts";
import { canonicalize } from "../jcs/index.ts";
import { bindingResult, CLOUD_SOURCES, GATEWAY_SOURCES, MODE_STATES, ORDER_REF, REPORT_STATES, REPORTED_ONLY_SOURCES, shipToOptional } from "../outcome/index.ts";
import { fromBase64Url } from "./bytes.ts";
import { type KeySet, type PinnedRootKey, trustedKeys } from "./statement.ts";
import { onlyTestRoot } from "./test-root.ts";

export const OUTCOME_PREFIX = "intent-outcome-v1\n";

export type OutcomeRefusal =
  | "schema"
  | "approval_handle"
  | "v1_snapshot"
  | "snapshot_hash"
  | "not_verified"
  | "statement_expired"
  | "unknown_kid"
  | "cloud_signature"
  | "mode"
  | "source"
  | "assurance"
  | "required_fields"
  | "order_ref"
  | "final_total"
  | "binding_result"
  | "o1";

/** The approval a statement is checked for: its handle, and the snapshot (and hash) the passkey approved. */
export interface OutcomeApproval {
  readonly handle: string;
  readonly snapshot: AnySnapshot;
  readonly snapshotHash: string;
}

/** How a statement is checked beyond the approval: whether a `staging_webhook` source may appear (see stagingSourceAllowed). */
export interface OutcomeCheckOptions {
  readonly stagingSource: boolean;
}

/** The host whose own staging store is the only `staging_webhook` source (Appendix G sources table). */
const STAGING_HOST = "staging-api.intentai.shop";

/**
 * Whether outcomes from `staging_webhook` may be accepted under these pinned root keys: only for Intent Cloud staging
 * (every pinned key is the staging host's pinned root), or for the published test root (the local fake and demo
 * mode). A `staging_webhook` outcome from any other host is refused (`source`): it never appears on a production host.
 */
export function stagingSourceAllowed(pinned: readonly PinnedRootKey[]): boolean {
  if (onlyTestRoot(pinned)) return true;
  const staging = PINNED_HOSTS[STAGING_HOST]?.rootKeys ?? [];
  return pinned.length > 0 && pinned.every((key) => staging.some((s) => s.jwk.x !== undefined && s.jwk.x === key.jwk.x));
}

export type OutcomeStatementResult = { ok: true } | { ok: false; refused_by: OutcomeRefusal; signed: boolean };

// The statement's shape, field by field. Values the content rules judge (order_ref's pattern, final_total's currency
// and amount, the binding result, the reported block's states) are left loose here so each fails its own rule.
const LooseMoney = z.strictObject({ amount_minor: z.int().min(0).max(Number.MAX_SAFE_INTEGER), currency: z.string() });
const Reported = z.strictObject({
  state: z.string(),
  source: z.string(),
  order_ref: z.string().optional(),
  final_total: LooseMoney.optional(),
  binding: Binding.optional(),
});
const StatedOutcome = z.strictObject({
  state: OutcomeState,
  source: OutcomeSource,
  assurance: z.enum(["verified", "reported"]),
  order_ref: z.string().optional(),
  final_total: LooseMoney.optional(),
  binding: Binding.optional(),
  observed_at: Timestamp,
  reported: Reported.optional(),
});
const Statement = z.strictObject({
  v: z.literal(1),
  approval_handle: ApprovalHandle,
  snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: StatedOutcome,
  ledger: LedgerRef,
  issued_at: Timestamp,
  kid: z.string().regex(/^cloud-approval-[0-9]{6}$/),
  cloud_signature: Ed25519Signature,
});
type StatedOutcome = z.infer<typeof StatedOutcome>;
/** Read by a constant key: src/ lint forbids naming a property `binding` (it would also match `process.binding`). */
const BINDING = "binding";

/**
 * Whether `statement` is a valid outcome statement for `approval` at `now`, under the approval keys of `keySet`
 * (Appendix G statement validity, steps 1 to 3). A v1 snapshot never has a valid statement.
 */
export function verifyOutcomeStatement(
  statement: unknown,
  approval: OutcomeApproval,
  keySet: KeySet,
  now: Date,
  options: OutcomeCheckOptions,
): OutcomeStatementResult {
  const parsed = Statement.safeParse(statement);
  if (!parsed.success) return refuse("schema");
  const st = parsed.data;
  const { cloud_signature, ...unsigned } = st;
  let unsignedJcs: string;
  try {
    unsignedJcs = canonicalize(unsigned);
  } catch {
    return refuse("schema");
  }
  if (st.approval_handle !== approval.handle || approval.snapshot.approval !== approval.handle) return refuse("approval_handle");
  if (approval.snapshot.v !== 2) return refuse("v1_snapshot");
  if (st.snapshot_hash !== approval.snapshotHash) return refuse("snapshot_hash");

  const keys = trustedKeys(keySet, now);
  if (keys === "not_verified") return refuse("not_verified");
  if (keys === "expired") return refuse("statement_expired");
  const key = keys.approval.get(st.kid);
  if (key === undefined) return refuse("unknown_kid");
  const sig = fromBase64Url(cloud_signature);
  if (sig === null || !verify(null, Buffer.from(OUTCOME_PREFIX + unsignedJcs, "utf8"), key, sig)) return refuse("cloud_signature");

  const problem = contentProblem(st.outcome, approval.snapshot, options);
  return problem === null ? { ok: true } : { ok: false, refused_by: problem, signed: true };
}

/** Step 3 of statement validity, plus O1, for a statement whose signature held. */
function contentProblem(o: StatedOutcome, s: SnapshotV2, options: OutcomeCheckOptions): OutcomeRefusal | null {
  if (!MODE_STATES[s.completion_mode].has(o.state)) return "mode";
  if (!CLOUD_SOURCES.has(o.source)) return "source";
  if (o.source === "staging_webhook" && !options.stagingSource) return "source";
  if (REPORTED_ONLY_SOURCES.has(o.source) && o.assurance !== "reported") return "assurance";
  if (o.state === "reported" && o.assurance !== "reported") return "assurance";
  const binding = o[BINDING];
  const isOrder = o.state === "ordered" || o.state === "mismatch";
  if (isOrder && (o.order_ref === undefined || o.final_total === undefined || binding === undefined)) return "required_fields";
  if ((o.reported !== undefined) !== (o.source === "gateway_report")) return "required_fields";
  if (o.reported !== undefined && (!REPORT_STATES.has(o.reported.state) || !GATEWAY_SOURCES.has(o.reported.source as never))) return "required_fields";
  if (o.order_ref !== undefined && !ORDER_REF.test(o.order_ref)) return "order_ref";
  if (o.reported?.order_ref !== undefined && !ORDER_REF.test(o.reported.order_ref)) return "order_ref";
  if (o.final_total !== undefined && o.final_total.currency !== "USD") return "final_total";
  if (o.state === "ordered" && o.final_total !== undefined && o.final_total.amount_minor > s.total.amount_minor) return "final_total";
  if (binding !== undefined && binding.result !== bindingResult(binding.checks, shipToOptional(o.source))) return "binding_result";
  const reportedBinding = o.reported?.[BINDING];
  if (o.reported !== undefined && reportedBinding !== undefined && reportedBinding.result !== bindingResult(reportedBinding.checks, shipToOptional(o.reported.source))) {
    return "binding_result";
  }
  if (o.state === "ordered" && (o.assurance !== "verified" || binding?.result !== "ok")) return "o1";
  return null;
}

function refuse(refused_by: OutcomeRefusal): OutcomeStatementResult {
  return { ok: false, refused_by, signed: false };
}
