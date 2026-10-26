// A contract-faithful fake Intent Cloud for tests, the E2E and the local acceptance run: appendix-C signature checks,
// appendix-D receipts on every edge response, appendix-E proofs and the appendix-F statement, signed with the
// published test keys of vectors s1, d1 and e1, plus a software passkey for the confirm page. Only tests and demo
// mode (src/demo) import it; it ships in the package for `intent demo`, and no real host ever pins its root key.
export { type CatalogItem, catalogCategories, DEFAULT_CATALOG, searchCatalog } from "./catalog.ts";
export { SAMPLE_CATALOG } from "./sample-catalog.ts";
export { CONFIRM_ORIGIN, RP_ID } from "./keys.ts";
export { type Action, type AssertOptions, assertionProblem, challengeFor, SoftPasskey, type SoftPasskeyOptions } from "./passkey.ts";
export {
  type ApprovalRecordView,
  type CheckoutControls,
  DEFAULT_COUNTRIES,
  DEFAULT_CURRENCIES,
  DEFAULT_QUOTAS,
  LIVE_CURRENCIES,
  type FakeCloud,
  type FakeCloudOptions,
  MAX_BODY_BYTES,
  type Outcome,
  type ServedVersion,
  statusState,
  SUMS_1_5_0,
  SUMS_1_6_0,
  SUMS_1_6_1,
  SUMS_1_7_0,
  type SnapshotPatch,
  variantRef,
  type Quotas,
  startFakeCloud,
  type Tamper,
} from "./server.ts";
export { freePort } from "./ports.ts";
export { noDnsAgent, type SilentHost, startSilentHost } from "./unreachable.ts";
