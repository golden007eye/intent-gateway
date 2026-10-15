// verifyImage against a local test Sigstore instance and an offline OCI registry serving Sigstore bundles as
// referrers of the image digest.
import { describe, expect, test } from "vitest";
import { createTestSigstore, type Identity } from "../../test/support/sigstore-ca.ts";
import { routedFetch, sha256hex, type Route } from "../../test/support/fake-registry.ts";
import { formatSelfCheck, verifyImage, type FailureReason } from "./index.ts";

const VERSION = "1.2.3";
const HEX = sha256hex("image manifest");
const REF = `ghcr.io/golden007eye/intent-gateway@sha256:${HEX}`;
const V2 = "https://ghcr.io/v2/golden007eye/intent-gateway";
const TOKEN_URL = "https://ghcr.io/token?scope=repository:golden007eye/intent-gateway:pull&service=ghcr.io";
const BUNDLE_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const RELEASE: Identity = {
  san: `https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v${VERSION}`,
  issuer: "https://token.actions.githubusercontent.com",
};
const NOW = new Date("2026-10-01T09:00:00Z");
const sigstore = createTestSigstore();

const statement = (predicateType: string, predicate: unknown, hex = HEX) => ({
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: "ghcr.io/golden007eye/intent-gateway", digest: { sha256: hex } }],
  predicateType,
  predicate,
});
const signature = (hex?: string) => statement("https://sigstore.dev/cosign/sign/v1", {}, hex);
const sbom = (hex?: string) =>
  statement("https://cyclonedx.org/bom", { bomFormat: "CycloneDX", specVersion: "1.6", components: [] }, hex);

interface Setup {
  statements?: { body: unknown; identity?: Identity }[];
  referrersApi?: boolean;
  tamperManifest?: boolean;
}

function setup(s: Setup = {}) {
  const routes = new Map<string, Route>([[TOKEN_URL, { token: "anonymous-pull-token" }]]);
  const manifests = (s.statements ?? [{ body: signature() }, { body: sbom() }]).map(({ body, identity }) => {
    const blob = Buffer.from(JSON.stringify(sigstore.attest(body, identity ?? RELEASE)));
    const blobDigest = `sha256:${sha256hex(blob)}`;
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        artifactType: BUNDLE_TYPE,
        config: { mediaType: "application/vnd.oci.empty.v1+json", digest: `sha256:${sha256hex("{}")}`, size: 2 },
        layers: [{ mediaType: BUNDLE_TYPE, digest: blobDigest, size: blob.length }],
        subject: { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${HEX}` },
      }),
    );
    const digest = `sha256:${sha256hex(manifest)}`;
    routes.set(`${V2}/manifests/${digest}`, s.tamperManifest ? Buffer.concat([manifest, Buffer.from(" ")]) : manifest);
    routes.set(`${V2}/blobs/${blobDigest}`, blob);
    return { mediaType: "application/vnd.oci.image.manifest.v1+json", digest, artifactType: BUNDLE_TYPE };
  });
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${HEX}`, artifactType: "other/type" },
      ...manifests,
    ],
  };
  routes.set(s.referrersApi === false ? `${V2}/manifests/sha256-${HEX}` : `${V2}/referrers/sha256:${HEX}`, index);
  const fetch = routedFetch(routes);
  return { fetch, opts: { version: VERSION, fetch, now: () => NOW, trustedRoot: sigstore.trustedRoot } };
}

const reasons = (r: { failures: readonly { reason: FailureReason }[] }) => r.failures.map((f) => f.reason);

