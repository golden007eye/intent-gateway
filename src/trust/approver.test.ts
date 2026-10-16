// ADR-0011: the first verified approving passkey is pinned, the same one matches, any other is flagged. The
// fingerprint is recomputed here by hand (sorted JWK members, SHA-256, groups of 4) to pin its format.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { at, E1, makeProof, PINNED, pendingEntry, S1, SNAPSHOT, TestPasskey } from "../../test/support/trust-kit.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { approverFingerprint, type ChainEntry, checkApprover, type VerifiedCredential, verifyApprovalProof, verifyStatement } from "./index.ts";

const now = at(E1.input.valid_at);
const statement = verifyStatement(S1.expected.statement, PINNED, now);
if (!statement.ok) throw new Error("s1 did not verify");
const display = { merchant: "m", title: "t", total: { amount_minor: 1, currency: "USD" } };

function verified(proof: unknown): VerifiedCredential {
  if (!statement.ok) throw new Error("unreachable");
  const result = verifyApprovalProof({ state: "approved", display, proof }, pendingEntry(), statement.keySet, [], now);
  if (!result.ok) throw new Error(`proof did not verify: ${result.reason}`);
  return result.credential;
}

const humanKey = E1.expected.proof.credential_public_key as { x: string; y: string };
const human = verified(E1.expected.proof);
const agent = verified(makeProof({ passkey: new TestPasskey("ES256") }));
const pinOf = (c: VerifiedCredential): ChainEntry => ({ kind: "approver_pin", body: checkApprover(c, []).entry?.body });

describe("approverFingerprint", () => {
  it("is the SHA-256 of the JWK's canonical JSON, as 16 space-separated groups of 4 hex characters", () => {
    const jcs = `{"alg":"ES256","crv":"P-256","kty":"EC","x":"${humanKey.x}","y":"${humanKey.y}"}`;
    const hex = createHash("sha256").update(jcs).digest("hex");
    expect(human.fingerprint).toBe(hex.replace(/(.{4})(?!$)/g, "$1 "));
    expect(human.fingerprint).toMatch(/^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);
    expect(approverFingerprint(human.publicKey)).toBe(human.fingerprint);
  });
  it("covers RS256 keys, and differs between keys", () => {
    const rs = new TestPasskey("RS256").jwk as { n: string; e: string };
    const jcs = `{"alg":"RS256","e":"${rs.e}","kty":"RSA","n":"${rs.n}"}`;
    const hex = createHash("sha256").update(jcs).digest("hex");
    expect(approverFingerprint({ kty: "RSA", n: rs.n, e: rs.e, alg: "RS256" })).toBe(hex.replace(/(.{4})(?!$)/g, "$1 "));
    expect(agent.fingerprint).not.toBe(human.fingerprint);
  });
});

/** A credential of one passkey (the same key every time) whose authenticator reports `signCount`, for `handle`. */
const passkey = new TestPasskey("ES256");
function counting(signCount: number, handle = "ap_TEST0001"): VerifiedCredential {
  if (!statement.ok) throw new Error("unreachable");
  const snapshot = { ...SNAPSHOT, approval: handle };
  const snapshotHash = sha256Hex(canonicalize(snapshot));
  const proof = makeProof({ passkey, signCount, handle, snapshot, snapshotHash });
  const result = verifyApprovalProof({ state: "approved", display, proof }, pendingEntry(handle, snapshotHash), statement.keySet, [], now);
  if (!result.ok) throw new Error(`proof did not verify: ${result.reason}`);
  return result.credential;
}
const approvalEntry = (handle: string, signCount?: number): ChainEntry => ({
  kind: "approval",
  body: { handle, proof: {}, ...(signCount === undefined ? {} : { sign_count: signCount }) },
});

describe("checkApprover", () => {
  it("pins the first verified credential and returns the approver_pin entry to chain", () => {
    expect(checkApprover(human, [pendingEntry()])).toEqual({
      decision: "pin",
      fingerprint: human.fingerprint,
      entry: {
        kind: "approver_pin",
        body: {
          fingerprint: human.fingerprint,
          credential_id: "Y3JlZC0x",
          credential_public_key: E1.expected.proof.credential_public_key,
          sign_count: 0,
          handle: "ap_TEST0001",
        },
      },
    });
  });
  it("matches the pinned credential and writes nothing", () => {
    expect(checkApprover(human, [pinOf(human), { kind: "approval", body: { handle: "ap_TESTX" } }])).toEqual({ decision: "match", fingerprint: human.fingerprint, entry: null });
  });
  it("flags a different credential: an agent's passkey cannot approve once a human's is pinned", () => {
    const result = checkApprover(agent, [pinOf(human)]);
    expect(result).toMatchObject({ decision: "flag", reason: "other_passkey" });
    expect(result.entry).toEqual({
      kind: "approver_flag",
      body: { fingerprint: agent.fingerprint, credential_id: "Y3JlZC0y", credential_public_key: agent.publicKey, sign_count: 0, handle: "ap_TEST0001", reason: "other_passkey" },
    });
  });
  it("keeps flagging after a flag: a flag never becomes the pin", () => {
    const flag = checkApprover(agent, [pinOf(human)]).entry;
    const chain: ChainEntry[] = [pinOf(human), { kind: "approver_flag", body: flag?.body }];
    expect(checkApprover(agent, chain).decision).toBe("flag");
    expect(checkApprover(human, chain).decision).toBe("match");
  });
  it("follows the latest pin, as `intent approver accept` writes it", () => {
    const chain = [pinOf(human), pinOf(agent)];
    expect(checkApprover(agent, chain).decision).toBe("match");
    expect(checkApprover(human, chain).decision).toBe("flag");
  });
  it("flags every credential when the latest pin is unreadable, rather than re-pinning", () => {
    for (const body of [null, "x", {}, { fingerprint: 7 }]) {
      expect(checkApprover(human, [{ kind: "approver_pin", body }]).decision).toBe("flag");
    }
  });
  it("refuses a credential that verifyApprovalProof did not return", () => {
    for (const changed of [{ signCount: 99 }, { handle: "ap_OTHER" }]) {
      expect(() => checkApprover({ ...counting(1), ...changed }, [])).toThrow(TypeError);
    }
    const forged: VerifiedCredential = { ...human };
    expect(() => checkApprover(forged, [])).toThrow(TypeError);
  });
});

