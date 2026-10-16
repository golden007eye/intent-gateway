// Strict decoders shared by the verifiers. Each returns null instead of guessing, so a malformed field fails the
// check that reads it rather than decoding to something else.
import { createPublicKey, type KeyObject } from "node:crypto";

/** Decodes base64url without padding, refusing any other alphabet, padding or non-zero trailing bits. */
export function fromBase64Url(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, "base64url");
  // Re-encoding catches the non-canonical forms Node's decoder accepts silently (stray low bits in the last char).
  return bytes.toString("base64url") === text ? bytes : null;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes UTF-8, refusing invalid sequences instead of replacing them with U+FFFD. */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return fatalUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Milliseconds since the epoch of an RFC 3339 UTC timestamp with seconds and `Z`, or null for a date that does not exist. */
export function parseTimestamp(text: string): number | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(text)) return null;
  const ms = Date.parse(text);
  // Date.parse rolls 2026-02-30 over to March; the round trip refuses it.
  return Number.isFinite(ms) && new Date(ms).toISOString() === `${text.slice(0, -1)}.000Z` ? ms : null;
}

/** An Ed25519 public key from its raw 32 bytes (base64url), or null when x is not a canonical 32-byte encoding. */
export function ed25519Key(x: string): KeyObject | null {
  const raw = fromBase64Url(x);
  // Every 32-byte string imports as an Ed25519 public key, so createPublicKey cannot fail past this check.
  return raw?.length === 32 ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }) : null;
}
