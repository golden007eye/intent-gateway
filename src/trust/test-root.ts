// The published test root: `cloud-root-1` of contract vector s1, whose private seed is in the vector itself, so
// anyone can sign with it. Demo mode trusts this key and nothing else; no Intent Cloud host may ever pin it.
import type { PinnedRootKey } from "./statement.ts";

/** The test root's public key, base64url as vector s1 spells it. */
export const TEST_ROOT_X = "F0VTtFbd38aQjsqxwQH-arIeK6oGF3lbfUOmNIKZP9U";

export const TEST_ROOT_KEY: PinnedRootKey = Object.freeze({
  kid: "cloud-root-1",
  jwk: Object.freeze({ kty: "OKP", crv: "Ed25519", x: TEST_ROOT_X }),
});

const TEST_ROOT_BYTES = Buffer.from(TEST_ROOT_X, "base64url");

/**
 * True when the key is the published test root, whatever kid it is listed under and however `x` is spelled: the
 * decoded key bytes are compared, because the last base64url character carries 2 padding bits, so several spellings
 * (`…P9U`, `…P9V`, `…P9X`) decode to the same key.
 */
export function isTestRoot(key: PinnedRootKey): boolean {
  return typeof key.jwk.x === "string" && Buffer.from(key.jwk.x, "base64url").equals(TEST_ROOT_BYTES);
}

/** True when there is at least one key and every key is the published test root: a trust set only demo mode uses. */
export function onlyTestRoot(keys: readonly PinnedRootKey[]): boolean {
  return keys.length > 0 && keys.every(isTestRoot);
}
