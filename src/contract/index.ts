// zod schemas and types for the Intent Cloud public contract 1.5.0 (contract/gateway-api.v1.yaml and appendices A–F),
// plus its endpoints and response headers. Each schema is exported under its spec name (Error as ErrorBody).
export * from "./schemas.ts";
export { approvalPath, approvalsPath, CONTRACT_VERSION, ENDPOINTS, errorBody, HEADERS } from "./endpoints.ts";
export type { Endpoint, OperationId } from "./endpoints.ts";
