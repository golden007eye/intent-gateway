// The session key and the signer. The private key lives in a module-private WeakMap, so a Session object carries
// no key material: JSON.stringify, util.inspect and property enumeration see only the keyid.
import { createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { contentDigest, decodeNonce, LABEL, MIN_NONCE_BYTES, signatureBase, signatureParams } from "./profile.ts";

export class SigningError extends Error {
  override name = "SigningError";
}

/** One shopping session's identity: the self-certifying keyid of an in-memory Ed25519 key. */
export interface Session {
  readonly keyid: string;
}

export interface SignInput {
  method: string;
  /** Absolute path without query or fragment. */
  path: string;
  body: Uint8Array;
  /** Integer seconds; defaults to the current time. */
  created?: number;
  /** base64 or base64url of at least 16 bytes; defaults to 16 fresh random bytes. */
  nonce?: string;
}

// A type alias, not an interface, so it is assignable to a plain header record.
export type SignedHeaders = {
  "content-digest": string;
  "signature-input": string;
  signature: string;
};

const privateKeys = new WeakMap<Session, KeyObject>();
// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function makeSession(privateKey: KeyObject): Session {
  const x = privateKey.export({ format: "jwk" }).x;
  if (typeof x !== "string") throw new SigningError("Ed25519 key without a public part");
  const session: Session = Object.freeze({ keyid: `gw-${x}` });
  privateKeys.set(session, privateKey);
  return session;
}

/** A fresh session: a new Ed25519 key pair whose private half never leaves this module. */
export function createSession(): Session {
  return makeSession(generateKeyPairSync("ed25519").privateKey);
}

/** A session from a fixed 32-byte seed. For published test vectors (c2) and the fake Cloud only. */
export function sessionFromSeed(seed: Uint8Array): Session {
  if (seed.length !== 32) throw new SigningError("Ed25519 seed must be 32 bytes");
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return makeSession(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
}

/** Signs one request under the appendix-C profile and returns the three headers to send. */
export function signRequest(session: Session, input: SignInput): SignedHeaders {
  const key = privateKeys.get(session);
  if (key === undefined) throw new SigningError("not a session made by createSession");
  if (!/^[A-Z]+$/.test(input.method)) throw new SigningError("method must be an uppercase token");
  if (!/^\/[\x21-\x7e]*$/.test(input.path) || /[?#]/.test(input.path)) {
    throw new SigningError("path must be absolute, without query or fragment");
  }
  const created = input.created ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(created) || created < 0) throw new SigningError("created must be integer seconds");
  const nonce = input.nonce ?? randomBytes(MIN_NONCE_BYTES).toString("base64url");
  const nonceBytes = decodeNonce(nonce);
  if (nonceBytes === null || nonceBytes.length < MIN_NONCE_BYTES) {
    throw new SigningError(`nonce must be base64 of at least ${String(MIN_NONCE_BYTES)} bytes`);
  }
  const digest = contentDigest(input.body);
  const params = signatureParams(created, nonce, session.keyid);
  const signature = sign(null, Buffer.from(signatureBase(input.method, input.path, digest, params)), key);
  return {
    "content-digest": digest,
    "signature-input": `${LABEL}=${params}`,
    signature: `${LABEL}=:${signature.toString("base64")}:`,
  };
}
