// Verifies what Intent Cloud signs: the root-signed key statement (Appendix F), receipts (Appendix D) and approval
// proofs (Appendix E), and decides whether an approving passkey is the pinned one (ADR-0011). Pure; no I/O.
//
// Use: verifyStatement → KeySet; verifyReceipt and verifyApprovalProof take that KeySet and `now`, and refuse a
// KeySet that verifyStatement did not make or that has expired. checkApprover takes the credential of a verified
// proof only. Every refusal names the appendix step it failed (`step`, null for the gateway's own rules) and why.
//
// Chain bodies the caller writes, so the others can rely on them:
// - approval_pending: `{handle, approval_url, snapshot_hash}`; verifyApprovalProof reads `handle` and `snapshot_hash`.
// - approval: `{handle, …}`; a handle with an approval entry is a replay.
// - approver_pin, approver_flag: the `entry.body` checkApprover returns, `{fingerprint, credential_id, credential_public_key}`.
export { approvalChallenge, type ApprovalFailure, type ApprovalResult, type ChainEntry, verifyApprovalProof, type VerifiedApproval, type VerifiedCredential } from "./approval.ts";
export { type ApproverBody, type ApproverCheck, checkApprover } from "./approver.ts";
export { approverFingerprint } from "./fingerprint.ts";
export { type ReceiptFailure, type ReceiptResponse, type ReceiptResult, type SentRequest, verifyReceipt } from "./receipt.ts";
export { type KeySet, MAX_CLOCK_SKEW_MS, type PinnedRootKey, type StatementFailure, type StatementResult, verifyStatement } from "./statement.ts";
