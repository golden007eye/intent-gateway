// The fake's signing keys: the published test seeds of vector s1 (root, receipt and approval keys, which d1 and e1
// also use). TEST KEYS ONLY: anyone can sign with them, so nothing outside tests may trust them.
import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize } from "../jcs/index.ts";
import type { KeyStatement, StatementKey } from "../contract/index.ts";

export const RECEIPT_PREFIX = "intent-receipt-v1\n";
export const APPROVAL_PREFIX = "intent-approval-v1\n";
export const STATEMENT_PREFIX = "intent-statement-v1\n";

export const CONFIRM_ORIGIN = "https://confirm.example";
export const RP_ID = "example";

const DAY = 86_400;
const STATEMENT_LIFETIME_DAYS = 90;

interface S1 {
  input: { root_kid: string; root_seed_hex: string; key_seeds_hex: Record<string, string> };
}

// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SigningKey {
  readonly kid: string;
  /** base64url (no padding) of the raw 32-byte public key. */
  readonly x: string;
  sign(bytes: string): string;
}

function signingKey(kid: string, privateKey: KeyObject): SigningKey {
  const x = privateKey.export({ format: "jwk" }).x;
  if (typeof x !== "string") throw new Error("Ed25519 key without a public part");
  return { kid, x, sign: (bytes) => sign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url") };
}

function fromSeed(kid: string, seedHex: string): SigningKey {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, "hex")]);
  return signingKey(kid, createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
}

/** A fresh Ed25519 key under any kid: for tampered artefacts signed by a key nobody published. */
export function randomKey(kid: string): SigningKey {
  return signingKey(kid, generateKeyPairSync("ed25519").privateKey);
}

export interface FakeKeys {
  readonly root: SigningKey;
  /** Every statement key, in the s1 order: receipt current and next, approval current and next. */
  readonly listed: readonly SigningKey[];
  /** The key that signs receipts (d1). */
  readonly receipt: SigningKey;
  /** The key that signs approval proofs (e1). */
  readonly approval: SigningKey;
}

/** Loads the s1 test seeds from the vendored contract. */
export function loadKeys(): FakeKeys {
  const s1 = JSON.parse(readFileSync(new URL("../../contract/vectors/s1-key-statement.json", import.meta.url), "utf8")) as S1;
  const listed = Object.entries(s1.input.key_seeds_hex).map(([kid, seed]) => fromSeed(kid, seed));
  const find = (kid: string): SigningKey => {
    const key = listed.find((k) => k.kid === kid);
    if (key === undefined) throw new Error(`s1 has no ${kid}`);
    return key;
  };
  return {
    root: fromSeed(s1.input.root_kid, s1.input.root_seed_hex),
    listed,
    receipt: find("cloud-receipt-202610"),
    approval: find("cloud-approval-202610"),
  };
}

/** RFC 3339 UTC with seconds and `Z`, from integer seconds. */
export function timestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A key statement (appendix F) issued at the start of the UTC day of `now` and valid for 90 days, signed by
 * `signer` under the root kid. On 2026-09-01 this is byte for byte the s1 statement.
 */
export function makeStatement(keys: FakeKeys, now: number, signer: SigningKey = keys.root, issuedDaysAgo = 0): KeyStatement {
  const issued = Math.floor(now / DAY) * DAY - issuedDaysAgo * DAY;
  const listed: StatementKey[] = keys.listed.map((k) => ({ kid: k.kid, kty: "OKP", crv: "Ed25519", x: k.x }));
  const unsigned = {
    v: 1 as const,
    keys: listed,
    confirm_origin: CONFIRM_ORIGIN,
    rp_id: RP_ID,
    issued_at: timestamp(issued),
    expires_at: timestamp(issued + STATEMENT_LIFETIME_DAYS * DAY),
    kid: keys.root.kid,
  };
  return { ...unsigned, signature: signer.sign(STATEMENT_PREFIX + canonicalize(unsigned)) };
}