describe("checkApprover: the signature counter (WebAuthn §7.2 step 21; attack: a cloned passkey)", () => {
  const pinAt = (c: VerifiedCredential): ChainEntry => ({ kind: "approver_pin", body: checkApprover(c, []).entry?.body });

  it("reads the counter from authenticatorData and records it, with the approval, in the pin", () => {
    const c = counting(7, "ap_TESTA");
    expect(c.signCount).toBe(7);
    expect(checkApprover(c, []).entry?.body).toMatchObject({ sign_count: 7, handle: "ap_TESTA" });
    expect(counting(2 ** 32 - 1).signCount).toBe(2 ** 32 - 1);
  });
  it("matches when the counter went up since the pin and since the last approval", () => {
    const chain = [pinAt(counting(5, "ap_TESTA")), approvalEntry("ap_TESTA", 5)];
    expect(checkApprover(counting(6, "ap_TESTB"), chain).decision).toBe("match");
    expect(checkApprover(counting(9, "ap_TESTC"), [...chain, approvalEntry("ap_TESTB", 8)]).decision).toBe("match");
  });
  it("flags a counter that did not go up: equal to, or lower than, the last seen; the highest one counts", () => {
    const chain = [pinAt(counting(5, "ap_TESTA")), approvalEntry("ap_TESTA", 5)];
    for (const count of [5, 4, 1]) {
      const result = checkApprover(counting(count, "ap_TESTB"), chain);
      expect(result).toMatchObject({ decision: "flag", reason: "sign_count", entry: { kind: "approver_flag", body: { reason: "sign_count", sign_count: count, handle: "ap_TESTB" } } });
    }
    expect(checkApprover(counting(8, "ap_TESTC"), [...chain, approvalEntry("ap_TESTB", 9), approvalEntry("ap_TESTX", 3)]).decision).toBe("flag");
  });
  it("flags a counter of 0 after a non-zero one: the authenticator stopped counting, as a copy would", () => {
    expect(checkApprover(counting(0, "ap_TESTB"), [pinAt(counting(5, "ap_TESTA"))])).toMatchObject({ decision: "flag", reason: "sign_count" });
  });
  it("accepts both counters at 0: the authenticator does not count (platform passkeys, vector e1)", () => {
    const chain = [pinAt(counting(0, "ap_TESTA")), approvalEntry("ap_TESTA", 0)];
    expect(checkApprover(counting(0, "ap_TESTB"), chain).decision).toBe("match");
  });
  it("does not compare an approval with its own pin or entry, so re-checking it (intent verify, a retry) still matches", () => {
    const pin = pinAt(counting(5, "ap_TESTA"));
    expect(checkApprover(counting(5, "ap_TESTA"), [pin]).decision).toBe("match");
    expect(checkApprover(counting(5, "ap_TESTA"), [pin, approvalEntry("ap_TESTA", 5)]).decision).toBe("match");
  });
  it("treats a missing or unreadable counter as unknown: chains written before it was recorded still verify", () => {
    const oldPin: ChainEntry = { kind: "approver_pin", body: { fingerprint: counting(0).fingerprint } };
    expect(checkApprover(counting(3, "ap_TESTB"), [oldPin, approvalEntry("ap_TESTA")]).decision).toBe("match");
    for (const bad of [-1, 1.5, "9", null]) {
      expect(checkApprover(counting(3, "ap_TESTB"), [oldPin, { kind: "approval", body: { handle: "ap_TESTA", sign_count: bad } }]).decision).toBe("match");
    }
  });
  it("starts again from a pin that `intent approver accept` wrote: counters before it are not compared", () => {
    const accepted: ChainEntry = { kind: "approver_pin", body: { fingerprint: counting(0).fingerprint } };
    const chain = [pinAt(counting(9, "ap_TESTA")), approvalEntry("ap_TESTA", 9), accepted];
    expect(checkApprover(counting(2, "ap_TESTB"), chain).decision).toBe("match");
    expect(checkApprover(counting(2, "ap_TESTC"), [...chain, approvalEntry("ap_TESTB", 2)]).decision).toBe("flag");
  });
});
