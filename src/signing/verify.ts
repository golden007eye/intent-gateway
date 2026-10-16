// The verifier side of appendix C, for the fake Cloud and tests. Each row of the appendix's rejection table has its
// own code; checks run in a fixed order and the nonce is recorded only once the signature verifies.
import { createPublicKey, verify } from "node:crypto";
import {
  ALG,
  COMPONENTS,
  contentDigest,
  decodeNonce,
  isEd25519PublicKey,
  KEYID_PATTERN,
  LABEL,
  MIN_NONCE_BYTES,
  signatureBase,
  TAG,
} from "./profile.ts";

export type RejectCode =
  | "missing_header" // Content-Digest, Signature-Input or Signature is absent
  | "malformed_header" // a header does not parse, is repeated, or the signature is not 64 bytes
  | "profile_mismatch" // another label, component list, or parameter set or order
  | "wrong_alg"
  | "wrong_tag"
  | "bad_keyid" // not the gw- shape, not canonical, or not an Ed25519 point
  | "nonce_not_base64"
  | "nonce_too_short" // fewer than 16 bytes
  | "created_too_old" // more than 60 s before now
  | "created_in_future" // more than 5 s after now
  | "digest_mismatch" // Content-Digest does not match the body: 400
  | "bad_signature"
  | "replay"; // nonce seen within the 65 s retention

export interface Verified {
  ok: true;
  keyid: string;
  nonce: string;
  created: number;
}
export type VerifyResult = Verified | { ok: false; code: RejectCode; status: 400 | 401 };

/** Returns whether a nonce was already seen within the retention window, and records it if not. */
export type NonceCache = (nonce: string, now: number) => boolean;

export const MAX_AGE_SECONDS = 60;
export const MAX_FUTURE_SECONDS = 5;
// Every request that can still pass the age check (created ≤ seen + 5, now ≤ created + 60) is still remembered.
export const NONCE_RETENTION_SECONDS = MAX_AGE_SECONDS + MAX_FUTURE_SECONDS;

/** An in-memory replay cache keyed on the nonce's decoded bytes, keeping each one for 65 s. */
export function createNonceCache(): NonceCache {
  const seen = new Map<string, number>();
  return (nonce, now) => {
    for (const [key, at] of seen) {
      if (now - at <= NONCE_RETENTION_SECONDS) break;
      seen.delete(key);
    }
    const key = decodeNonce(nonce)?.toString("hex") ?? nonce;
    const at = seen.get(key);
    if (at !== undefined && now - at <= NONCE_RETENTION_SECONDS) return true;
    seen.delete(key);
    seen.set(key, now);
    return false;
  };
}

type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

const TOKEN = "[a-z*][a-z0-9_.*-]*";
const SIG_INPUT = new RegExp(`^(${TOKEN})=(\\([^()]*\\))((?:;${TOKEN}=(?:-?\\d+|"[^"\\\\]*"))*)$`);
const PARAM = new RegExp(`;(${TOKEN})=(-?\\d+|"[^"\\\\]*")`, "g");
const SIGNATURE = new RegExp(`^(${TOKEN})=:([A-Za-z0-9+/]*={0,2}):$`);
const DIGEST = /^sha-256=:[A-Za-z0-9+/]{43}=:$/;
const PARAM_ORDER = "created,nonce,keyid,alg,tag";

const reject = (code: RejectCode): VerifyResult => ({ ok: false, code, status: code === "digest_mismatch" ? 400 : 401 });

/** The single value of a header, matched case-insensitively; null when it is repeated. */
function header(headers: HeaderBag, name: string): string | null | undefined {
  let found: string | null | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) continue;
    if (found !== undefined || typeof value !== "string") return null;
    found = value;
  }
  return found;
}

/**
 * Verifies one signed request against appendix C. `now` is integer seconds. `seenNonce` is consulted only after the
 * signature verifies, so a forged request cannot burn a legitimate nonce.
 */
export function verifyRequest(
  headers: HeaderBag,
  request: { method: string; path: string; body: Uint8Array },
  options: { now: number; seenNonce: NonceCache },
): VerifyResult {
  const digestHeader = header(headers, "content-digest");
  const inputHeader = header(headers, "signature-input");
  const sigHeader = header(headers, "signature");
  if (digestHeader === undefined || inputHeader === undefined || sigHeader === undefined) return reject("missing_header");
  if (digestHeader === null || inputHeader === null || sigHeader === null) return reject("malformed_header");

  const input = SIG_INPUT.exec(inputHeader);
  const sig = SIGNATURE.exec(sigHeader);
  if (input === null || sig === null || !DIGEST.test(digestHeader)) return reject("malformed_header");
  const [, label, components, paramText = ""] = input;
  const params = new Map<string, string>();
  for (const [, name = "", value = ""] of paramText.matchAll(PARAM)) {
    if (params.has(name)) return reject("profile_mismatch");
    params.set(name, value);
  }
  if (label !== LABEL || sig[1] !== LABEL || components !== COMPONENTS || [...params.keys()].join(",") !== PARAM_ORDER) {
    return reject("profile_mismatch");
  }
  const quoted = (name: string): string | null => {
    const value = params.get(name) ?? "";
    return value.startsWith('"') ? value.slice(1, -1) : null;
  };
  const createdText = params.get("created") ?? "";
  const nonce = quoted("nonce");
  const keyid = quoted("keyid");
  if (!/^\d{1,15}$/.test(createdText) || nonce === null || keyid === null) return reject("malformed_header");
  if (quoted("alg") !== ALG) return reject("wrong_alg");
  if (quoted("tag") !== TAG) return reject("wrong_tag");

  if (!KEYID_PATTERN.test(keyid)) return reject("bad_keyid");
  const x = keyid.slice(3);
  const rawKey = Buffer.from(x, "base64url");
  if (rawKey.toString("base64url") !== x || !isEd25519PublicKey(rawKey)) return reject("bad_keyid");

  const nonceBytes = decodeNonce(nonce);
  if (nonceBytes === null) return reject("nonce_not_base64");
  if (nonceBytes.length < MIN_NONCE_BYTES) return reject("nonce_too_short");

  const created = Number(createdText);
  if (options.now - created > MAX_AGE_SECONDS) return reject("created_too_old");
  if (created - options.now > MAX_FUTURE_SECONDS) return reject("created_in_future");

  if (contentDigest(request.body) !== digestHeader) return reject("digest_mismatch");

  const sigText = sig[2] ?? "";
  const signature = Buffer.from(sigText, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== sigText) return reject("malformed_header");
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  const base = signatureBase(request.method, request.path, digestHeader, inputHeader.slice(LABEL.length + 1));
  if (!verify(null, Buffer.from(base), publicKey, signature)) return reject("bad_signature");

  if (options.seenNonce(nonce, options.now)) return reject("replay");
  return { ok: true, keyid, nonce, created };
}
