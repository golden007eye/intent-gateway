// The fixed appendix-C profile: content digest, signature parameters and the RFC 9421 §2.5 signature base.
import { createHash } from "node:crypto";

export const LABEL = "sig1";
export const COMPONENTS = '("@method" "@path" "content-digest")';
export const ALG = "ed25519";
export const TAG = "intent-gateway-v1";
export const MIN_NONCE_BYTES = 16;
export const KEYID_PATTERN = /^gw-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** RFC 9530 Content-Digest with sha-256. Every request carries it, including one with an empty body. */
export function contentDigest(body: Uint8Array): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

export function signatureParams(created: number, nonce: string, keyid: string): string {
  return `${COMPONENTS};created=${String(created)};nonce="${nonce}";keyid="${keyid}";alg="${ALG}";tag="${TAG}"`;
}

export function signatureBase(method: string, path: string, digest: string, params: string): string {
  return `"@method": ${method}\n"@path": ${path}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
}

/** Decodes a nonce written in base64 or base64url (one alphabet, canonical); null when it is neither. */
export function decodeNonce(nonce: string): Buffer | null {
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)) {
    const bytes = Buffer.from(nonce, "base64");
    return bytes.toString("base64").replace(/=+$/, "") === nonce.replace(/=+$/, "") ? bytes : null;
  }
  if (/^[A-Za-z0-9_-]+$/.test(nonce)) {
    const bytes = Buffer.from(nonce, "base64url");
    return bytes.toString("base64url") === nonce ? bytes : null;
  }
  return null;
}

// RFC 8032 §5.1.3 point decoding over edwards25519: 32 bytes are a public key only if they decode to a curve
// point. OpenSSL accepts any 32 bytes as a raw Ed25519 key, so the check is done here.
const P = 2n ** 255n - 19n;

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = ((base % P) + P) % P;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}

const D = (((-121665n * modPow(121666n, P - 2n)) % P) + P) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

/** True when the 32 bytes decode to a point on edwards25519 (RFC 8032 §5.1.3). */
export function isEd25519PublicKey(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(raw[i] ?? 0);
  const signBit = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const yy = (y * y) % P;
  const u = (yy - 1n + P) % P;
  const v = (D * yy + 1n) % P;
  let x = (u * modPow(v, 3n) * modPow(u * modPow(v, 7n), (P - 5n) / 8n)) % P;
  const vxx = (v * x * x) % P;
  if (vxx !== u) {
    if (vxx !== (P - u) % P) return false;
    x = (x * SQRT_M1) % P;
  }
  return !(x === 0n && signBit === 1n);
}
