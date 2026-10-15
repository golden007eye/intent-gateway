// The policy library: `intent policy add` applies a published library policy, checked against the library
// index, as meet(current, library), so it can only narrow the gateway.
export { addPolicy, LibraryError, LIBRARY_REPO, type AddOptions, type LibraryErrorCode, type Lock } from "./add.ts";
