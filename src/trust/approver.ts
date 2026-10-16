// The approver pin (ADR-0011): trust the first passkey that approves, and flag any other one.
import type { CredentialPublicKey } from "../contract/index.ts";
import { type ChainEntry, isVerifiedCredential, type VerifiedCredential } from "./approval.ts";

/** The body of an `approver_pin` or `approver_flag` entry. The panel reads `fingerprint`. */
export interface ApproverBody {
  fingerprint: string;
  credential_id: string;
  credential_public_key: CredentialPublicKey;
}

export type ApproverCheck =
  | { decision: "pin"; fingerprint: string; entry: { kind: "approver_pin"; body: ApproverBody } }
  | { decision: "match"; fingerprint: string; entry: null }
  | { decision: "flag"; fingerprint: string; entry: { kind: "approver_flag"; body: ApproverBody } };

/**
 * Compares a verified credential with the current pin: the last `approver_pin` entry in `chain` (the first
 * verified Approval wrote one, and `intent approver accept` writes a later one). No pin yet → `pin`; the same key →
 * `match`; another key → `flag`, and the purchase is not reported as approved. A pin whose body has no fingerprint
 * string is never matched or replaced: every credential is flagged until a person accepts one at a terminal.
 * `entry` is what the caller appends to the chain, or null when nothing is written.
 */
export function checkApprover(credential: VerifiedCredential, chain: readonly ChainEntry[]): ApproverCheck {
  // Only a credential from a proof that passed every check may become the pin.
  if (!isVerifiedCredential(credential)) throw new TypeError("checkApprover: credential was not returned by verifyApprovalProof");
  const { fingerprint } = credential;
  const body: ApproverBody = { fingerprint, credential_id: credential.id, credential_public_key: { ...credential.publicKey } };
  const pin = chain.findLast((e) => e.kind === "approver_pin");
  if (pin === undefined) return { decision: "pin", fingerprint, entry: { kind: "approver_pin", body } };
  if (pinnedFingerprint(pin.body) === fingerprint) return { decision: "match", fingerprint, entry: null };
  return { decision: "flag", fingerprint, entry: { kind: "approver_flag", body } };
}

function pinnedFingerprint(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { fingerprint } = body as { fingerprint?: unknown };
  return typeof fingerprint === "string" ? fingerprint : null;
}
