// The disclosure log in front of Intent Cloud: the only module that reaches src/cloud (invariant 2, log before send).
// The raw adapter is not re-exported, so no caller can hold a cloud that skips the log; connectCloud builds it here.
export {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  type CloudResult,
  DEFAULT_TIMEOUT_MS,
  type HttpCloudOptions,
  type IntentCloud,
} from "../cloud/index.ts";
export {
  connectCloud,
  createDisclosedCloud,
  type DisclosedCloud,
  DisclosureKeysExpiredError,
  DisclosureNoKeysError,
  type DisclosureOptions,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureStoppedError,
} from "./disclosure.ts";
