// Test signers for the trust module: the published test seeds of vectors s1, d1 and e1 (TEST KEYS ONLY), plus fresh
// passkeys, so attack cases can be correctly signed and fail exactly the check under test.
import { constants, createHash, createPrivateKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../../src/jcs/index.ts";

const vectors = join(import.meta.dirname, "..", "..", "contract", "vectors");
export const loadVector = (name: string): unknown => JSON.parse(readFileSync(join(vectors, name), "utf8"));

/** A copy of `value` without the named members. */
export function without<T extends object>(value: T, ...names: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !names.includes(k))) as Partial<T>;
}

export interface StatementVector {
  input: { root_kid: string; root_seed_hex: string; key_seeds_hex: Record<string, string>; unsigned: Record<string, unknown> };
  expected: { root_public_key_b64url: string; signing_input: string; statement: Record<string, unknown>; valid_at: number };
  refusals: { name: string; statement: Record<string, unknown>; now: number }[];
}
export const S1 = loadVector("s1-key-statement.json") as StatementVector;

/** An Ed25519 private key from its 32-byte seed. */
export function ed25519Seed(hex: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${hex}`, "hex"), format: "der", type: "pkcs8" });
}

export const ROOT = ed25519Seed(S1.input.root_seed_hex);
export const seedOf = (kid: string): KeyObject => ed25519Seed(S1.input.key_seeds_hex[kid] ?? "");
export const PINNED = [{ kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: S1.expected.root_public_key_b64url } }];
export const at = (unixSeconds: number): Date => new Date(unixSeconds * 1000);
export const STATEMENT_VALID_AT = at(S1.expected.valid_at);

/** A statement signed by `root` (default: the s1 root), from s1's unsigned fields with `changes` applied. */
export function signStatement(changes: Record<string, unknown> = {}, root: KeyObject = ROOT): Record<string, unknown> {
  const unsigned = { ...S1.input.unsigned, kid: "cloud-root-1", ...changes };
  const signature = sign(null, Buffer.from(`intent-statement-v1\n${canonicalize(unsigned)}`, "utf8"), root).toString("base64url");
  return { ...unsigned, signature };
}

/** The Intent-Receipt and Intent-Receipt-Signature values for `receipt` (or raw text), signed by `key`. */
export function signReceipt(receipt: unknown, key: KeyObject = seedOf("cloud-receipt-202610")): { receipt: string; signature: string } {
  const text = typeof receipt === "string" ? receipt : canonicalize(receipt);
  const bytes = Buffer.from(text, "utf8");
  return {
    receipt: bytes.toString("base64url"),
    signature: sign(null, Buffer.concat([Buffer.from("intent-receipt-v1\n"), bytes]), key).toString("base64url"),
  };
}

/** A software passkey with the two algorithms Appendix E allows. */
export class TestPasskey {
  readonly alg: "ES256" | "RS256";
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, string>;
  constructor(alg: "ES256" | "RS256") {
    this.alg = alg;
    const pair = alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.jwk =
      alg === "ES256" ? { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "", alg } : { kty: "RSA", n: jwk.n ?? "", e: jwk.e ?? "", alg };
  }
  sign(data: Buffer): Buffer {
    return this.alg === "ES256"
      ? sign("sha256", data, { key: this.privateKey, dsaEncoding: "der" })
      : sign("sha256", data, { key: this.privateKey, padding: constants.RSA_PKCS1_PADDING });
  }
}

export interface ProofVector {
  input: { approval_handle: string; valid_at: number };
  expected: { proof: Record<string, unknown>; signing_input: string; challenge?: string; client_data_json?: string };
  refusals: { name: string; step: number; proof: Record<string, unknown>; approval_handle?: string }[];
}
export const E1 = loadVector("e1-approval-proof.json") as ProofVector;
export const SNAPSHOT = E1.expected.proof.snapshot as Record<string, unknown>;
export const SNAPSHOT_HASH = E1.expected.proof.snapshot_hash as string;

const sha256 = (data: string | Buffer): Buffer => createHash("sha256").update(data).digest();
/** challenge("approve" | "reject") of Appendix A, computed here independently of src/trust. */
export const challengeFor = (action: string, snapshotHash: string): string =>
  sha256(`{"action":"${action}","snapshot_hash":"${snapshotHash}"}`).toString("base64url");

export interface ProofOptions {
  passkey?: TestPasskey;
  snapshot?: Record<string, unknown>;
  snapshotHash?: string;
  handle?: string;
  /** Merged over the default clientData object; a value of undefined removes the member. */
  clientData?: Record<string, unknown>;
  /** Raw clientDataJSON text, replacing clientData. */
  clientDataText?: string;
  /** Raw clientDataJSON bytes, replacing clientData and clientDataText. */
  clientDataBytes?: Buffer;
  rpId?: string;
  flags?: number;
  authenticatorData?: Buffer;
  /** Sign these bytes instead of authenticatorData || SHA-256(clientDataJSON). */
  signOver?: Buffer;
  /** Replace the assertion signature after signing. */
  assertionSignature?: Buffer;
  credentialPublicKey?: Record<string, unknown>;
  kid?: string;
  cloudKey?: KeyObject;
}

/** A proof for the e1 snapshot, asserted by `passkey` and cloud-signed, with each check's input overridable. */
export function makeProof(opts: ProofOptions = {}): Record<string, unknown> {
  const passkey = opts.passkey ?? new TestPasskey("ES256");
  const snapshotHash = opts.snapshotHash ?? SNAPSHOT_HASH;
  const clientData: Record<string, unknown> = {
    type: "webauthn.get",
    challenge: challengeFor("approve", snapshotHash),
    origin: "https://confirm.example",
    crossOrigin: false,
    ...opts.clientData,
  };
  const clientDataJson = opts.clientDataBytes ?? Buffer.from(opts.clientDataText ?? JSON.stringify(clientData), "utf8");
  const authData =
    opts.authenticatorData ?? Buffer.concat([sha256(opts.rpId ?? "example"), Buffer.from([opts.flags ?? 0x05]), Buffer.alloc(4)]);
  const signed = opts.signOver ?? Buffer.concat([authData, sha256(clientDataJson)]);
  const unsigned = {
    v: 1,
    approval_handle: opts.handle ?? "ap_TEST0001",
    snapshot: opts.snapshot ?? SNAPSHOT,
    snapshot_hash: snapshotHash,
    assertion: {
      credential_id: "Y3JlZC0y",
      authenticator_data: authData.toString("base64url"),
      client_data_json: clientDataJson.toString("base64url"),
      signature: (opts.assertionSignature ?? passkey.sign(signed)).toString("base64url"),
    },
    credential_public_key: opts.credentialPublicKey ?? passkey.jwk,
    ledger: { seq: 1, entry_hash: "da66f0d35b6b4aac1ce54a0945d104a5a8db003cebd072c478a10c020f076d4e" },
    issued_at: "2026-10-03T12:05:01Z",
    kid: opts.kid ?? "cloud-approval-202610",
  };
  const cloudKey = opts.cloudKey ?? seedOf("cloud-approval-202610");
  const cloud_signature = sign(null, Buffer.from(`intent-approval-v1\n${canonicalize(unsigned)}`, "utf8"), cloudKey).toString("base64url");
  return { ...unsigned, cloud_signature };
}

/** The approval_pending entry the gateway chains when it asks for approval. */
export const pendingEntry = (handle = "ap_TEST0001", snapshotHash = SNAPSHOT_HASH) => ({
  kind: "approval_pending",
  body: { handle, approval_url: "https://confirm.example/c/abcdefghijklmnop", snapshot_hash: snapshotHash },
});
