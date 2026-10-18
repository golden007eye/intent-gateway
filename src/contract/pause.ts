// The pause call of contract 1.7.0 (ADR-0023), not yet in the vendored tree: its wire shape lives here, in one place,
// so it can be checked against the 1.7.0 spec once that tree is vendored. Until then this file is the platform's
// announced shape, word for word:
// - `POST /v1/pause`, sent with `Intent-Contract-Version: 1.7.0` and signed by the gateway session (Appendix C).
// - Body exactly {account_key_thumbprint, counter, issued_at, signature}. `signature` is base64url Ed25519 by the
//   account key over UTF-8 "intent-pause-v1\n" || JCS({account_key_thumbprint, counter, issued_at, action: "pause"});
//   `action` is signed but never sent.
// - 200 {state: "paused", account_key_thumbprint, counter, paused_at}; a re-pause with a new counter is 200 too.
// - Errors {error, message}: 400 bad_request or clock_skew, 401 unauthorized, 404 not_found (key not pinned yet),
//   409 counter_replayed with last_counter, 429 rate_limited (Retry-After).
// There is no resume route and no status route: resume is by passkey on the confirm page's /account.
import { z } from "zod";
import { canonicalize } from "../jcs/index.ts";
import { Timestamp } from "./schemas.ts";

/** The contract version the pause call is sent in. */
export const PAUSE_CONTRACT_VERSION = "1.7.0";
/** The domain separator the account key signs before the JCS payload. */
export const PAUSE_SIGNING_PREFIX = "intent-pause-v1\n";

/** RFC 7638 SHA-256 thumbprint of {crv, kty, x}, base64url without padding. */
export const AccountKeyThumbprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** 64 signature bytes, base64url without padding. */
const Signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);
const Counter = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

export const PauseRequest = z.strictObject({
  account_key_thumbprint: AccountKeyThumbprint,
  counter: Counter,
  issued_at: Timestamp,
  signature: Signature,
});
export type PauseRequest = z.infer<typeof PauseRequest>;

export const PauseAccepted = z.strictObject({
  state: z.literal("paused"),
  account_key_thumbprint: AccountKeyThumbprint,
  counter: Counter,
  paused_at: Timestamp,
});
export type PauseAccepted = z.infer<typeof PauseAccepted>;

/** Every pause error: {error, message}, plus `last_counter` on 409 counter_replayed. Unknown members are dropped. */
export const PauseError = z.object({
  error: z.string().max(64),
  message: z.string().max(200),
  last_counter: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type PauseError = z.infer<typeof PauseError>;

/** The pause endpoint in the shape of contract's Endpoint, with its own error schema and contract version. */
export const PAUSE_ENDPOINT = {
  method: "POST",
  path: "/v1/pause",
  signed: true,
  request: PauseRequest,
  status: 200,
  response: PauseAccepted,
  errors: [400, 401, 404, 409, 429],
} as const;

/** The exact bytes the account key signs for one pause. */
export function pauseSigningBytes(fields: { account_key_thumbprint: string; counter: number; issued_at: string }): Uint8Array {
  const payload = canonicalize({ account_key_thumbprint: fields.account_key_thumbprint, counter: fields.counter, issued_at: fields.issued_at, action: "pause" });
  return Buffer.from(PAUSE_SIGNING_PREFIX + payload, "utf8");
}

/** `error` of an Intent Cloud answer body (JSON bytes), or null: how a `paused` refusal of any call is recognised. */
export function answerError(bytes: Uint8Array): string | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const error = typeof value === "object" && value !== null ? (value as { error?: unknown }).error : undefined;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}
