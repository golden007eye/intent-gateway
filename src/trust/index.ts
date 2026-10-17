// Verifies what Intent Cloud signs: the root-signed key statement (Appendix F), receipts (Appendix D) and approval
// proofs (Appendix E) and outcome statements (Appendix G), and decides whether an approving passkey is the pinned one (ADR-0011). Pure; no I/O.
//
// Use: verifyStatement → KeySet; verifyReceipt and verifyApprovalProof take that KeySet and `now`, and refuse a
// KeySet that verifyStatement did not make or that has expired. checkApprover takes the credential of a verified
// proof only. Every refusal names the appendix step it failed (`step`, null for the gateway's own rules) and why.
//
// Chain bodies the caller writes, so the others can rely on them:
// - approval_pending: `{handle, approval_url, snapshot_hash, sent?}`; verifyApprovalProof reads `handle`,
//   `snapshot_hash` and, from contract 1.6.0, `sent` (SentPurchase), which Appendix E step 7 matches the snapshot to.
// - approval: `{handle, sign_count, …}`; a handle with an approval entry is a replay. `sign_count` is the verified
//   credential's `signCount`; checkApprover compares the next approval's counter with it (absent = unknown).
// - approver_pin, approver_flag: the `entry.body` checkApprover returns, `{fingerprint, credential_id,
//   credential_public_key, sign_count, handle}`, plus `reason` on a flag.
export { approvalChallenge, type ApprovalFailure, type ApprovalResult, type ChainEntry, verifyApprovalProof, type VerifiedApproval, type VerifiedCredential } from "./approval.ts";
export { type ApproverBody, type ApproverCheck, checkApprover, type FlagReason } from "./approver.ts";
export { approverFingerprint } from "./fingerprint.ts";
export { OUTCOME_PREFIX, type OutcomeApproval, type OutcomeRefusal, type OutcomeStatementResult, verifyOutcomeStatement } from "./outcome.ts";
export { type ReceiptFailure, type ReceiptResponse, type ReceiptResult, type SentRequest, verifyReceipt } from "./receipt.ts";
export { instant, readSent, SENT_FIELDS, SENT_WORDS, SentPurchase, type SentReason, sentProblems } from "./sent.ts";
export { isTestRoot, onlyTestRoot, TEST_ROOT_KEY, TEST_ROOT_X } from "./test-root.ts";
export { type KeySet, MAX_CLOCK_SKEW_MS, type PinnedRootKey, type StatementFailure, type StatementResult, verifyStatement } from "./statement.ts";
