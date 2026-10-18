// outcome: what happened after an approval (contract 1.6.0, Appendix G; ADR-0015). Pure; no I/O.
// - binding-v1 (`bindingV1`, vector o1): an observed order against the approved snapshot.
// - The model's tables: each mode's states, Intent Cloud's sources and their assurance caps, R5a precedence.
// - `readCloudOutcome`: rules O1, O2 and M1 on Intent Cloud's statement: what the gateway shows, never more than the
//   verified statement (invariant 5).
// - The `outcome` chain entry (`OutcomeEntry`), and `chargedNothing`: cap room comes back only on local evidence.
export {
  BindingError,
  bindingResult,
  bindingV1,
  bindingV2,
  type ObservedOrderV2,
  type BindingChecks,
  type BindingContext,
  type BindingResult,
  normaliseOrigin,
  type ObservedOrder,
  SHIP_TO_OPTIONAL,
  shipToOptional,
  totalMatches,
} from "./binding.ts";
export {
  chargedNothing,
  CloudOutcomeEntry,
  COMPLETE_CHECKOUT,
  LocalOutcomeEntry,
  mayHaveSent,
  OutcomeEntry,
  type OutcomeChainEntry,
  outcomesFor,
} from "./entry.ts";
export {
  CLOUD_SOURCES,
  GATEWAY_SOURCES,
  MODE_STATES,
  ORDER_REF,
  type OutcomeHead,
  replaces,
  REPORT_STATES,
  REPORTED_ONLY_SOURCES,
  TERMINAL_STATES,
} from "./model.ts";
export { type CloudReading, readCloudOutcome, shownStatus, type StatementCheck } from "./read.ts";
