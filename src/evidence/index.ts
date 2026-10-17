// evidence: the evidence pack (plan G9, ADR-0018), one purchase's slice of the local hash chain that anyone can check
// offline with `intent verify --evidence`. Building and reading the pack, and the rule that says which entries belong
// to a purchase, live here; `src/verify` re-runs the checks on it. Pure; no I/O.
export {
  buildEvidence,
  EVIDENCE_FORMAT,
  EVIDENCE_VERSION,
  EvidenceError,
  EvidencePack,
  packText,
  readPack,
  skeletonProblems,
} from "./pack.ts";
export { type Membership, purchaseEntries, type Role } from "./select.ts";
