// The gateway's use cases behind the three agent tools: find offers, create a cart and ask for approval, read the
// approval back. Invariants 1 (policy narrows), 3 (no buyer identity) and 4 (one verified, pinned approval per
// purchase) are enforced here; invariant 2 by the disclosed cloud it is given.
export {
  ApprovalStatusInput,
  type ApprovalStatusResult,
  chainMode,
  contractSums,
  DEMO_SESSION,
  createGateway,
  CreateCartInput,
  type CreateCartResult,
  FindOffersInput,
  type FindOffersResult,
  type Gateway,
  type GatewayLogger,
  GatewayNotStartedError,
  type GatewayOptions,
  GatewayStartError,
  type MissingDetail,
  type OneTapOptions,
  type Refused,
  type ShopOfferView,
} from "./gateway.ts";
export { type ApprovalQr, approvalQr } from "./qr.ts";
export { COMPLETION_BUDGET_MS, type CompletionStep, type CompletionView, newReportId } from "./complete.ts";
