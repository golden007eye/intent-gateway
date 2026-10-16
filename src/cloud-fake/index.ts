// A contract-faithful fake Intent Cloud for tests, the E2E and the local acceptance run: appendix-C signature checks,
// appendix-D receipts on every edge response, appendix-E proofs and the appendix-F statement, signed with the
// published test keys of vectors s1, d1 and e1, plus a software passkey for the confirm page. Only tests import it.
export { type CatalogItem, DEFAULT_CATALOG } from "./catalog.ts";
export { CONFIRM_ORIGIN, RP_ID } from "./keys.ts";
export { type Action, type AssertOptions, assertionProblem, challengeFor, SoftPasskey, type SoftPasskeyOptions } from "./passkey.ts";
export {
  type ApprovalRecordView,
  DEFAULT_QUOTAS,
  type FakeCloud,
  type FakeCloudOptions,
  MAX_BODY_BYTES,
  type Outcome,
  type Quotas,
  startFakeCloud,
  type Tamper,
} from "./server.ts";
