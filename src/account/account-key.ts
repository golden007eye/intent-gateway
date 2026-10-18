// The account key (ADR-0020): an Ed25519 key `intent init` makes once in the data dir, file mode 0600. Its public half
// goes in each checkout the gateway submits (`account_key`), and it signs a Pause. It is never overwritten: a file
// that is there but does not read as an account key is an error, never replaced, because a new key would no longer
// match the one Intent Cloud knows.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign as edSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The file in the data dir that holds the account key, as a private JWK. */
export const ACCOUNT_KEY_FILE = "account-key.json";

/** The public half, as Intent Cloud receives it. */
export interface AccountPublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

export interface AccountKey {
  /** The file the key is kept in. */
  readonly path: string;
  readonly publicJwk: AccountPublicJwk;
  /** RFC 7638 thumbprint of publicJwk: base64url of the sha256 of {"crv","kty","x"} in that order, no spaces. */
  readonly thumbprint: string;
  /** An Ed25519 signature of `bytes` (64 bytes). */
  sign(bytes: Uint8Array): Uint8Array;
}

/** The account key file is there but is not an account key; it is left as it is. The message never holds key bytes. */
export class AccountKeyError extends Error {
  override name = "AccountKeyError";
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** RFC 7638 thumbprint of an Ed25519 public JWK (RFC 8037 §2: the required members are crv, kty and x). */
export function jwkThumbprint(jwk: AccountPublicJwk): string {
  const members = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)}}`;
  return createHash("sha256").update(members, "utf8").digest("base64url");
}

/**
 * The account key of `dataDir`, made first when there is none (`created: true`). The data dir is created (mode 0700)
 * when missing. The file is written with exclusive create, so two gateways starting at once never both write one.
 */
export async function ensureAccountKey(dataDir: string): Promise<{ key: AccountKey; created: boolean }> {
  const existing = await loadAccountKey(dataDir);
  if (existing !== null) return { key: existing, created: false };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const text = `${JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d })}\n`;
  try {
    await writeFile(join(dataDir, ACCOUNT_KEY_FILE), text, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Another process made it between the read and the write: use that one.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await loadAccountKey(dataDir);
    if (raced === null) throw error;
    return { key: raced, created: false };
  }
  const made = await loadAccountKey(dataDir);
  if (made === null) throw new AccountKeyError(`the account key ${join(dataDir, ACCOUNT_KEY_FILE)} was written but cannot be read back`);
  return { key: made, created: true };
}

/** The account key of `dataDir`, or null when there is none yet. Throws AccountKeyError when the file is not one. */
export async function loadAccountKey(dataDir: string): Promise<AccountKey | null> {
  const path = join(dataDir, ACCOUNT_KEY_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return accountKeyFrom(path, text);
}

function accountKeyFrom(path: string, text: string): AccountKey {
  const bad = new AccountKeyError(`${path} is not an account key (an Ed25519 private JWK); it was left as it is: move it away to make a new one`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw bad;
  }
  const { kty, crv, x, d } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || typeof d !== "string" || !B64URL_32.test(x) || !B64URL_32.test(d)) throw bad;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: { kty, crv, x, d }, format: "jwk" });
  } catch {
    throw bad;
  }
  // x must be the public half of d: a file whose two halves disagree would sign for a key nobody registered.
  if (createPublicKey(privateKey).export({ format: "jwk" }).x !== x) throw bad;
  const publicJwk: AccountPublicJwk = { kty: "OKP", crv: "Ed25519", x };
  return {
    path,
    publicJwk,
    thumbprint: jwkThumbprint(publicJwk),
    sign: (bytes) => new Uint8Array(edSign(null, bytes, privateKey)),
  };
}
