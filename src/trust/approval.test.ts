// Appendix E and invariant 4: approval proofs. Vectors e1 and e1-rs256 (computed by Intent Cloud) must verify and
// each of their refusals must fail the step it names. The attack cases below are built with fresh passkeys and the
// published e1 test approval key, so each is correctly signed and fails exactly the check under test.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  at,
  challengeFor,
  E1,
  loadVector,
  makeProof,
  PINNED,
  type ProofVector,
  pendingEntry,
  S1,
  SNAPSHOT,
  SNAPSHOT_HASH,
  seedOf,
  signStatement,
  TestPasskey,
} from "../../test/support/trust-kit.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { type ApprovalResult, approvalChallenge, type ChainEntry, type KeySet, verifyApprovalProof, verifyStatement } from "./index.ts";

const E1_RS256 = loadVector("e1-rs256-approval-proof.json") as ProofVector;
const now = at(E1.input.valid_at);

function keySetFrom(statement: unknown, when: Date = now): KeySet {
  const result = verifyStatement(statement, PINNED, when);
  if (!result.ok) throw new Error(`statement did not verify: ${result.reason}`);
  return result.keySet;
}
const keySet = keySetFrom(S1.expected.statement);

const display = { merchant: "Trail Supply Co (mock)", title: "Trail Runner 3", total: { amount_minor: 9499, currency: "USD" } };
const approved = (proof: unknown, state = "approved") => ({ state, display, proof });
const check = (proof: unknown, opts: { pending?: ChainEntry; chain?: ChainEntry[]; keys?: KeySet; when?: Date; state?: string } = {}): ApprovalResult =>
  verifyApprovalProof(approved(proof, opts.state), opts.pending ?? pendingEntry(), opts.keys ?? keySet, opts.chain ?? [], opts.when ?? now);
const refused = (step: number | null, reason: string) => ({ ok: false, step, reason });

describe("verifyApprovalProof: vectors", () => {
  for (const [name, vector] of [
    ["e1 (ES256)", E1],
    ["e1-rs256 (RS256)", E1_RS256],
  ] as const) {
    it(`verifies ${name}`, () => {
      const result = check(vector.expected.proof);
      expect(result).toMatchObject({ ok: true, handle: "ap_TEST0001", snapshotHash: SNAPSHOT_HASH, issuedAt: "2026-10-03T12:05:01Z" });
      if (!result.ok) return;
      expect(result.credential.id).toBe("Y3JlZC0x");
      expect(result.credential.publicKey).toEqual(vector.expected.proof.credential_public_key);
      expect(result.credential.fingerprint).toMatch(/^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);
      expect(result.ledger).toEqual(vector.expected.proof.ledger);
    });
    for (const state of ["handed_off", "ordered"]) {
      it(`verifies ${name} in state ${state}`, () => {
        expect(check(vector.expected.proof, { state }).ok).toBe(true);
      });
    }
  }

  it("computes the e1 approve challenge and the a1 reject challenge", () => {
    expect(approvalChallenge("approve", SNAPSHOT_HASH)).toBe(E1.expected.challenge);
    expect(approvalChallenge("reject", SNAPSHOT_HASH)).toBe("1sHSAuRNfPzV9vEcsLn8d63NeKu4op7ITcZubH7JVqc");
  });

  const reasons: Record<string, string> = {
    "assertion over the reject challenge": "wrong_challenge",
    "wrong origin": "wrong_origin",
    "crossOrigin true": "cross_origin",
    "type webauthn.create": "wrong_type",
    "rpIdHash of another rp_id": "wrong_rp_id",
    "user verification flag off": "user_not_verified",
    "user presence flag off": "user_not_present",
    "passkey signature over other data": "bad_assertion_signature",
    "cloud_signature altered": "bad_signature",
    "kid not in the statement": "unknown_kid",
    "snapshot changed, hash kept": "snapshot_hash_mismatch",
    "proof for another approval": "handle_mismatch",
    "ES256 alg on an RSA key": "schema",
  };
  for (const [name, vector] of [
    ["e1", E1],
    ["e1-rs256", E1_RS256],
  ] as const) {
    for (const r of vector.refusals) {
      it(`${name} refuses at step ${String(r.step)}: ${r.name}`, () => {
        const pending = pendingEntry(r.approval_handle ?? "ap_TEST0001");
        expect(check(r.proof, { pending })).toEqual(refused(r.step, reasons[r.name] ?? "unlisted refusal"));
      });
    }
  }
});

