// SoftPasskey against vector e1: its assertion has e1's structure byte for byte (authenticatorData, clientDataJSON),
// and the confirm-page check accepts e1's real assertions and refuses each step-4–6 refusal. Expected values come
// from the vector files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialPublicKey, type ApprovalProof, WebAuthnAssertion } from "../contract/index.ts";
import { assertionProblem, challengeFor, CONFIRM_ORIGIN, RP_ID, SoftPasskey } from "./index.ts";

const vectors = join(import.meta.dirname, "..", "..", "contract", "vectors");
const load = (name: string): unknown => JSON.parse(readFileSync(join(vectors, name), "utf8"));

interface E1 {
  input: { confirm_origin: string; rp_id: string };
  expected: { proof: ApprovalProof; challenge: string; client_data_json: string; authenticator_data_hex: string };
  refusals: { name: string; step: number; proof: ApprovalProof }[];
}
interface A1 {
  expected: { snapshot_hash: string; challenge: { approve: string; reject: string } };
}

const e1 = load("e1-approval-proof.json") as E1;
const e1rs = load("e1-rs256-approval-proof.json") as E1;
const a1 = load("a1-snapshot.json") as A1;
const expected = { rpId: e1.input.rp_id, origin: e1.input.confirm_origin, challenge: e1.expected.challenge };

describe("challengeFor", () => {
  it("reproduces vector a1's approve and reject challenges", () => {
    expect(challengeFor("approve", a1.expected.snapshot_hash)).toBe(a1.expected.challenge.approve);
    expect(challengeFor("reject", a1.expected.snapshot_hash)).toBe(a1.expected.challenge.reject);
  });
});

describe("SoftPasskey", () => {
  it("uses the vectors' confirm origin and rp_id", () => {
    expect(CONFIRM_ORIGIN).toBe(e1.input.confirm_origin);
    expect(RP_ID).toBe(e1.input.rp_id);
  });

  for (const alg of ["ES256", "RS256"] as const) {
    it(`${alg}: produces e1's authenticatorData and clientDataJSON bytes and a signature that verifies`, () => {
      const passkey = new SoftPasskey({ alg });
      const assertion = passkey.assert(expected);
      expect(WebAuthnAssertion.parse(assertion)).toEqual(assertion);
      expect(CredentialPublicKey.parse(passkey.publicJwk).alg).toBe(alg);
      expect(Buffer.from(assertion.authenticator_data, "base64url").toString("hex")).toBe(e1.expected.authenticator_data_hex);
      expect(Buffer.from(assertion.client_data_json, "base64url").toString("utf8")).toBe(e1.expected.client_data_json);
      expect(assertionProblem(assertion, passkey.publicJwk, expected)).toBeNull();
    });
  }

  it("ES256 signatures are DER-encoded, like e1's", () => {
    const sig = Buffer.from(new SoftPasskey().assert(expected).signature, "base64url");
    expect(sig[0]).toBe(0x30);
    expect(sig[1]).toBe(sig.length - 2);
  });

  it("keeps its private key out of JSON and enumeration", () => {
    const passkey = new SoftPasskey();
    expect(Object.keys(passkey).sort()).toEqual(["alg", "credentialId", "publicJwk", "sub"]);
    expect(JSON.stringify(passkey)).not.toMatch(/"d"/);
  });

  it("can be told to send another flag byte, type or crossOrigin, which the check refuses", () => {
    const passkey = new SoftPasskey();
    const key = passkey.publicJwk;
    expect(assertionProblem(passkey.assert({ ...expected, flags: 0x01 }), key, expected)).toMatch(/verification/);
    expect(assertionProblem(passkey.assert({ ...expected, flags: 0x04 }), key, expected)).toMatch(/presence/);
    expect(assertionProblem(passkey.assert({ ...expected, type: "webauthn.create" }), key, expected)).toMatch(/type/);
    expect(assertionProblem(passkey.assert({ ...expected, crossOrigin: true }), key, expected)).toMatch(/crossOrigin/);
    expect(assertionProblem(passkey.assert({ ...expected, rpId: "evil.example" }), key, expected)).toMatch(/rpIdHash/);
    expect(assertionProblem(passkey.assert(expected), new SoftPasskey().publicJwk, expected)).toMatch(/signature/);
  });
});

describe("assertionProblem (the confirm page's check)", () => {
  it("accepts e1's ES256 and RS256 assertions", () => {
    for (const v of [e1, e1rs]) {
      expect(assertionProblem(v.expected.proof.assertion, v.expected.proof.credential_public_key, expected)).toBeNull();
    }
  });

  // Steps 4–6 are the assertion checks; the other refusals (cloud signature, kid, hash, handle) are the gateway's.
  for (const refusal of e1.refusals.filter((r) => r.step >= 4)) {
    it(`refuses e1 "${refusal.name}" (step ${String(refusal.step)})`, () => {
      expect(assertionProblem(refusal.proof.assertion, refusal.proof.credential_public_key, expected)).not.toBeNull();
    });
  }

  it("refuses clientDataJSON that is not a JSON object", () => {
    const passkey = new SoftPasskey();
    const good = passkey.assert(expected);
    for (const text of ["not json", "[1]", "null"]) {
      const bad = { ...good, client_data_json: Buffer.from(text).toString("base64url") };
      expect(assertionProblem(bad, passkey.publicJwk, expected)).toMatch(/clientDataJSON/);
    }
  });

  it("refuses short authenticatorData", () => {
    const passkey = new SoftPasskey();
    const bad = { ...passkey.assert(expected), authenticator_data: Buffer.alloc(36).toString("base64url") };
    expect(assertionProblem(bad, passkey.publicJwk, expected)).toMatch(/37 bytes/);
  });
});
