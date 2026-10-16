// The published test root: `cloud-root-1` of contract vector s1, whose private seed is in the vector itself, so
// anyone can sign with it. Demo mode trusts this key and nothing else; no Intent Cloud host may ever pin it.
import type { PinnedRootKey } from "./statement.ts";

export const TEST_ROOT_KEY: PinnedRootKey = Object.freeze({
  kid: "cloud-root-1",
  jwk: Object.freeze({ kty: "OKP", crv: "Ed25519", x: "F0VTtFbd38aQjsqxwQH-arIeK6oGF3lbfUOmNIKZP9U" }),
});

/** True when the key is the published test root, whatever kid it is listed under. */
export function isTestRoot(key: PinnedRootKey): boolean {
  return key.jwk.x === TEST_ROOT_KEY.jwk.x;
}

/** True when there is at least one key and every key is the published test root: a trust set only demo mode uses. */
export function onlyTestRoot(keys: readonly PinnedRootKey[]): boolean {
  return keys.length > 0 && keys.every(isTestRoot);
}
