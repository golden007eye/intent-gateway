// verify: `intent verify` (plan §3.2). Re-checks the local chain offline against the pinned root key (links, key
// statements, one follow-up per disclosure with its receipt re-verified, approvals re-verified from their chained
// proofs), then runs the supply-chain self-check, and reports the head seq and hash (ADR-0006, ADR-0007, ADR-0010).
//
// Chain bodies verify reads (written by disclosure and the gateway):
// - keys: `{statement}`, the key statement as Intent Cloud served it. Receipts before the first keys entry (the
//   key-bootstrap reads) are checked against the first one; every later receipt against the latest one before it.
// - disclosure: `body_b64` and `content_digest`, which must match, and `method`, `path`, `keyid`, `nonce`, `created`
//   (null when unsigned), which the receipt must match.
// - receipt: `{disclosure_seq, status, receipt_header, receipt_signature, …}`; re-verified whatever its `verified`.
// - unacknowledged, discarded: `{disclosure_seq, reason}`.
// - approval: `{handle, proof}`; `proof` is the `proof` member of the approval status that verified. The
//   `approver_pin` for its passkey, when one is written, comes before it; a flagged approval has no approval entry.
export { formatReport } from "./report.ts";
export { type Check, type Install, type Report, runVerify, type VerifyOptions } from "./verify.ts";
