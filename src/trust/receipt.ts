// Receipts (Appendix D): Intent Cloud's edge signs what it received. A valid receipt matches the request the gateway
// logged before sending (invariant 2) and is the only acknowledgement the gateway reports (invariant 5).
import { verify } from "node:crypto";
import { Receipt } from "../contract/index.ts";
import { canonicalize } from "../jcs/index.ts";
import { fromBase64Url, utf8 } from "./bytes.ts";
import { type KeySet, trustedKeys } from "./statement.ts";

/** The response as the gateway received it: its status and the two receipt headers (undefined when absent). */
export interface ReceiptResponse {
  readonly status: number;
  /** `Intent-Receipt` */
  readonly receipt: string | undefined;
  /** `Intent-Receipt-Signature` */
  readonly signature: string | undefined;
}

/**
 * What the gateway logged as sent, in the receipt's own field names. `keyid`, `nonce` and `created` are the values
 * the request was signed with, and absent for an unsigned request.
 */
export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly content_digest: string;
  readonly keyid?: string;
  readonly nonce?: string;
  readonly created?: number;
}

export type ReceiptFailure =
  | { ok: false; step: 1; reason: "missing" | "bad_encoding" }
  | { ok: false; step: 2; reason: "not_json" | "not_canonical" | "schema" }
  | { ok: false; step: 3; reason: "not_verified" | "statement_expired" | "unknown_kid" | "bad_signature" }
  | {
      ok: false;
      step: 4;
      reason: "method_mismatch" | "path_mismatch" | "digest_mismatch" | "keyid_mismatch" | "nonce_mismatch" | "created_mismatch";
    }
  | { ok: false; step: 5; reason: "status_mismatch" };

export type ReceiptResult = { ok: true; receipt: Receipt } | ReceiptFailure;

const SIGNING_PREFIX = Buffer.from("intent-receipt-v1\n", "utf8");

const MATCHED = [
  ["method", "method_mismatch"],
  ["path", "path_mismatch"],
  ["content_digest", "digest_mismatch"],
  ["keyid", "keyid_mismatch"],
  ["nonce", "nonce_mismatch"],
  ["created", "created_mismatch"],
] as const satisfies readonly (readonly [keyof SentRequest, string])[];

/** Checks a receipt against the request the gateway logged and the response that carried it (Appendix D, steps 1–5). */
export function verifyReceipt(response: ReceiptResponse, sent: SentRequest, keySet: KeySet, now: Date): ReceiptResult {
  if (response.receipt === undefined || response.signature === undefined) return fail(1, "missing");
  const bytes = fromBase64Url(response.receipt);
  const sig = fromBase64Url(response.signature);
  if (bytes === null || sig === null || bytes.length === 0) return fail(1, "bad_encoding");

  const text = utf8(bytes);
  if (text === null) return fail(2, "not_json");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(2, "not_json");
  }
  if (!isCanonical(value, text)) return fail(2, "not_canonical");
  const parsed = Receipt.safeParse(value);
  if (!parsed.success) return fail(2, "schema");
  const receipt = parsed.data;

  const keys = trustedKeys(keySet, now);
  if (keys === "not_verified") return fail(3, "not_verified");
  if (keys === "expired") return fail(3, "statement_expired");
  const key = keys.receipt.get(receipt.kid);
  if (key === undefined) return fail(3, "unknown_kid");
  if (!verify(null, Buffer.concat([SIGNING_PREFIX, bytes]), key, sig)) return fail(3, "bad_signature");

  for (const [field, reason] of MATCHED) {
    if (receipt.request[field] !== sent[field]) return fail(4, reason);
  }
  if (receipt.status !== response.status) return fail(5, "status_mismatch");
  return { ok: true, receipt };
}

function isCanonical(value: unknown, text: string): boolean {
  try {
    return canonicalize(value) === text;
  } catch {
    return false;
  }
}

function fail<S extends ReceiptFailure["step"]>(step: S, reason: Extract<ReceiptFailure, { step: S }>["reason"]): ReceiptFailure {
  return { ok: false, step, reason } as ReceiptFailure;
}
