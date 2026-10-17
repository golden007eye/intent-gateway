// The published test root is exactly s1's root, and only a set made of it alone counts as a demo trust set.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PINNED } from "../../test/support/trust-kit.ts";
import { isTestRoot, onlyTestRoot, TEST_ROOT_KEY, TEST_ROOT_X } from "./index.ts";

const other = { kid: "cloud-root-1", jwk: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) };

describe("TEST_ROOT_KEY", () => {
  it("is vector s1's root public key", () => {
    expect(PINNED).toEqual([TEST_ROOT_KEY]);
  });

  it("is recognised under any kid, and another key under its kid is not", () => {
    expect(isTestRoot({ kid: "cloud-root-9", jwk: TEST_ROOT_KEY.jwk })).toBe(true);
    expect(isTestRoot(other)).toBe(false);
  });

  it("attack: a non-canonical spelling of x (the last character's padding bits) is still the test root", () => {
    for (const last of ["V", "W", "X"]) {
      const respelled = { kid: "cloud-root-1", jwk: { ...TEST_ROOT_KEY.jwk, x: `${TEST_ROOT_X.slice(0, -1)}${last}` } };
      expect(isTestRoot(respelled), last).toBe(true);
      expect(onlyTestRoot([respelled]), last).toBe(true);
    }
    // One bit beyond the padding changes the key.
    expect(isTestRoot({ kid: "cloud-root-1", jwk: { ...TEST_ROOT_KEY.jwk, x: `${TEST_ROOT_X.slice(0, -1)}Y` } })).toBe(false);
  });

  it("onlyTestRoot: needs at least one key, and every key the test root (attack: a real root mixed in)", () => {
    expect(onlyTestRoot([TEST_ROOT_KEY])).toBe(true);
    expect(onlyTestRoot([])).toBe(false);
    expect(onlyTestRoot([TEST_ROOT_KEY, other])).toBe(false);
    expect(onlyTestRoot([other])).toBe(false);
  });
});