describe("verifyApprovalProof: attacks on the passkey assertion", () => {
  it("accepts a freshly built proof (the baseline every case below changes once)", () => {
    expect(check(makeProof()).ok).toBe(true);
    expect(check(makeProof({ passkey: new TestPasskey("RS256") })).ok).toBe(true);
    expect(check(makeProof({ clientData: { crossOrigin: undefined } })).ok).toBe(true);
  });
  it("refuses an assertion over the reject challenge", () => {
    expect(check(makeProof({ clientData: { challenge: challengeFor("reject", SNAPSHOT_HASH) } }))).toEqual(refused(4, "wrong_challenge"));
  });
  it("refuses an assertion over another snapshot's challenge", () => {
    expect(check(makeProof({ clientData: { challenge: challengeFor("approve", "0".repeat(64)) } }))).toEqual(refused(4, "wrong_challenge"));
  });
  it("refuses a wrong origin, including the origin a phishing page would have", () => {
    expect(check(makeProof({ clientData: { origin: "https://confirm.example.evil" } }))).toEqual(refused(4, "wrong_origin"));
    expect(check(makeProof({ clientData: { origin: "http://confirm.example" } }))).toEqual(refused(4, "wrong_origin"));
    expect(check(makeProof({ clientData: { origin: undefined } }))).toEqual(refused(4, "wrong_origin"));
  });
  it("refuses crossOrigin true, or any value but false", () => {
    expect(check(makeProof({ clientData: { crossOrigin: true } }))).toEqual(refused(4, "cross_origin"));
    expect(check(makeProof({ clientData: { crossOrigin: "false" } }))).toEqual(refused(4, "cross_origin"));
    expect(check(makeProof({ clientData: { crossOrigin: null } }))).toEqual(refused(4, "cross_origin"));
  });
  it("refuses a create() ceremony", () => {
    expect(check(makeProof({ clientData: { type: "webauthn.create" } }))).toEqual(refused(4, "wrong_type"));
  });
  it("refuses clientDataJSON that is not a JSON object", () => {
    expect(check(makeProof({ clientDataText: "[1]" }))).toEqual(refused(4, "bad_client_data"));
    expect(check(makeProof({ clientDataText: "null" }))).toEqual(refused(4, "bad_client_data"));
    expect(check(makeProof({ clientDataText: "{" }))).toEqual(refused(4, "bad_client_data"));
    expect(check(makeProof({ clientDataBytes: Buffer.from([0xc3, 0x28]) }))).toEqual(refused(4, "bad_client_data"));
  });
  it("refuses UV off and UP off", () => {
    expect(check(makeProof({ flags: 0x01 }))).toEqual(refused(5, "user_not_verified"));
    expect(check(makeProof({ flags: 0x04 }))).toEqual(refused(5, "user_not_present"));
    expect(check(makeProof({ flags: 0x00 }))).toEqual(refused(5, "user_not_present"));
  });
  it("refuses the rpIdHash of another rp_id", () => {
    expect(check(makeProof({ rpId: "evil.example" }))).toEqual(refused(5, "wrong_rp_id"));
    expect(check(makeProof({ rpId: "confirm.example" }))).toEqual(refused(5, "wrong_rp_id"));
  });
  it("refuses authenticatorData shorter than 37 bytes", () => {
    const short = Buffer.concat([createHash("sha256").update("example").digest(), Buffer.from([0x05])]);
    expect(check(makeProof({ authenticatorData: short }))).toEqual(refused(5, "bad_authenticator_data"));
  });
  it("refuses a passkey signature over foreign data", () => {
    expect(check(makeProof({ signOver: Buffer.from("something else") }))).toEqual(refused(6, "bad_assertion_signature"));
    expect(check(makeProof({ passkey: new TestPasskey("RS256"), signOver: Buffer.from("x") }))).toEqual(refused(6, "bad_assertion_signature"));
  });
  it("refuses an assertion by another passkey than the proof's credential key", () => {
    const signer = new TestPasskey("ES256");
    const claimed = new TestPasskey("ES256");
    const authData = Buffer.concat([createHash("sha256").update("example").digest(), Buffer.from([0x05]), Buffer.alloc(4)]);
    const base = makeProof({ passkey: signer, authenticatorData: authData });
    const forged = makeProof({ passkey: signer, authenticatorData: authData, credentialPublicKey: claimed.jwk });
    expect(check(base).ok).toBe(true);
    expect(check(forged)).toEqual(refused(6, "bad_assertion_signature"));
  });
  it("refuses an ES256 signature in raw r||s form instead of DER, and a garbage RS256 signature", () => {
    const passkey = new TestPasskey("ES256");
    const authData = Buffer.concat([createHash("sha256").update("example").digest(), Buffer.from([0x05]), Buffer.alloc(4)]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeFor("approve", SNAPSHOT_HASH), origin: "https://confirm.example" }));
    const data = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
    const raw = sign("sha256", data, { key: passkey.privateKey, dsaEncoding: "ieee-p1363" });
    expect(check(makeProof({ passkey, authenticatorData: authData, clientDataText: clientData.toString(), assertionSignature: raw }))).toEqual(
      refused(6, "bad_assertion_signature"),
    );
    expect(check(makeProof({ passkey: new TestPasskey("RS256"), assertionSignature: Buffer.from("garbage") }))).toEqual(refused(6, "bad_assertion_signature"));
  });
  it("refuses a credential key that is not a point on P-256", () => {
    const passkey = new TestPasskey("ES256");
    const offCurve = { ...passkey.jwk, y: Buffer.alloc(32, 7).toString("base64url") };
    expect(check(makeProof({ passkey, credentialPublicKey: offCurve }))).toEqual(refused(6, "bad_credential_key"));
  });
  it("refuses an RSA passkey whose public exponent is not 65537, even when its assertion signature verifies", () => {
    for (const publicExponent of [3, 17, 65539]) {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent });
      const jwk = pair.publicKey.export({ format: "jwk" });
      const passkey = Object.assign(new TestPasskey("RS256"), { privateKey: pair.privateKey, jwk: { kty: "RSA", n: jwk.n ?? "", e: jwk.e ?? "", alg: "RS256" } });
      expect(check(makeProof({ passkey }))).toEqual(refused(6, "bad_credential_key"));
    }
    // e = 1 makes s^e = s, so a "signature" equal to the padded message verifies under any modulus.
    const rs = new TestPasskey("RS256").jwk;
    for (const e of ["AQ", "AAEAAQ", "AQAA"]) {
      expect(check(makeProof({ credentialPublicKey: { ...rs, e } }))).toEqual(refused(6, "bad_credential_key"));
    }
  });
  it("refuses an RSA modulus under 2048 bits written with leading zero bytes to pass the schema's length", () => {
    const n = Buffer.from(generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" }).n ?? "", "base64url");
    const padded = Buffer.concat([Buffer.alloc(256 - n.length), n]).toString("base64url");
    expect(check(makeProof({ credentialPublicKey: { kty: "RSA", n: padded, e: "AQAB", alg: "RS256" } }))).toEqual(refused(6, "bad_credential_key"));
  });
  it("reads the signature counter from authenticatorData bytes 33-36", () => {
    for (const signCount of [0, 1, 0x01020304, 2 ** 32 - 1]) {
      const result = check(makeProof({ signCount }));
      expect(result.ok && result.credential.signCount).toBe(signCount);
    }
  });
  it("accepts a proof issued after the snapshot expired: Intent Cloud issues it at each read (Appendix E issued_at)", () => {
    const expires = SNAPSHOT.expires_at as string;
    const proof = makeProof();
    const unsigned = { ...proof, issued_at: new Date(Date.parse(expires) + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    delete (unsigned as { cloud_signature?: unknown }).cloud_signature;
    const cloud_signature = sign(null, Buffer.from(`intent-approval-v1\n${canonicalize(unsigned)}`, "utf8"), seedOf("cloud-approval-202610")).toString("base64url");
    expect(Date.parse(unsigned.issued_at)).toBeGreaterThan(Date.parse(expires));
    expect(check({ ...unsigned, cloud_signature }).ok).toBe(true);
  });
  it("refuses every algorithm but ES256 and RS256, and any extra JWK member", () => {
    const ed = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ format: "jwk" });
    const es = new TestPasskey("ES256").jwk;
    const rs = new TestPasskey("RS256").jwk;
    const keys: Record<string, unknown>[] = [
      { kty: "OKP", crv: "Ed25519", x: ed.x, alg: "EdDSA" },
      { kty: "EC", crv: "P-384", x: p384.x, y: p384.y, alg: "ES384" },
      { ...es, alg: "ES384" },
      { ...es, alg: "RS256" },
      { ...rs, alg: "PS256" },
      { ...rs, alg: "ES256" },
      { ...es, kid: "k" },
      { ...es, alg: undefined },
      { kty: "RSA", n: generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" }).n, e: "AQAB", alg: "RS256" },
    ];
    for (const credentialPublicKey of keys) {
      expect(check(makeProof({ credentialPublicKey: JSON.parse(JSON.stringify(credentialPublicKey)) as Record<string, unknown> }))).toEqual(refused(1, "schema"));
    }
  });
});

