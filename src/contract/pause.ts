// The pause call of contract 1.7.0 (ADR-0023; Appendix H, vectors h1 and h2):
// - `POST /v1/pause`, sent with `Intent-Contract-Version: 1.7.0` and signed by the gateway session (Appendix C).
// - Body exactly {account_key_thumbprint, counter, issued_at, signature}. `signature` is base64url Ed25519 by the
//   account key over UTF-8 "intent-pause-v1\n" || JCS({account_key_thumbprint, counter, issued_at, action: "pause"});
//   `action` is signed but never sent.
// - 200 {state: "paused", account_key_thumbprint, counter, paused_at}; a re-pause with a new counter is 200 too.
// - Errors {error, message}: 400 bad_request or clock_skew, 401 unauthorized, 404 not_found (key not pinned yet),
//   409 counter_replayed with last_counter, 429 rate_limited (Retry-After).
// There is no resume route and no status route: resume is by passkey on the confirm page's /account. While paused, a
// submit, the `completing` outcome report and the confirm decision answer 409 {error: "conflict", code: "paused"}.
//
// The request and answer schemas are the vendored spec's (PauseRequest, PauseAccepted, AccountKeyThumbprint in
// schemas.ts, at parity with contract 1.7.0): one source. This file keeps the pause call's own error reading, its
// endpoint shape and the signing bytes.
import { z } from "zod";
import { canonicalize } from "../jcs/index.ts";
import { PauseAccepted, PauseRequest } from "./schemas.ts";

/** The contract version the pause call is sent in. */
export const PAUSE_CONTRACT_VERSION = "1.7.0";
/** The domain separator the account key signs before the JCS payload. */
export const PAUSE_SIGNING_PREFIX = "intent-pause-v1\n";

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

/**
 * Whether an Intent Cloud answer is its `paused` refusal: HTTP 409 {error: "conflict", message, code: "paused"}, on a
 * submit, the `completing` outcome report or the confirm decision. Read by `code`, never by `error`. `body` is the
 * parsed body when there is one, `bytes` the raw body (a 1.6.1 error schema refuses the extra `code` member).
 */
export function isPausedRefusal(status: number, body: unknown, bytes: Uint8Array | null): boolean {
  if (status !== 409) return false;
  const codeOf = (value: unknown): unknown => (typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined);
  if (codeOf(body) === "paused") return true;
  if (bytes === null) return false;
  try {
    return codeOf(JSON.parse(Buffer.from(bytes).toString("utf8"))) === "paused";
  } catch {
    return false;
  }
}
