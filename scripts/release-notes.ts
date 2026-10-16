// The fixed header of a GitHub Release (docs/release.md): how to install the version, what was published, and how
// to check it with your own tools. The release workflow's github-release job prints it and appends the notes GitHub
// generates from the pull requests since the previous tag (its own "## What's Changed" section).
//
// Run: node scripts/release-notes.ts --version <v> --dist-tag <next|latest> --digest sha256:<hex> --shasum <sha1>
//      --integrity sha512-<base64>
// It imports nothing outside node:, so the workflow runs it on a bare checkout with no install.
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";

const REPOSITORY = "https://github.com/golden007eye/intent-gateway";
const IMAGE = "ghcr.io/golden007eye/intent-gateway";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface ReleaseFacts {
  version: string;
  distTag: string;
  /** The image digest that was signed, `sha256:<64 hex>`. */
  digest: string;
  /** The npm registry's `dist.shasum` (sha1, hex) and `dist.integrity` (sha512, SRI) of the published tarball. */
  shasum: string;
  integrity: string;
}

/** A prerelease (0.1.0-preview.3) is marked prerelease on GitHub and never becomes the latest release. */
export const isPrerelease = (version: string): boolean => version.includes("-");

export function releaseNotesHeader(f: ReleaseFacts): string {
  if (!VERSION.test(f.version)) throw new Error(`not a release version: ${f.version}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(f.digest)) throw new Error(`not an image digest: ${f.digest}`);
  if (!/^[0-9a-f]{40}$/.test(f.shasum)) throw new Error(`not an npm dist.shasum: ${f.shasum}`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(f.integrity)) throw new Error(`not an npm dist.integrity: ${f.integrity}`);
  if (f.distTag !== (isPrerelease(f.version) ? "next" : "latest")) throw new Error(`dist-tag ${f.distTag} does not match ${f.version}`);
  const identity = `${REPOSITORY}/.github/workflows/release.yml@refs/tags/v${f.version}`;
  const ref = `${IMAGE}@${f.digest}`;
  const tarball = `intent-gateway-${f.version}.tgz`;
  return [
    ...(isPrerelease(f.version)
      ? [
          `**Pre-alpha preview, not for real purchases.** Nothing can be bought with this version: real purchases wait for the [launch gate](${REPOSITORY}/blob/main/docs/adr/0004-public-pre-alpha.md). The demo runs the whole flow on your machine with test keys and a sample catalog.`,
          "",
        ]
      : []),
    "## Install",
    "",
    "```console",
    `$ claude mcp add intent -- npx -y intent-gateway@${f.distTag} demo`,
    `$ docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 \\`,
    `    -e INTENT_DEMO=1 -v intent-data:/data ${IMAGE}:${f.version}`,
    "```",
    "",
    `[README](${REPOSITORY}#readme) has the whole quickstart.`,
    "",
    "## What was published",
    "",
    `- npm: [\`intent-gateway@${f.version}\`](https://www.npmjs.com/package/intent-gateway/v/${f.version}) (dist-tag \`${f.distTag}\`), with npm provenance. \`${tarball}\` below is the tarball the registry serves: sha1 \`${f.shasum}\`, integrity \`${f.integrity}\`.`,
    `- Image: \`${ref}\` (tag \`${f.version}\`), signed with a keyless cosign signature. \`sbom.cdx.json\` below is the CycloneDX SBOM attested to that digest.`,
    "",
    "## Verify it",
    "",
    `Both are signed by this identity, issued by \`${OIDC_ISSUER}\`:`,
    "",
    "```text",
    identity,
    "```",
    "",
    "```console",
    "$ npm audit signatures                     # in a project that installed intent-gateway",
    `$ cosign verify --certificate-identity ${identity} \\`,
    `    --certificate-oidc-issuer ${OIDC_ISSUER} ${ref}`,
    `$ cosign verify-attestation --type cyclonedx --certificate-identity ${identity} \\`,
    `    --certificate-oidc-issuer ${OIDC_ISSUER} ${ref}`,
    `$ npx -y intent-gateway@${f.version} verify --demo --install npm`,
    "```",
    "",
    `\`intent verify\` also re-checks the local hash chain, the receipts and the approvals. [Verify](${REPOSITORY}/blob/main/docs/verify.md) explains each check.`,
    "",
    "",
  ].join("\n");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      "dist-tag": { type: "string" },
      digest: { type: "string" },
      shasum: { type: "string" },
      integrity: { type: "string" },
    },
    strict: true,
  });
  process.stdout.write(
    releaseNotesHeader({
      version: values.version ?? "",
      distTag: values["dist-tag"] ?? "",
      digest: values.digest ?? "",
      shasum: values.shasum ?? "",
      integrity: values.integrity ?? "",
    }),
  );
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) main();