describe("verifyApprovalProof: attacks on Intent Cloud's signature and the key statement", () => {
  it("refuses a bad Cloud signature: altered, by a receipt key, or by an unlisted key", () => {
    const proof = makeProof();
    const sig = proof.cloud_signature as string;
    expect(check({ ...proof, cloud_signature: `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}` })).toEqual(refused(2, "bad_signature"));
    expect(check(makeProof({ cloudKey: seedOf("cloud-receipt-202610") }))).toEqual(refused(2, "bad_signature"));
    expect(check(makeProof({ cloudKey: generateKeyPairSync("ed25519").privateKey }))).toEqual(refused(2, "bad_signature"));
  });
  it("refuses a field changed after Cloud signed: the credential key swapped for the agent's", () => {
    const proof = makeProof();
    expect(check({ ...proof, credential_public_key: new TestPasskey("ES256").jwk })).toEqual(refused(2, "bad_signature"));
    expect(check({ ...proof, ledger: { seq: 2, entry_hash: "0".repeat(64) } })).toEqual(refused(2, "bad_signature"));
  });
  it("refuses a kid not in the statement", () => {
    expect(check(makeProof({ kid: "cloud-approval-202612" }))).toEqual(refused(2, "unknown_kid"));
  });
  it("accepts the next listed approval key", () => {
    expect(check(makeProof({ kid: "cloud-approval-202611", cloudKey: seedOf("cloud-approval-202611") })).ok).toBe(true);
  });
  it("refuses keys from a statement the pinned root did not sign", () => {
    const attackerRoot = generateKeyPairSync("ed25519").privateKey;
    const attackerApproval = generateKeyPairSync("ed25519");
    const x = attackerApproval.publicKey.export({ format: "jwk" }).x;
    const keys = [...(S1.input.unsigned.keys as object[]).slice(0, 2), { kid: "cloud-approval-202612", kty: "OKP", crv: "Ed25519", x }];
    expect(verifyStatement(signStatement({ keys }, attackerRoot), PINNED, now)).toEqual(refused(2, "bad_signature"));
    // A look-alike key set built by hand is refused too.
    const lookalike = { ...keySet, approvalKeys: new Map([["cloud-approval-202612", attackerApproval.publicKey]]) };
    const proof = makeProof({ kid: "cloud-approval-202612", cloudKey: attackerApproval.privateKey });
    expect(check(proof, { keys: lookalike })).toEqual(refused(2, "not_verified"));
  });
  it("fails closed once the statement has expired", () => {
    expect(check(makeProof(), { when: keySet.expiresAt })).toEqual(refused(2, "statement_expired"));
  });
  it("checks origin and rp_id against the statement, never against other values", () => {
    const st = signStatement({ confirm_origin: "https://approve.example", rp_id: "approve.example" });
    const other = keySetFrom(st);
    expect(check(makeProof(), { keys: other })).toEqual(refused(4, "wrong_origin"));
    expect(check(makeProof({ clientData: { origin: "https://approve.example" } }), { keys: other })).toEqual(refused(5, "wrong_rp_id"));
    expect(check(makeProof({ clientData: { origin: "https://approve.example" }, rpId: "approve.example" }), { keys: other }).ok).toBe(true);
  });
});

