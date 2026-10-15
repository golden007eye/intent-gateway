// Verifies one Sigstore attestation bundle: the signature (certificate chain to the Fulcio CA, SCT, transparency-log
// inclusion, DSSE signature) through @sigstore/verify, then the signer identity and the in-toto statement, so each
// failure has its own reason.
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";
import { CheckFailure } from "./result.ts";

export const RELEASE_REPOSITORY = "https://github.com/golden007eye/intent-gateway";
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The certificate SAN of a release build (the release workflow at the version's tag); undefined for a non-release version. */
export function releaseIdentity(version: string): string | undefined {
  if (!VERSION.test(version)) return undefined;
  return `${RELEASE_REPOSITORY}/.github/workflows/release.yml@refs/tags/v${version}`;
}

export interface Statement {
  subject: { name?: string; digest: Record<string, string> }[];
  predicateType: string;
  predicate: unknown;
}

const IN_TOTO_PAYLOAD = "application/vnd.in-toto+json";
const STATEMENT_TYPES = new Set(["https://in-toto.io/Statement/v1", "https://in-toto.io/Statement/v0.1"]);

/**
 * Loads the verifier. `trustedRoot` is a Sigstore trusted root (protobuf JSON); without it the public-good root is
 * fetched through Sigstore's TUF repository.
 */
export async function loadVerifier(trustedRoot: unknown): Promise<Verifier> {
  try {
    const root = trustedRoot === undefined ? await getTrustedRoot() : TrustedRoot.fromJSON(trustedRoot);
    return new Verifier(toTrustMaterial(root));
  } catch (err) {
    throw new CheckFailure("trust-root-unavailable", errorText(err));
  }
}

/** Verifies `bundleJson` and returns its statement, or throws a CheckFailure naming the first failed step. */
export function verifyAttestation(bundleJson: unknown, verifier: Verifier, expectedSan: string): Statement {
  let entity;
  let payload: Buffer;
  try {
    const bundle = bundleFromJSON(bundleJson);
    if (bundle.content.$case !== "dsseEnvelope") throw new Error("bundle content is not a DSSE envelope");
    if (bundle.content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD) {
      throw new Error(`DSSE payload type is ${bundle.content.dsseEnvelope.payloadType}`);
    }
    if (bundle.verificationMaterial.content.$case === "publicKey") throw new Error("bundle is signed by a key, not a certificate");
    payload = bundle.content.dsseEnvelope.payload;
    entity = toSignedEntity(bundle);
  } catch (err) {
    throw new CheckFailure("bundle-invalid", errorText(err));
  }

  let identity;
  try {
    identity = verifier.verify(entity).identity;
  } catch (err) {
    throw new CheckFailure("signature-invalid", errorText(err));
  }
  const san = identity?.subjectAlternativeName;
  if (san !== expectedSan) throw new CheckFailure("identity-mismatch", `signed by ${String(san)}, expected ${expectedSan}`);
  const issuer = identity?.extensions?.issuer;
  if (issuer !== GITHUB_OIDC_ISSUER) {
    throw new CheckFailure("issuer-mismatch", `certificate issuer ${String(issuer)}, expected ${GITHUB_OIDC_ISSUER}`);
  }
  return parseStatement(payload);
}

function parseStatement(payload: Buffer): Statement {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new CheckFailure("statement-invalid", "signed payload is not JSON");
  }
  if (!isRecord(raw) || typeof raw._type !== "string" || !STATEMENT_TYPES.has(raw._type)) {
    throw new CheckFailure("statement-invalid", "signed payload is not an in-toto statement");
  }
  const { subject, predicateType, predicate } = raw;
  if (typeof predicateType !== "string" || !Array.isArray(subject)) {
    throw new CheckFailure("statement-invalid", "statement lacks subject or predicateType");
  }
  const subjects = subject.map((s: unknown) => {
    if (!isRecord(s) || !isRecord(s.digest)) throw new CheckFailure("statement-invalid", "statement subject lacks a digest");
    const digest: Record<string, string> = {};
    for (const [alg, value] of Object.entries(s.digest)) if (typeof value === "string") digest[alg] = value;
    return typeof s.name === "string" ? { name: s.name, digest } : { digest };
  });
  return { subject: subjects, predicateType, predicate };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
