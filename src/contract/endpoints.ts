// The operations, response headers and version of contract/gateway-api.v1.yaml, so callers name an endpoint once.
import { z } from "zod";
import {
  ApprovalCreated,
  ApprovalHandle,
  ApprovalStatus,
  Cart,
  CartHandle,
  CartRequest,
  CheckoutRequest,
  Ed25519Signature,
  ErrorBody,
  Jwks,
  KeyStatement,
  Meta,
  OutcomeReport,
  OutcomeReportAccepted,
  PauseAccepted,
  PauseRequest,
  RateLimited,
  SearchRequest,
  SearchResponse,
} from "./schemas.ts";

/**
 * The contract version this module implements: the spec's `info.version`, sent as `Intent-Contract-Version` on every
 * request (a request without it is answered as 1.5.0), and the version Intent Cloud must report back.
 */
export const CONTRACT_VERSION = "1.7.0";

export interface Endpoint {
  readonly method: "GET" | "POST";
  /** The spec's path template; `{…}` segments are filled by `approvalsPath` and `approvalPath`. */
  readonly path: string;
  /** False when the spec sets `security: []` (unsigned requests accepted). */
  readonly signed: boolean;
  /** The JSON request body, or null for none. */
  readonly request: z.ZodType | null;
  /** The success status and its body. */
  readonly status: 200 | 201;
  readonly response: z.ZodType;
  /** Every other status the spec lists; `errorBody` gives each one's schema. */
  readonly errors: readonly number[];
}

/**
 * The endpoints a `gw-` key may call (plan §3.1, key scoping; `reportOutcome` from 1.6.0) and
 * `GET /v1/key-statement`, keyed by the spec's operationId.
 */
export const ENDPOINTS = {
  getMeta: { method: "GET", path: "/v1/meta", signed: true, request: null, status: 200, response: Meta, errors: [400, 401, 413, 429] },
  getSignatureKeys: { method: "GET", path: "/v1/signature-keys", signed: false, request: null, status: 200, response: Jwks, errors: [413, 429] },
  getKeyStatement: {
    method: "GET",
    path: "/v1/key-statement",
    signed: false,
    request: null,
    status: 200,
    response: KeyStatement,
    errors: [413, 429],
  },
  searchCatalog: {
    method: "POST",
    path: "/v1/catalog/search",
    signed: true,
    request: SearchRequest,
    status: 200,
    response: SearchResponse,
    errors: [400, 401, 413, 429],
  },
  createCart: {
    method: "POST",
    path: "/v1/carts",
    signed: true,
    request: CartRequest,
    status: 201,
    response: Cart,
    errors: [400, 401, 404, 409, 410, 413, 429],
  },
  createApproval: {
    method: "POST",
    path: "/v1/carts/{cart_handle}/approvals",
    signed: true,
    request: null,
    status: 201,
    response: ApprovalCreated,
    errors: [400, 401, 404, 410, 413, 429],
  },
  getApproval: {
    method: "GET",
    path: "/v1/approvals/{approval_handle}",
    signed: true,
    request: null,
    status: 200,
    response: ApprovalStatus,
    errors: [400, 401, 404, 413, 429],
  },
  reportOutcome: {
    method: "POST",
    path: "/v1/approvals/{approval_handle}/outcome-reports",
    signed: true,
    request: OutcomeReport,
    status: 201,
    response: OutcomeReportAccepted,
    errors: [400, 401, 404, 409, 410, 413, 429],
  },
  createCheckout: {
    method: "POST",
    path: "/v1/checkouts",
    signed: true,
    request: CheckoutRequest,
    status: 201,
    response: ApprovalCreated,
    errors: [400, 401, 403, 404, 409, 413, 429],
  },
  pauseAccount: {
    method: "POST",
    path: "/v1/pause",
    signed: true,
    request: PauseRequest,
    status: 200,
    response: PauseAccepted,
    errors: [400, 401, 404, 409, 413, 429],
  },
} as const satisfies Record<string, Endpoint>;
export type OperationId = keyof typeof ENDPOINTS;

/** The body schema of an error status: `RateLimited` for 429, `Error` for every other one. */
export function errorBody(status: number): typeof ErrorBody | typeof RateLimited {
  return status === 429 ? RateLimited : ErrorBody;
}

/** `createApproval`'s path. Throws on a malformed handle, so a handle can never add path segments. */
export function approvalsPath(cartHandle: string): string {
  return `/v1/carts/${CartHandle.parse(cartHandle)}/approvals`;
}

/** `getApproval`'s path. Throws on a malformed handle. */
export function approvalPath(approvalHandle: string): string {
  return `/v1/approvals/${ApprovalHandle.parse(approvalHandle)}`;
}

/** `reportOutcome`'s path. Throws on a malformed handle. */
export function outcomeReportsPath(approvalHandle: string): string {
  return `${approvalPath(approvalHandle)}/outcome-reports`;
}

/**
 * The response headers of `components.headers`, under their spec component names. `Retry-After` arrives as text;
 * convert it with Number() before parsing. The first three are on every edge response; `Retry-After` on 429.
 */
export const HEADERS = {
  IntentContractVersion: { name: "Intent-Contract-Version", schema: z.string().regex(/^\d+\.\d+\.\d+$/) },
  IntentReceipt: {
    name: "Intent-Receipt",
    schema: z
      .string()
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+$/),
  },
  IntentReceiptSignature: { name: "Intent-Receipt-Signature", schema: Ed25519Signature },
  RetryAfter: { name: "Retry-After", schema: z.int().min(1) },
} as const satisfies Record<string, { name: string; schema: z.ZodType }>;
