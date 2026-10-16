// A software passkey (ES256 or RS256) that answers a WebAuthn `get` the way a platform authenticator would, and the
// check the confirm page runs on its assertion (appendix E steps 4–6). For tests and the demo confirm page only.
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign, verify } from "node:crypto";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import type { CredentialPublicKey, WebAuthnAssertion } from "../contract/index.ts";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

export type Action = "approve" | "reject";

/** `challenge(action)` of appendix A: base64url(SHA-256(JCS({action, snapshot_hash}))). */
export function challengeFor(action: Action, snapshotHash: string): string {
  const digest = Buffer.from(sha256Hex(canonicalize({ action, snapshot_hash: snapshotHash })), "hex");
  return digest.toString("base64url");
}

export interface AssertOptions {
  rpId: string;
  origin: string;
  challenge: string;
  /** Authenticator flags; default UP|UV (0x05). */
  flags?: number;
  /** clientDataJSON `type`; default `webauthn.get`. */
  type?: string;
  /** clientDataJSON `crossOrigin`; default false. */
  crossOrigin?: boolean;
}

export interface SoftPasskeyOptions {
  alg?: "ES256" | "RS256";
  /** base64url credential id; default 16 random bytes. */
  credentialId?: string;
  /** The account the passkey belongs to on the confirm page; becomes `claimed_by`. Default a fresh one. */
  sub?: string;
  /** The authenticator's signature counter; default 0 (as platform passkeys and vector e1 report). */
  signCount?: number;
  /** An existing P-256 private key (ES256), so a passkey can outlive one process (the demo keeps one per data dir). */
  privateKey?: KeyObject;
}

/** A passkey held in memory. Its private key never leaves the instance. */
export class SoftPasskey {
  readonly alg: "ES256" | "RS256";
  readonly credentialId: string;
  readonly sub: string;
  readonly publicJwk: CredentialPublicKey;
  readonly #privateKey: KeyObject;
  readonly #signCount: number;

  constructor(options: SoftPasskeyOptions = {}) {
    this.alg = options.alg ?? "ES256";
    this.credentialId = options.credentialId ?? randomBytes(16).toString("base64url");
    this.sub = options.sub ?? `user-${randomBytes(8).toString("hex")}`;
    this.#signCount = options.signCount ?? 0;
    if (options.privateKey !== undefined && (this.alg !== "ES256" || options.privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1")) {
      throw new TypeError("a given passkey private key must be P-256 (ES256)");
    }
    const pair =
      options.privateKey !== undefined
        ? { privateKey: options.privateKey, publicKey: createPublicKey(options.privateKey) }
        : this.alg === "ES256"
          ? generateKeyPairSync("ec", { namedCurve: "P-256" })
          : generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.publicJwk =
      this.alg === "ES256"
        ? { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y), alg: "ES256" }
        : { kty: "RSA", n: String(jwk.n), e: String(jwk.e), alg: "RS256" };
  }

  /** The assertion for one WebAuthn `get`: authenticatorData, clientDataJSON and the signature over both. */
  assert(options: AssertOptions): WebAuthnAssertion {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#signCount);
    const authenticatorData = Buffer.concat([
      createHash("sha256").update(options.rpId, "utf8").digest(),
      Buffer.of(options.flags ?? FLAG_UP | FLAG_UV),
      counter,
    ]);
    const clientDataJson = Buffer.from(
      JSON.stringify({
        type: options.type ?? "webauthn.get",
        challenge: options.challenge,
        origin: options.origin,
        crossOrigin: options.crossOrigin ?? false,
      }),
      "utf8",
    );
    const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJson).digest()]);
    // ES256: ECDSA P-256 with a DER signature (node's default encoding); RS256: RSASSA-PKCS1-v1_5.
    const signature = sign("sha256", signed, this.#privateKey);
    return {
      credential_id: this.credentialId,
      authenticator_data: authenticatorData.toString("base64url"),
      client_data_json: clientDataJson.toString("base64url"),
      signature: signature.toString("base64url"),
    };
  }
}

export interface ExpectedAssertion {
  rpId: string;
  origin: string;
  challenge: string;
}

/**
 * The confirm page's check of an assertion, appendix E steps 4–6: clientDataJSON, authenticatorData and the
 * signature under the credential key. Returns the failing step's reason, or null when the assertion is valid.
 */
export function assertionProblem(assertion: WebAuthnAssertion, key: CredentialPublicKey, expected: ExpectedAssertion): string | null {
  const clientDataJson = Buffer.from(assertion.client_data_json, "base64url");
  let clientData: unknown;
  try {
    clientData = JSON.parse(clientDataJson.toString("utf8"));
  } catch {
    return "clientDataJSON is not JSON";
  }
  if (typeof clientData !== "object" || clientData === null || Array.isArray(clientData)) return "clientDataJSON is not an object";
  const c = clientData as Record<string, unknown>;
  if (c.type !== "webauthn.get") return "clientDataJSON type is not webauthn.get";
  if (c.challenge !== expected.challenge) return "clientDataJSON challenge does not match";
  if (c.origin !== expected.origin) return "clientDataJSON origin does not match";
  if (c.crossOrigin !== undefined && c.crossOrigin !== false) return "clientDataJSON crossOrigin is set";

  const authenticatorData = Buffer.from(assertion.authenticator_data, "base64url");
  if (authenticatorData.length < 37) return "authenticatorData is shorter than 37 bytes";
  const rpIdHash = createHash("sha256").update(expected.rpId, "utf8").digest();
  if (!authenticatorData.subarray(0, 32).equals(rpIdHash)) return "authenticatorData rpIdHash does not match";
  const flags = authenticatorData[32] ?? 0;
  if ((flags & FLAG_UP) === 0) return "user presence flag is off";
  if ((flags & FLAG_UV) === 0) return "user verification flag is off";

  const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJson).digest()]);
  const publicKey = createPublicKey({ key: { ...key }, format: "jwk" });
  const ok = verify("sha256", signed, publicKey, Buffer.from(assertion.signature, "base64url"));
  return ok ? null : "passkey signature does not verify";
}
