// supplychain: self-check of the gateway's npm provenance and image signature (plan §3.2). Every result is labelled
// "self-check" because it runs inside the code it checks; each result names the outside checks to run instead.
export { verifyNpm, NPM_REGISTRY, type NpmOptions } from "./npm.ts";
export { verifyImage, IMAGE_REPOSITORY, type ImageOptions } from "./image.ts";
export { GITHUB_OIDC_ISSUER, RELEASE_REPOSITORY, releaseIdentity } from "./attestation.ts";
export {
  formatSelfCheck,
  type Failure,
  type FailureReason,
  type SelfCheckOptions,
  type SelfCheckResult,
} from "./result.ts";
