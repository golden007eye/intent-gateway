// The approver pin (ADR-0011): trust the first passkey that approves, and flag any other one. The pinned passkey's
// signature counter is tracked as WebAuthn §7.2 step 21 describes, so a cloned passkey is flagged too.
import type { CredentialPublicKey } from "../contract/index.ts";
import { type ChainEntry, isVerifiedCredential, type VerifiedCredential } from "./approval.ts";

/**
 * The body of an `approver_pin` or `approver_flag` entry. The panel reads `fingerprint`. `sign_count` and `handle`
 * (the approval the passkey signed) are absent in entries written before they were recorded, and in pins that
 * `intent approver accept` writes; absent means the counter is unknown.
 */
export interface ApproverBody {
  fingerprint: string;
  credential_id: string;
  credential_public_key: CredentialPublicKey;
  sign_count?: number;
  handle?: string;
}

/** Why a credential is flagged: another passkey than the pin, or the pin with a counter that did not go up. */
export type FlagReason = "other_passkey" | "sign_count";

export type ApproverCheck =
  | { decision: "pin"; fingerprint: string; entry: { kind: "approver_pin"; body: ApproverBody } }
  | { decision: "match"; fingerprint: string; entry: null }
  | { decision: "flag"; reason: FlagReason; fingerprint: string; entry: { kind: "approver_flag"; body: ApproverBody & { reason: FlagReason } } };

/**
 * Compares a verified credential with the current pin: the last `approver_pin` entry in `chain` (the first
 * verified Approval wrote one, and `intent approver accept` writes a later one). No pin yet → `pin`; the same key →
 * `match`; another key → `flag`, and the purchase is not reported as approved. A pin whose body has no fingerprint
 * string is never matched or replaced: every credential is flagged until a person accepts one at a terminal.
 *
 * The same key is also flagged when its signature counter did not go up: the last seen counter is the highest
 * `sign_count` of the pin and of the `approval` entries after it, other than this approval's own. Following
 * WebAuthn, when the new and last seen counters are both 0 the authenticator does not count and nothing is
 * flagged; otherwise the new counter must be greater. An unknown last seen counter flags nothing.
 * `entry` is what the caller appends to the chain, or null when nothing is written.
 */
export function checkApprover(credential: VerifiedCredential, chain: readonly ChainEntry[]): ApproverCheck {
  // Only a credential from a proof that passed every check may become the pin.
  if (!isVerifiedCredential(credential)) throw new TypeError("checkApprover: credential was not returned by verifyApprovalProof");
  const { fingerprint, signCount, handle } = credential;
  const body: ApproverBody = {
    fingerprint,
    credential_id: credential.id,
    credential_public_key: { ...credential.publicKey },
    sign_count: signCount,
    handle,
  };
  const pinIndex = chain.findLastIndex((e) => e.kind === "approver_pin");
  const pin = chain[pinIndex];
  if (pin === undefined) return { decision: "pin", fingerprint, entry: { kind: "approver_pin", body } };
  if (field(pin.body, "fingerprint") !== fingerprint) return flag("other_passkey", body);
  const lastSeen = lastSignCount(chain.slice(pinIndex), handle);
  if (lastSeen !== null && (signCount !== 0 || lastSeen !== 0) && signCount <= lastSeen) return flag("sign_count", body);
  return { decision: "match", fingerprint, entry: null };
}

function flag(reason: FlagReason, body: ApproverBody): ApproverCheck {
  return { decision: "flag", reason, fingerprint: body.fingerprint, entry: { kind: "approver_flag", body: { ...body, reason } } };
}

/** The highest counter recorded by the pin (first in `entries`) and the approvals after it, not counting `handle`'s own. */
function lastSignCount(entries: readonly ChainEntry[], handle: string): number | null {
  let last: number | null = null;
  for (const e of entries) {
    if (e.kind !== "approver_pin" && e.kind !== "approval") continue;
    const count = field(e.body, "sign_count");
    if (field(e.body, "handle") === handle || !Number.isSafeInteger(count) || (count as number) < 0) continue;
    last = Math.max(last ?? 0, count as number);
  }
  return last;
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}
