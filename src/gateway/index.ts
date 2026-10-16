// The gateway's use cases behind the three agent tools: find offers, create a cart and ask for approval, read the
// approval back. Invariants 1 (policy narrows), 3 (no buyer identity) and 4 (one verified, pinned approval per
// purchase) are enforced here; invariant 2 by the disclosed cloud it is given.
export {
  ApprovalStatusInput,
  type ApprovalStatusResult,
  contractSums,
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
  type Refused,
} from "./gateway.ts";
export type { ApprovalQr } from "./qr.ts";
