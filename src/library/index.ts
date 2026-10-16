// The policy library: `intent policy add` applies a published library policy, checked against the library
// index, as meet(current, library), so it can only narrow the gateway. readLock reads what it recorded.
export {
  addPolicy,
  LibraryError,
  LIBRARY_REPO,
  lockOrigin,
  planPolicy,
  type PolicyPlan,
  MAX_GITHUB_BODY_BYTES,
  readLock,
  type AddOptions,
  type LibraryErrorCode,
  type Lock,
} from "./add.ts";