describe("verifyApprovalProof: snapshot, handle, state and replay", () => {
  it("refuses a proof whose snapshot_hash is not the one chained in approval_pending (wrong hash)", () => {
    const pending = pendingEntry("ap_TEST0001", "ab".repeat(32));
    expect(check(makeProof(), { pending })).toEqual(refused(3, "not_pending_snapshot"));
  });
  it("refuses a snapshot changed with its hash and challenge recomputed, when the gateway chained the original", () => {
    const snapshot = { ...SNAPSHOT, total: { amount_minor: 1, currency: "USD" } };
    const snapshotHash = sha256Hex(canonicalize(snapshot));
    const proof = makeProof({ snapshot, snapshotHash });
    expect(check(proof, { pending: pendingEntry("ap_TEST0001", snapshotHash) }).ok).toBe(true); // self-consistent …
    expect(check(proof)).toEqual(refused(3, "not_pending_snapshot")); // … but not what the gateway asked about
  });
  it("refuses a snapshot changed with its hash kept", () => {
    const snapshot = { ...SNAPSHOT, quantity: 2 };
    expect(check(makeProof({ snapshot }))).toEqual(refused(3, "snapshot_hash_mismatch"));
  });
  it("refuses a proof for another handle, in the proof or in its snapshot", () => {
    expect(check(makeProof(), { pending: pendingEntry("ap_OTHER0001") })).toEqual(refused(1, "handle_mismatch"));
    expect(check(makeProof({ handle: "ap_OTHER0001" }))).toEqual(refused(1, "handle_mismatch"));
    expect(check(makeProof({ snapshot: { ...SNAPSHOT, approval: "ap_OTHER0001" } }))).toEqual(refused(1, "handle_mismatch"));
  });
  it("refuses a replay: a proof for a handle already chained as approval", () => {
    const chain = [pendingEntry(), { kind: "approval", body: { handle: "ap_TEST0001" } }];
    expect(check(E1.expected.proof, { chain })).toEqual(refused(null, "replay"));
    const otherApproval = [pendingEntry(), { kind: "approval", body: { handle: "ap_OTHER0001" } }, { kind: "approval", body: null }];
    expect(check(E1.expected.proof, { chain: otherApproval }).ok).toBe(true);
  });
  it("refuses a proof while pending, rejected or expired", () => {
    for (const state of ["pending", "rejected", "expired"]) {
      expect(check(E1.expected.proof, { state })).toEqual(refused(null, "proof_in_wrong_state"));
    }
  });
  it("reports pending without a proof as not approved, and approved without a proof as missing", () => {
    expect(verifyApprovalProof({ state: "pending", display }, pendingEntry(), keySet, [], now)).toEqual(refused(null, "not_approved"));
    expect(verifyApprovalProof({ state: "approved", display }, pendingEntry(), keySet, [], now)).toEqual(refused(null, "missing_proof"));
  });
  it("refuses an unknown state or a status that is not an object", () => {
    expect(check(E1.expected.proof, { state: "approved!" })).toEqual(refused(null, "bad_state"));
    expect(verifyApprovalProof(null, pendingEntry(), keySet, [], now)).toEqual(refused(null, "bad_state"));
    expect(verifyApprovalProof("approved", pendingEntry(), keySet, [], now)).toEqual(refused(null, "bad_state"));
  });
  it("refuses a pending entry that is not a chained approval_pending with a handle and snapshot hash", () => {
    const entries: ChainEntry[] = [
      { kind: "approval", body: pendingEntry().body },
      { kind: "approval_pending", body: null },
      { kind: "approval_pending", body: { handle: "ap_TEST0001" } },
      { kind: "approval_pending", body: { handle: "ap_TEST0001", snapshot_hash: SNAPSHOT_HASH.toUpperCase() } },
      { kind: "approval_pending", body: { handle: 1, snapshot_hash: SNAPSHOT_HASH } },
    ];
    for (const pending of entries) expect(check(E1.expected.proof, { pending })).toEqual(refused(null, "bad_pending_entry"));
  });
  it("refuses a proof outside the schema, or with a string that has no canonical form", () => {
    expect(check({ ...E1.expected.proof, buyer: "x" })).toEqual(refused(1, "schema"));
    const proof = makeProof();
    const loneSurrogate = { ...proof, snapshot: { ...SNAPSHOT, merchant: { name: "Trail \ud800", domain: "m.example" } } };
    expect(check(loneSurrogate)).toEqual(refused(1, "schema"));
  });
});
