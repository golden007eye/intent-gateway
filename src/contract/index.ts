// zod schemas and types for the Intent Cloud public contract 1.6.1 (contract/gateway-api.v1.yaml and appendices A–G),
// plus its endpoints and response headers. Each schema is exported under its spec name (Error as ErrorBody).
export * from "./schemas.ts";
export { approvalPath, approvalsPath, CONTRACT_VERSION, ENDPOINTS, errorBody, HEADERS, outcomeReportsPath } from "./endpoints.ts";
export type { Endpoint, OperationId } from "./endpoints.ts";
export { checkoutRefHash } from "./checkout.ts";
export {
  isMyshopifyDomain,
  type MetaAnswer,
  metaUrl,
  parseUniqueJson,
  STORE_PAIR_LIMITS,
  storePairPrecondition,
  storePairProblem,
  type StorePairReason,
} from "./store-pair.ts";
export {
  AccountKeyThumbprint,
  answerError,
  PAUSE_CONTRACT_VERSION,
  PAUSE_ENDPOINT,
  PAUSE_SIGNING_PREFIX,
  PauseAccepted,
  PauseError,
  PauseRequest,
  pauseSigningBytes,
} from "./pause.ts";
