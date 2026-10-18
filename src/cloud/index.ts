// The HTTP adapter to Intent Cloud: the fixed header set over node:https, one connection per request. Only
// src/disclosure may import it (invariant 2: every send is logged first, through CallOptions.beforeSend).
export {
  type CallOptions,
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  type CloudResult,
  createHttpCloud,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  type HeaderPair,
  type HttpCloudOptions,
  type IntentCloud,
  type Operation,
  type PreparedRequest,
  type RawExchange,
  type ReceiptHeaders,
} from "./http.ts";
