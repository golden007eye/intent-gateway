// verify: `intent verify` (plan §3.2). Re-checks the local chain offline against the pinned root key (links, key
// statements, one follow-up per disclosure with its receipt re-verified, approvals re-verified from their chained
// proofs), then runs the supply-chain self-check, and reports the head seq and hash (ADR-0006, ADR-0007, ADR-0010).
//
// Chain bodies verify reads, which the writing modules must use (the panel's keys plus these):
// - keys: `{statement}`, the key statement as Intent Cloud served it.
// - disclosure: `{endpoint, fields, blocked, request}`; `request` is what was signed and sent, in the receipt's own
//   field names: `{method, path, content_digest, keyid?, nonce?, created?}`.
// - receipt: `{disclosure_seq, reason, response}`; `response` is `{status, receipt, signature}`: the HTTP status and
//   the raw `Intent-Receipt` and `Intent-Receipt-Signature` header values.
// - unacknowledged, discarded: `{disclosure_seq, reason}`.
// - approval: `{handle, proof}`; `proof` is the `proof` member of the approval status that verified. The
//   `approver_pin` for its passkey, when one is written, comes before it; a flagged approval has no approval entry.
export { formatReport } from "./report.ts";
export { type Check, type Install, type Report, runVerify, type VerifyOptions } from "./verify.ts";
