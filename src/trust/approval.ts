// Approval proofs (Appendix E) and invariant 4: a purchase proceeds only with a passkey-signed Approval that the
// gateway has verified itself. Intent Cloud's signature is checked, and then the passkey assertion is re-verified
// against the statement's confirm origin and rp_id, so neither Intent Cloud nor the agent alone can approve.
import { constants, createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { AnyApprovalProof, type AnySnapshot, ApprovalState, BindableApprovalProof, type CredentialPublicKey, type LedgerRef } from "../contract/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { approverFingerprint } from "./fingerprint.ts";
import { fromBase64Url, utf8 } from "./bytes.ts";
import { readSent, readSentCheckout, type SentCheckoutReason, sentCheckoutProblems, type SentReason, sentProblems } from "./sent.ts";
import { type KeySet, trustedKeys } from "./statement.ts";

/** A chain entry as the store returns it; trust reads only `kind` and `body`. */
export interface ChainEntry {
  readonly kind: string;
  readonly body: unknown;
}

/** A passkey credential taken from a proof that passed every check. Only `verifyApprovalProof` makes one. */
export interface VerifiedCredential {
  /** `assertion.credential_id`, base64url. */
  readonly id: string;
  readonly publicKey: CredentialPublicKey;
  /** `approverFingerprint(publicKey)`. */
  readonly fingerprint: string;
  /** The authenticator's signature counter: authenticatorData bytes 33–36, big-endian. 0 means it does not count. */
  readonly signCount: number;
  /** The approval this credential signed, so checkApprover can tell its own pin from an earlier one. */
  readonly handle: string;
}

export interface VerifiedApproval {
  ok: true;
  handle: string;
  snapshot: AnySnapshot;
  snapshotHash: string;
  ledger: LedgerRef;
  issuedAt: string;
  credential: VerifiedCredential;
}

/** step is the Appendix E verification step that failed, or null for the gateway's own rules (state, pending, replay). */
export type ApprovalFailure =
  | { ok: false; step: null; reason: "bad_pending_entry" | "bad_state" | "not_approved" | "missing_proof" | "proof_in_wrong_state" | "replay" }
  | { ok: false; step: 1; reason: "schema" | "handle_mismatch" }
  | { ok: false; step: 2; reason: "not_verified" | "statement_expired" | "unknown_kid" | "bad_signature" }
  | { ok: false; step: 3; reason: "snapshot_hash_mismatch" | "not_pending_snapshot" }
  | { ok: false; step: 4; reason: "bad_client_data" | "wrong_type" | "wrong_challenge" | "wrong_origin" | "cross_origin" }
  | { ok: false; step: 5; reason: "bad_authenticator_data" | "wrong_rp_id" | "user_not_present" | "user_not_verified" }
  | { ok: false; step: 6; reason: "bad_credential_key" | "bad_assertion_signature" }
  | { ok: false; step: 7; reason: SentReason | SentCheckoutReason | "bad_sent" };

export type ApprovalResult = VerifiedApproval | ApprovalFailure;

/** The approval states in which `GET /v1/approvals/{h}` carries a proof, and only these (Appendix E). */
const PROOF_STATES: ReadonlySet<string> = new Set(["approved", "handed_off", "ordered"]);
const SIGNING_PREFIX = "intent-approval-v1\n";
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const verifiedCredentials = new WeakSet<VerifiedCredential>();

/** `challenge(action)` of Appendix A: base64url(SHA-256(JCS({action, snapshot_hash}))). */
export function approvalChallenge(action: "approve" | "reject", snapshotHash: string): string {
  return Buffer.from(sha256Hex(canonicalize({ action, snapshot_hash: snapshotHash })), "hex").toString("base64url");
}

/**
 * Verifies the approval status Intent Cloud returned for the approval in `pendingEntry` (the chained
 * `approval_pending` entry, body `{handle, snapshot_hash, …}`), at time `now`. `chain` is the local chain read
 * before this check: a handle that already has an `approval` entry is a replay and is refused.
 */
export function verifyApprovalProof(
  status: unknown,
  pendingEntry: ChainEntry,
  keySet: KeySet,
  chain: readonly ChainEntry[],
  now: Date,
): ApprovalResult {
  const pending = readPending(pendingEntry);
  if (pending === null) return fail(null, "bad_pending_entry");
  if (typeof status !== "object" || status === null) return fail(null, "bad_state");
  const { state, proof: rawProof } = status as { state?: unknown; proof?: unknown };
  const parsedState = ApprovalState.safeParse(state);
  if (!parsedState.success) return fail(null, "bad_state");
  if (!PROOF_STATES.has(parsedState.data)) return fail(null, rawProof === undefined ? "not_approved" : "proof_in_wrong_state");
  if (rawProof === undefined) return fail(null, "missing_proof");

  // Step 1: the schema, and the approval the gateway asked about.
  // An approval chained with step 7's `sent` (1.6.0 and later) needs a v2 or v3 proof, and step 7 then holds it to the
  // version `sent` names (v3 for 1.6.1); one chained by a 1.5.0 gateway (no `sent`) keeps its released 1.5.0 form, so
  // `intent verify` still checks those chains.
  const parsed = (pending.sent === undefined ? AnyApprovalProof : BindableApprovalProof).safeParse(rawProof);
  if (!parsed.success) return fail(1, "schema");
  const proof = parsed.data;
  // A lone surrogate passes the schema but has no canonical form; such a proof cannot have been signed.
  if (jcsOrNull(proof) === null) return fail(1, "schema");
  if (proof.approval_handle !== pending.handle || proof.snapshot.approval !== pending.handle) return fail(1, "handle_mismatch");
  if (chain.some((e) => e.kind === "approval" && bodyHandle(e.body) === pending.handle)) return fail(null, "replay");

  // Step 2: Intent Cloud's signature, by an approval key of a valid, unexpired statement.
  const keys = trustedKeys(keySet, now);
  if (keys === "not_verified") return fail(2, "not_verified");
  if (keys === "expired") return fail(2, "statement_expired");
  const cloudKey = keys.approval.get(proof.kid);
  if (cloudKey === undefined) return fail(2, "unknown_kid");
  const { cloud_signature, ...unsigned } = proof;
  const cloudSig = fromBase64Url(cloud_signature);
  if (cloudSig === null || !verify(null, Buffer.from(SIGNING_PREFIX + canonicalize(unsigned), "utf8"), cloudKey, cloudSig)) {
    return fail(2, "bad_signature");
  }

  // Step 3: the snapshot hashes to snapshot_hash, which is the hash the gateway chained when it asked for approval.
  if (sha256Hex(canonicalize(proof.snapshot)) !== proof.snapshot_hash) return fail(3, "snapshot_hash_mismatch");
  if (proof.snapshot_hash !== pending.snapshotHash) return fail(3, "not_pending_snapshot");
  // issued_at is deliberately not compared with snapshot.expires_at. Appendix E defines issued_at as when Intent
  // Cloud made the proof, and Intent Cloud makes one at each read, so a status read after the approval window
  // carries a later issued_at for an approval given inside it. The proof carries no approval time to compare.

  // Step 4: clientDataJSON says this is a get() on the confirm origin over the approve challenge.
  const clientDataBytes = fromBase64Url(proof.assertion.client_data_json);
  const clientData = clientDataBytes === null ? null : jsonObject(clientDataBytes);
  if (clientDataBytes === null || clientData === null) return fail(4, "bad_client_data");
  if (clientData.type !== "webauthn.get") return fail(4, "wrong_type");
  if (clientData.challenge !== approvalChallenge("approve", proof.snapshot_hash)) return fail(4, "wrong_challenge");
  if (clientData.origin !== keys.confirmOrigin) return fail(4, "wrong_origin");
  if (clientData.crossOrigin !== undefined && clientData.crossOrigin !== false) return fail(4, "cross_origin");

  // Step 5: authenticatorData is for the statement's rp_id, with the user present and verified.
  const authData = fromBase64Url(proof.assertion.authenticator_data);
  if (authData === null || authData.length < 37) return fail(5, "bad_authenticator_data");
  if (!authData.subarray(0, 32).equals(createHash("sha256").update(keys.rpId, "utf8").digest())) return fail(5, "wrong_rp_id");
  const flags = authData[32] ?? 0;
  if ((flags & FLAG_USER_PRESENT) === 0) return fail(5, "user_not_present");
  if ((flags & FLAG_USER_VERIFIED) === 0) return fail(5, "user_not_verified");

  // Step 6: the passkey signed authenticatorData || SHA-256(clientDataJSON).
  const passkey = credentialKey(proof.credential_public_key);
  if (passkey === null) return fail(6, "bad_credential_key");
  const assertionSig = fromBase64Url(proof.assertion.signature);
  const signed = Buffer.concat([authData, createHash("sha256").update(clientDataBytes).digest()]);
  if (assertionSig === null || !verifyAssertion(proof.credential_public_key, passkey, signed, assertionSig)) {
    return fail(6, "bad_assertion_signature");
  }

  // Step 7 (contract 1.6.1): a pending entry the gateway chained with `sent` (every 1.6.x cart) is matched fact by
  // fact against the signed snapshot, its version included (v3 for 1.6.1). Entries from before 1.6.0 have none.
  // A submitted Shop checkout (1.7.0) is chained with its CheckoutRequest, and takes only a v4 snapshot that is it.
  if (pending.sent !== undefined) {
    const checkout = readSentCheckout(pending.sent);
    if (checkout !== null) {
      const reason = sentCheckoutProblems(proof.snapshot, checkout)[0];
      if (reason !== undefined) return fail(7, reason);
    } else {
      const sent = readSent(pending.sent);
      if (sent === null) return fail(7, "bad_sent");
      const reason = sentProblems(proof.snapshot, sent)[0];
      if (reason !== undefined) return fail(7, reason);
    }
  }

  const credential: VerifiedCredential = Object.freeze({
    id: proof.assertion.credential_id,
    publicKey: Object.freeze({ ...proof.credential_public_key }),
    fingerprint: approverFingerprint(proof.credential_public_key),
    signCount: authData.readUInt32BE(33),
    handle: proof.approval_handle,
  });
  verifiedCredentials.add(credential);
  return {
    ok: true,
    handle: proof.approval_handle,
    snapshot: proof.snapshot,
    snapshotHash: proof.snapshot_hash,
    ledger: proof.ledger,
    issuedAt: proof.issued_at,
    credential,
  };
}

/** True only for a credential `verifyApprovalProof` returned. */
export function isVerifiedCredential(credential: VerifiedCredential): boolean {
  return verifiedCredentials.has(credential);
}

function jcsOrNull(value: unknown): string | null {
  try {
    return canonicalize(value);
  } catch {
    return null;
  }
}

function readPending(entry: ChainEntry): { handle: string; snapshotHash: string; sent?: unknown } | null {
  if (entry.kind !== "approval_pending" || typeof entry.body !== "object" || entry.body === null) return null;
  const { handle, snapshot_hash, sent } = entry.body as { handle?: unknown; snapshot_hash?: unknown; sent?: unknown };
  if (typeof handle !== "string" || typeof snapshot_hash !== "string" || !/^[0-9a-f]{64}$/.test(snapshot_hash)) return null;
  return { handle, snapshotHash: snapshot_hash, ...(sent === undefined ? {} : { sent }) };
}

function bodyHandle(body: unknown): unknown {
  return typeof body === "object" && body !== null ? (body as { handle?: unknown }).handle : undefined;
}

function jsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  const text = utf8(bytes);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The passkey's public key, from the two JWK forms Appendix E allows and no other. An RSA key must have the public
 * exponent 65537 (`AQAB`, the only one WebAuthn authenticators use; e = 1 would make any signature verify) and a
 * modulus of at least 2048 bits.
 */
function credentialKey(jwk: CredentialPublicKey): KeyObject | null {
  try {
    if (jwk.kty === "EC") {
      const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
      return key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
    }
    if (jwk.e !== "AQAB") return null;
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    return (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? key : null;
  } catch {
    return null;
  }
}

function verifyAssertion(jwk: CredentialPublicKey, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    if (jwk.alg === "ES256") return verify("sha256", data, { key, dsaEncoding: "der" }, signature);
    return verify("sha256", data, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
  } catch {
    return false;
  }
}

function fail<S extends ApprovalFailure["step"]>(step: S, reason: Extract<ApprovalFailure, { step: S }>["reason"]): ApprovalFailure {
  return { ok: false, step, reason } as ApprovalFailure;
}
