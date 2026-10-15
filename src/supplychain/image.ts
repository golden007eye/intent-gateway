// Self-check of the gateway image: a cosign keyless signature and a CycloneDX SBOM attestation, both signed by the
// gateway's release workflow at the version's tag, both naming the image digest. Sigstore bundles are found as OCI
// referrers of the digest (the referrers API, or the `sha256-<hex>` referrers tag where the registry lacks it).
import { createHash } from "node:crypto";
import { loadVerifier, releaseIdentity, verifyAttestation, isRecord, GITHUB_OIDC_ISSUER } from "./attestation.ts";
import { getBytes, getJson, parseJson } from "./http.ts";
import { CheckFailure, toFailure, type Failure, type SelfCheckOptions, type SelfCheckResult } from "./result.ts";

export interface ImageOptions extends SelfCheckOptions {
  /** The gateway version the image was released as; selects the expected workflow tag. */
  version: string;
}

export const IMAGE_REPOSITORY = "ghcr.io/golden007eye/intent-gateway";
const REGISTRY = "https://ghcr.io";
const REPO_PATH = "golden007eye/intent-gateway";
const REF = /^ghcr\.io\/golden007eye\/intent-gateway@sha256:([0-9a-f]{64})$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COSIGN_SIGN = "https://sigstore.dev/cosign/sign/v1";
const CYCLONEDX = "https://cyclonedx.org/bom";
const BUNDLE_ARTIFACT = /^application\/vnd\.dev\.sigstore\.bundle(?:\.v0\.3\+json|\+json;version=0\.3)/;
const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";
const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
/** Bounds the work an attacker-controlled referrers list can cause. */
const MAX_REFERRERS = 32;

/** Verifies the image `ref` (`ghcr.io/golden007eye/intent-gateway@sha256:…`). Never throws for a failed check. */
export async function verifyImage(ref: string, opts: ImageOptions): Promise<SelfCheckResult> {
  const now = opts.now ?? (() => new Date());
  let failures: Failure[];
  try {
    failures = await check(ref, opts);
  } catch (err) {
    failures = [toFailure(err)];
  }
  return {
    label: "self-check",
    kind: "image-signature",
    subject: ref,
    ok: failures.length === 0,
    failures,
    checkedAt: now().toISOString(),
    outsideChecks: outsideChecks(ref, opts.version),
  };
}

function outsideChecks(ref: string, version: string): string[] {
  const san = releaseIdentity(version) ?? "<release workflow identity>";
  const identity = `--certificate-identity ${san} --certificate-oidc-issuer ${GITHUB_OIDC_ISSUER}`;
  return [`cosign verify ${identity} ${ref}`, `cosign verify-attestation --type cyclonedx ${identity} ${ref}`];
}

async function check(ref: string, opts: ImageOptions): Promise<Failure[]> {
  const hex = REF.exec(ref)?.[1];
  if (hex === undefined) throw new CheckFailure("ref-invalid", `expected ${IMAGE_REPOSITORY}@sha256:<64 hex>, got ${ref}`);
  const expectedSan = releaseIdentity(opts.version);
  if (expectedSan === undefined) throw new CheckFailure("ref-invalid", `not a release version: ${opts.version}`);
  const doFetch = opts.fetch ?? fetch;

  const token = await getJson(doFetch, `${REGISTRY}/token?scope=repository:${REPO_PATH}:pull&service=ghcr.io`);
  if (!isRecord(token) || typeof token.token !== "string") throw new CheckFailure("registry-error", "registry gave no pull token");
  const auth = { authorization: `Bearer ${token.token}` };
  const get = (path: string, accept: string): Promise<Buffer> =>
    getBytes(doFetch, `${REGISTRY}/v2/${REPO_PATH}/${path}`, { headers: { ...auth, accept } });

  const referrers = await listReferrers(get, hex);
  const verifier = await loadVerifier(opts.trustedRoot);
  const rejected: Failure[] = [];
  let signed = false;
  let sbom = false;
  for (const descriptor of referrers.slice(0, MAX_REFERRERS)) {
    try {
      const manifest = parseJson(await getAddressed(get, `manifests/${descriptor}`, MANIFEST_TYPE, descriptor), descriptor);
      const layer = isRecord(manifest) && Array.isArray(manifest.layers) ? (manifest.layers[0] as unknown) : undefined;
      if (!isRecord(layer) || typeof layer.digest !== "string" || !DIGEST.test(layer.digest)) throw new CheckFailure("bundle-invalid", `${descriptor} has no bundle layer`);
      const bundle = parseJson(await getAddressed(get, `blobs/${layer.digest}`, "*/*", layer.digest), layer.digest);
      const statement = verifyAttestation(bundle, verifier, expectedSan);
      if (!statement.subject.some((s) => s.digest.sha256 === hex)) {
        throw new CheckFailure("digest-mismatch", `${descriptor} is signed for another image digest`);
      }
      if (statement.predicateType === COSIGN_SIGN) {
        signed = true;
      } else if (statement.predicateType === CYCLONEDX) {
        if (!isRecord(statement.predicate) || statement.predicate.bomFormat !== "CycloneDX") {
          throw new CheckFailure("statement-invalid", `${descriptor} SBOM predicate is not CycloneDX`);
        }
        sbom = true;
      }
    } catch (err) {
      rejected.push(toFailure(err));
    }
  }
  if (signed && sbom) return [];
  return [
    ...rejected,
    ...(signed ? [] : [{ reason: "signature-missing" as const, detail: "no image signature by the release workflow" }]),
    ...(sbom ? [] : [{ reason: "sbom-missing" as const, detail: "no CycloneDX SBOM attestation by the release workflow" }]),
  ];
}

type Get = (path: string, accept: string) => Promise<Buffer>;

/** Digests of the Sigstore bundle manifests that refer to the image. */
async function listReferrers(get: Get, hex: string): Promise<string[]> {
  let index: Buffer;
  try {
    index = await get(`referrers/sha256:${hex}`, INDEX_TYPE);
  } catch {
    // OCI 1.1 fallback for registries without the referrers API: an index tagged `sha256-<hex>`.
    index = await get(`manifests/sha256-${hex}`, INDEX_TYPE);
  }
  const parsed = parseJson(index, "referrers index");
  const manifests = isRecord(parsed) && Array.isArray(parsed.manifests) ? (parsed.manifests as unknown[]) : [];
  return manifests.flatMap((m) =>
    isRecord(m) &&
    typeof m.digest === "string" &&
    DIGEST.test(m.digest) &&
    typeof m.artifactType === "string" &&
    BUNDLE_ARTIFACT.test(m.artifactType)
      ? [m.digest]
      : [],
  );
}

/** Fetches content-addressed bytes and refuses them unless they hash to `digest`. */
async function getAddressed(get: Get, path: string, accept: string, digest: string): Promise<Buffer> {
  const body = await get(path, accept);
  if (`sha256:${createHash("sha256").update(body).digest("hex")}` !== digest) {
    throw new CheckFailure("registry-error", `${path} does not match its digest`);
  }
  return body;
}
