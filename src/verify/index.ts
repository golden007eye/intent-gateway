// verify: `intent verify` (plan §3.2). Re-checks the local chain offline against the pinned root key (links, key
// statements, at most one follow-up per disclosure with its receipt re-verified (none is reported as no answer
// recorded, not failed), approvals re-verified from their chained proofs), then runs the supply-chain self-check, and reports the head seq and hash (ADR-0006, ADR-0007, ADR-0010).
//
// Chain bodies verify reads (written by disclosure and the gateway):
// - keys: `{statement}`, the key statement as Intent Cloud served it. Receipts before the first keys entry (the
//   key-bootstrap reads) are checked against the first one; every later receipt against the latest one before it.
// - disclosure: `body_b64` and `content_digest`, which must match, and `method`, `path`, `keyid`, `nonce`, `created`
//   (null when unsigned), which the receipt must match.
// - receipt: `{disclosure_seq, status, receipt_header, receipt_signature, …}`; re-verified whatever its `verified`.
// - unacknowledged, discarded: `{disclosure_seq, reason}`.
// - observed: an observation (src/observation's ObservedBody): its shape, no buyer identity, and `disclosure_seq` naming
//   an earlier disclosure of the same endpoint whose verified 2xx receipt came first; at most one per disclosure. It
//   is never a follow-up. block: `held`, when present, holds no buyer identity.
// - approval: `{handle, proof}`; `proof` is the `proof` member of the approval status that verified. The
//   `approver_pin` for its passkey, when one is written, comes before it; a flagged approval has no approval entry.
export { formatReport } from "./report.ts";
export { type Check, type Install, type Report, runVerify, type VerifyOptions } from "./verify.ts";
