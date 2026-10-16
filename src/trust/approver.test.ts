// ADR-0011: the first verified approving passkey is pinned, the same one matches, any other is flagged. The
// fingerprint is recomputed here by hand (sorted JWK members, SHA-256, groups of 4) to pin its format.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { at, E1, makeProof, PINNED, pendingEntry, S1, TestPasskey } from "../../test/support/trust-kit.ts";
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

describe("checkApprover", () => {
  it("pins the first verified credential and returns the approver_pin entry to chain", () => {
    expect(checkApprover(human, [pendingEntry()])).toEqual({
      decision: "pin",
      fingerprint: human.fingerprint,
      entry: {
        kind: "approver_pin",
        body: { fingerprint: human.fingerprint, credential_id: "Y3JlZC0x", credential_public_key: E1.expected.proof.credential_public_key },
      },
    });
  });
  it("matches the pinned credential and writes nothing", () => {
    expect(checkApprover(human, [pinOf(human), { kind: "approval", body: { handle: "ap_X" } }])).toEqual({ decision: "match", fingerprint: human.fingerprint, entry: null });
  });
  it("flags a different credential: an agent's passkey cannot approve once a human's is pinned", () => {
    const result = checkApprover(agent, [pinOf(human)]);
    expect(result.decision).toBe("flag");
    expect(result.entry).toEqual({ kind: "approver_flag", body: { fingerprint: agent.fingerprint, credential_id: "Y3JlZC0y", credential_public_key: agent.publicKey } });
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
    const forged: VerifiedCredential = { ...human };
    expect(() => checkApprover(forged, [])).toThrow(TypeError);
  });
});
