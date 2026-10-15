// The gateway policy module: load a policy.yaml (narrow-only, invariant 1), combine policies with `meet`, and
// decide what may leave the gateway with `evaluate`.
export { PolicyError, type PolicyErrorCode } from "./parse.ts";
export {
  CLOUD_BASELINE,
  EXCLUDED_CATEGORIES,
  MAX_POLICY_BYTES,
  MAX_QUANTITY,
  loadPolicy,
  meet,
  type Policy,
  type ShipTo,
  type Spend,
} from "./policy.ts";
export {
  evaluate,
  type Blocked,
  type CartRequest,
  type Decision,
  type Offer,
  type Outbound,
  type Purchase,
  type SearchRequest,
} from "./evaluate.ts";
export { runCases, type CaseResult } from "./cases.ts";
