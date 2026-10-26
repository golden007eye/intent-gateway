// The gateway policy module: load a policy.yaml (narrow-only, invariant 1), combine policies with `meet`, and
// decide what may leave the gateway with `evaluate`.
export { PolicyError, type PolicyErrorCode } from "./parse.ts";
export {
  categoryBlocked,
  CLOUD_BASELINE,
  COMPLETION_MODES,
  EXCLUDED_CATEGORIES,
  MAX_POLICY_BYTES,
  MAX_QUANTITY,
  loadPolicy,
  meet,
  merchantMatches,
  normalizeMerchant,
  type CompletionMode,
  type Policy,
  type ShipTo,
  type Spend,
} from "./policy.ts";
export {
  capsIn,
  capText,
  evaluate,
  type Blocked,
  type CapsMinor,
  type Ceilings,
  type CartRequest,
  type Decision,
  type Offer,
  type Outbound,
  type Purchase,
  type SearchRequest,
} from "./evaluate.ts";
export { runCases, type CaseResult } from "./cases.ts";