describe("verifyImage", () => {
  test("a signed image with an SBOM attestation passes and is labelled self-check", async () => {
    const { opts, fetch } = setup();
    const result = await verifyImage(REF, opts);
    expect(result).toMatchObject({ label: "self-check", kind: "image-signature", subject: REF, ok: true, failures: [] });
    expect(result.checkedAt).toBe(NOW.toISOString());
    expect(result.outsideChecks).toEqual([
      `cosign verify --certificate-identity ${RELEASE.san} --certificate-oidc-issuer ${RELEASE.issuer} ${REF}`,
      `cosign verify-attestation --type cyclonedx --certificate-identity ${RELEASE.san} --certificate-oidc-issuer ${RELEASE.issuer} ${REF}`,
    ]);
    expect(formatSelfCheck(result)).toMatch(/^self-check: image signature and SBOM of ghcr\.io\/\S+: ok\n/);
    expect(formatSelfCheck(result)).toContain("cosign verify ");
    const registryCalls = fetch.calls.filter((c) => c.url.startsWith(V2));
    expect(registryCalls.every((c) => c.headers.get("authorization") === "Bearer anonymous-pull-token")).toBe(true);
  });

  test("falls back to the referrers tag when the registry lacks the referrers API", async () => {
    const { opts } = setup({ referrersApi: false });
    expect((await verifyImage(REF, opts)).ok).toBe(true);
  });

  test("a wrong workflow identity fails with identity-mismatch", async () => {
    const other: Identity = { ...RELEASE, san: RELEASE.san.replace("release.yml", "ci.yml") };
    const { opts } = setup({ statements: [{ body: signature(), identity: other }, { body: sbom(), identity: other }] });
    const result = await verifyImage(REF, opts);
    expect(result.ok).toBe(false);
    expect(reasons(result)).toEqual(["identity-mismatch", "identity-mismatch", "signature-missing", "sbom-missing"]);
  });

  test("a signature for another image digest fails with digest-mismatch", async () => {
    const { opts } = setup({ statements: [{ body: signature(sha256hex("other image")) }, { body: sbom() }] });
    expect(reasons(await verifyImage(REF, opts))).toEqual(["digest-mismatch", "signature-missing"]);
  });

  test("an image without an SBOM attestation fails with sbom-missing", async () => {
    const { opts } = setup({ statements: [{ body: signature() }] });
    expect(reasons(await verifyImage(REF, opts))).toEqual(["sbom-missing"]);
  });

  test("an SBOM predicate that is not CycloneDX fails with statement-invalid", async () => {
    const { opts } = setup({
      statements: [{ body: signature() }, { body: statement("https://cyclonedx.org/bom", { bomFormat: "SPDX" }) }],
    });
    expect(reasons(await verifyImage(REF, opts))).toEqual(["statement-invalid", "sbom-missing"]);
  });

  test("registry content that does not match its digest is refused", async () => {
    const { opts } = setup({ tamperManifest: true });
    expect(reasons(await verifyImage(REF, opts))).toEqual([
      "registry-error",
      "registry-error",
      "signature-missing",
      "sbom-missing",
    ]);
  });

  test("a reference that is not a digest of the gateway image fails with ref-invalid", async () => {
    const { opts } = setup();
    for (const ref of [
      "ghcr.io/golden007eye/intent-gateway:latest",
      `ghcr.io/attacker/intent-gateway@sha256:${HEX}`,
      `ghcr.io/golden007eye/intent-gateway@sha256:${HEX.slice(1)}`,
    ]) {
      expect(reasons(await verifyImage(ref, opts)), ref).toEqual(["ref-invalid"]);
    }
    const bad = await verifyImage(REF, { ...opts, version: "latest" });
    expect(reasons(bad)).toEqual(["ref-invalid"]);
    expect(bad.outsideChecks[0]).toContain("<release workflow identity>");
  });

  test("registry failures fail with registry-error", async () => {
    const { opts } = setup();
    const down = await verifyImage(REF, { ...opts, fetch: () => Promise.resolve(new Response("", { status: 503 })) });
    expect(reasons(down)).toEqual(["registry-error"]);
    const noToken = await verifyImage(REF, { ...opts, fetch: () => Promise.resolve(new Response("{}")) });
    expect(reasons(noToken)).toEqual(["registry-error"]);
  });
});
