// The disclosure log in front of Intent Cloud: the only module that reaches src/cloud (invariant 2, log before send).
// The raw adapter is not re-exported, so no caller can hold a cloud that skips the log; connectCloud builds it here.
// DestinationTransport is the port an adapter to any other outside destination implements, so it is logged by the
// same disclosure core.
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
  type DestinationTransport,
  DisclosureBlockedError,
  DisclosureStoppedError,
  type OutboundRequest,
  type TransportResponse,
} from "./core.ts";
export {
  connectCloud,
  createDisclosedCloud,
  type DisclosedCloud,
  type DisclosedResult,
  DisclosureKeysExpiredError,
  DisclosureNoKeysError,
  type DisclosureOptions,
  DisclosureDiscardedError,
} from "./disclosure.ts";
