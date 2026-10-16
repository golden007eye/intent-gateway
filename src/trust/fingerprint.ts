// The approver fingerprint: how a person compares passkeys across the panel, stderr and `intent approver accept`.
import type { CredentialPublicKey } from "../contract/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";

/**
 * The fingerprint of a passkey public key: the lowercase hex SHA-256 of the JCS of its JWK (exactly the members
 * Appendix E allows), written as 16 groups of 4 hex characters separated by single spaces, for example
 * `3f2a 9c01 … 7be4`. It is the whole hash, so two keys never share a fingerprint. The `approver_pin` and
 * `approver_flag` bodies carry this string, the panel shows it, and `intent approver accept` compares against it.
 */
export function approverFingerprint(jwk: CredentialPublicKey): string {
  const hex = sha256Hex(canonicalize(jwk.kty === "EC" ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: jwk.alg } : { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg }));
  return (hex.match(/.{4}/g) ?? []).join(" ");
}
