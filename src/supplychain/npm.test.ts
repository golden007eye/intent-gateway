// verifyNpm against a local test Sigstore instance (real certificates, SCT, tlog entries and DSSE signatures; only
// the trusted root differs from production) and an offline registry.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestSigstore, type Identity } from "../../test/support/sigstore-ca.ts";
import { makeTarGz, routedFetch, sha512, type Route } from "../../test/support/fake-registry.ts";
import { formatSelfCheck, verifyNpm, type FailureReason } from "./index.ts";

const VERSION = "1.2.3";
const REGISTRY = "https://registry.npmjs.org";
const RELEASE: Identity = {
  san: `https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v${VERSION}`,
  issuer: "https://token.actions.githubusercontent.com",
};
const NOW = new Date("2026-10-01T09:00:00Z");
const sigstore = createTestSigstore();

const PACKED: Record<string, string> = {
  "package.json": JSON.stringify({ name: "intent-gateway", version: VERSION }),
  "dist/main.js": "console.log('gateway');\n",
  "README.md": "# intent-gateway\n",
  [`dist/${"deep/".repeat(20)}long-name.js`]: "export {};\n",
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Setup {
  identity?: Identity;
  subjectDigest?: string;
  predicateType?: string;
  tarball?: Buffer;
  installed?: Record<string, string>;
  attestations?: Route;
  bundle?: (b: Record<string, unknown>) => unknown;
  signer?: ReturnType<typeof createTestSigstore>;
}

async function setup(s: Setup = {}) {
  const tgz = makeTarGz(PACKED);
  const digest = sha512(tgz);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/intent-gateway@${VERSION}`, digest: { sha512: s.subjectDigest ?? digest.toString("hex") } }],
    predicateType: s.predicateType ?? "https://slsa.dev/provenance/v1",
    predicate: { buildDefinition: { buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" } },
  };
  const signed = (s.signer ?? sigstore).attest(statement, s.identity ?? RELEASE);
  const bundle = s.bundle ? s.bundle(signed) : signed;
  const tarballUrl = `${REGISTRY}/intent-gateway/-/intent-gateway-${VERSION}.tgz`;
  const fetch = routedFetch(
    new Map<string, Route>([
      [
        `${REGISTRY}/intent-gateway`,
        { versions: { [VERSION]: { dist: { integrity: `sha512-${digest.toString("base64")}`, tarball: tarballUrl } } } },
      ],
      [
        `${REGISTRY}/-/npm/v1/attestations/intent-gateway@${VERSION}`,
        s.attestations ?? {
          attestations: [
            { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} },
            { predicateType: "https://slsa.dev/provenance/v1", bundle },
          ],
        },
      ],
      [tarballUrl, s.tarball ?? tgz],
    ]),
  );

  const dir = await mkdtemp(join(tmpdir(), "supplychain-npm-"));
  dirs.push(dir);
  const installed = { ...PACKED, "node_modules/dep/index.js": "dependency, not part of the package\n", ...s.installed };
  for (const [path, content] of Object.entries(installed)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return { dir, fetch, opts: { fetch, now: () => NOW, trustedRoot: sigstore.trustedRoot } };
}

const reasons = (r: { failures: readonly { reason: FailureReason }[] }) => r.failures.map((f) => f.reason);

describe("verifyNpm", () => {
  test("a valid synthetic release passes and is labelled self-check", async () => {
    const { dir, opts } = await setup();
    const result = await verifyNpm(dir, opts);
    expect(result).toEqual({
      label: "self-check",
      kind: "npm-provenance",
      subject: `intent-gateway@${VERSION}`,
      ok: true,
      failures: [],
      checkedAt: NOW.toISOString(),
      outsideChecks: ["npm audit signatures"],
    });
    const text = formatSelfCheck(result);
    expect(text).toMatch(/^self-check: npm provenance of intent-gateway@1\.2\.3: ok\n/);
    expect(text).toContain("npm audit signatures");
  });

  test("an altered installed file fails with file-mismatch naming the file", async () => {
    const { dir, opts } = await setup({ installed: { "dist/main.js": "stealCards();\n" } });
    const result = await verifyNpm(dir, opts);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ reason: "file-mismatch", detail: "dist/main.js" }]);
    expect(formatSelfCheck(result)).toMatch(/^self-check: .*: FAILED\n {2}file-mismatch: dist\/main\.js\n/);
  });

  test("a wrong workflow identity fails with identity-mismatch", async () => {
    for (const san of [
      "https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/heads/main",
      "https://github.com/golden007eye/intent-gateway/.github/workflows/ci.yml@refs/tags/v1.2.3",
      "https://github.com/attacker/intent-gateway/.github/workflows/release.yml@refs/tags/v1.2.3",
      "https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v1.2.4",
    ]) {
      const { dir, opts } = await setup({ identity: { ...RELEASE, san } });
      const result = await verifyNpm(dir, opts);
      expect(reasons(result), san).toEqual(["identity-mismatch"]);
      expect(result.failures[0]?.detail).toContain(san);
    }
  });

  test("a certificate from another OIDC issuer fails with issuer-mismatch", async () => {
    const { dir, opts } = await setup({ identity: { ...RELEASE, issuer: "https://accounts.google.com" } });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["issuer-mismatch"]);
  });

  test("a wrong subject digest fails with digest-mismatch", async () => {
    const { dir, opts } = await setup({ subjectDigest: "00".repeat(64) });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["digest-mismatch"]);
  });

  test("a provenance for another package name fails with digest-mismatch", async () => {
    const { dir, opts } = await setup({
      bundle: () => sigstore.attest(
        {
          _type: "https://in-toto.io/Statement/v1",
          subject: [{ name: "pkg:npm/other@1.2.3", digest: { sha512: sha512(makeTarGz(PACKED)).toString("hex") } }],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {},
        },
        RELEASE,
      ),
    });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["digest-mismatch"]);
  });

  test("a tarball that differs from dist.integrity fails with tarball-integrity-mismatch", async () => {
    const { dir, opts } = await setup({ tarball: makeTarGz({ ...PACKED, "dist/main.js": "evil();\n" }) });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["tarball-integrity-mismatch"]);
  });

  test("missing and extra installed files are named; nested node_modules is ignored", async () => {
    const { dir, opts } = await setup({ installed: { "dist/extra.js": "added after install\n" } });
    await rm(join(dir, "README.md"));
    const result = await verifyNpm(dir, opts);
    expect(result.failures).toEqual([
      { reason: "file-missing", detail: "README.md" },
      { reason: "file-extra", detail: "dist/extra.js" },
    ]);
  });

  test("a bundle from a CA outside the trusted root fails with signature-invalid", async () => {
    const { dir, opts } = await setup({ signer: createTestSigstore() });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["signature-invalid"]);
  });

  test("a swapped DSSE payload fails with signature-invalid", async () => {
    const forged = Buffer.from(
      JSON.stringify({ _type: "https://in-toto.io/Statement/v1", subject: [], predicateType: "x", predicate: {} }),
    ).toString("base64");
    const { dir, opts } = await setup({
      bundle: (b) => ({ ...b, dsseEnvelope: { ...(b.dsseEnvelope as object), payload: forged } }),
    });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["signature-invalid"]);
  });

  test("a signed statement of another predicate type fails with statement-invalid", async () => {
    const { dir, opts } = await setup({ predicateType: "https://example.invalid/other" });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["statement-invalid"]);
  });

  test("a malformed bundle fails with bundle-invalid", async () => {
    const { dir, opts } = await setup({ bundle: () => ({ mediaType: "nope" }) });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["bundle-invalid"]);
  });

  test("no provenance attestation fails with attestation-missing", async () => {
    const { dir, opts } = await setup({ attestations: { attestations: [] } });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["attestation-missing"]);
  });

  test("registry failures fail with registry-error", async () => {
    const { dir, opts } = await setup({ attestations: 500 });
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["registry-error"]);
    const offline = await verifyNpm(dir, { ...opts, fetch: () => Promise.reject(new Error("ENOTFOUND")) });
    expect(offline.failures).toEqual([{ reason: "registry-error", detail: `${REGISTRY}/intent-gateway: ENOTFOUND` }]);
    const notJson = await verifyNpm(dir, { ...opts, fetch: () => Promise.resolve(new Response("<html>")) });
    expect(reasons(notJson)).toEqual(["registry-error"]);
  });

  test("a name or version the registry does not know fails with not-published, and nothing else is fetched", async () => {
    const { dir, opts } = await setup();
    const unknown = routedFetch(new Map());
    expect((await verifyNpm(dir, { ...opts, fetch: unknown })).failures).toEqual([
      { reason: "not-published", detail: "the registry has no package intent-gateway (HTTP 404)" },
    ]);
    expect(unknown.calls).toHaveLength(1);
    const other = routedFetch(new Map<string, Route>([[`${REGISTRY}/intent-gateway`, { versions: { "0.0.1": {} } }]]));
    expect((await verifyNpm(dir, { ...opts, fetch: other })).failures).toEqual([
      { reason: "not-published", detail: `the registry lists no intent-gateway@${VERSION}` },
    ]);
    // Reachable but inconsistent is not "unpublished".
    const noDist = routedFetch(new Map<string, Route>([[`${REGISTRY}/intent-gateway`, { versions: { [VERSION]: {} } }]]));
    expect(reasons(await verifyNpm(dir, { ...opts, fetch: noDist }))).toEqual(["registry-error"]);
    const noVersions = routedFetch(new Map<string, Route>([[`${REGISTRY}/intent-gateway`, {}]]));
    expect(reasons(await verifyNpm(dir, { ...opts, fetch: noVersions }))).toEqual(["registry-error"]);
  });

  test("an unreadable or non-release package fails with package-unreadable", async () => {
    const { dir, opts } = await setup();
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "intent-gateway", version: "1.2.3; rm -rf" }));
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["package-unreadable"]);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "../../x", version: VERSION }));
    expect(reasons(await verifyNpm(dir, opts))).toEqual(["package-unreadable"]);
    await rm(join(dir, "package.json"));
    const missing = await verifyNpm(dir, opts);
    expect(missing).toMatchObject({ label: "self-check", subject: dir, ok: false });
    expect(reasons(missing)).toEqual(["package-unreadable"]);
  });

  test("a trusted root that cannot be loaded fails with trust-root-unavailable", async () => {
    const { dir, opts } = await setup();
    expect(reasons(await verifyNpm(dir, { ...opts, trustedRoot: { tlogs: [{ publicKey: { rawBytes: "AAAA" }, logId: { keyId: "AAAA" } }] } }))).toEqual([
      "trust-root-unavailable",
    ]);
  });
});
