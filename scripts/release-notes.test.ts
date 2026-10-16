import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER, releaseIdentity } from "../src/supplychain/index.ts";
import { isPrerelease, releaseNotesHeader, type ReleaseFacts } from "./release-notes.ts";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const FACTS: ReleaseFacts = {
  version: "0.1.0-preview.3",
  distTag: "next",
  digest: DIGEST,
  shasum: "eb263e00358ef2d490a3e73df9154a5fe02985d7",
  integrity: "sha512-pgOh5Yt3fFIzdDioY9jQ7ixJ04XA3O0wJuZH+SX659njmIrE/7l1JOWBM8cG2TPvzqadfhgUG8RsuRngepEdog==",
};

describe("GitHub Release notes header", () => {
  const text = releaseNotesHeader(FACTS);

  it("says a preview is not for real purchases, first", () => {
    expect(text.split("\n")[0]).toMatch(/^\*\*Pre-alpha preview, not for real purchases\.\*\* Nothing can be bought/);
  });

  it("gives the npx and docker install lines for this version", () => {
    expect(text).toContain("$ claude mcp add intent -- npx -y intent-gateway@next demo");
    expect(text).toContain("-p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788");
    expect(text).toContain("-e INTENT_DEMO=1 -v intent-data:/data ghcr.io/golden007eye/intent-gateway:0.1.0-preview.3");
  });

  it("names the image digest and the registry's tarball checksums", () => {
    expect(text).toContain(`ghcr.io/golden007eye/intent-gateway@${DIGEST}`);
    expect(text).toContain(`sha1 \`${FACTS.shasum}\`, integrity \`${FACTS.integrity}\``);
  });

  // The identity a developer is told to check must be the one `intent verify` checks, or every outside check fails.
  it("tells the developer to verify the identity intent verify checks", () => {
    const identity = releaseIdentity(FACTS.version) ?? "";
    expect(identity).not.toBe("");
    expect(text).toContain(`cosign verify --certificate-identity ${identity} \\\n    --certificate-oidc-issuer ${GITHUB_OIDC_ISSUER} ghcr.io/golden007eye/intent-gateway@${DIGEST}`);
    expect(text).toContain("cosign verify-attestation --type cyclonedx");
    expect(text).toContain("$ npm audit signatures");
    expect(text).toContain("$ npx -y intent-gateway@0.1.0-preview.3 verify --demo --install npm");
  });

  it("matches the identity docs/release.md and docs/verify.md give", () => {
    const pattern = "https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v<version>";
    for (const page of ["../docs/release.md", "../docs/verify.md"]) expect(readFileSync(new URL(page, import.meta.url), "utf8")).toContain(pattern);
    expect(pattern.replace("<version>", FACTS.version)).toBe(releaseIdentity(FACTS.version));
  });

  it("uses only absolute links, so it reads the same wherever the notes are shown", () => {
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toMatch(/^https:\/\//);
  });

  it("drops the preview line for a stable version on latest", () => {
    const stable = releaseNotesHeader({ ...FACTS, version: "0.1.0", distTag: "latest" });
    expect(stable).not.toContain("Pre-alpha preview");
    expect(stable).toContain("npx -y intent-gateway@latest demo");
  });

  it("refuses facts that do not fit together", () => {
    expect(() => releaseNotesHeader({ ...FACTS, distTag: "latest" })).toThrow(/dist-tag latest does not match/);
    expect(() => releaseNotesHeader({ ...FACTS, version: "0.1.0", distTag: "next" })).toThrow(/dist-tag next does not match/);
    expect(() => releaseNotesHeader({ ...FACTS, version: "v0.1.0" })).toThrow(/not a release version/);
    expect(() => releaseNotesHeader({ ...FACTS, digest: "sha256:abc" })).toThrow(/not an image digest/);
    expect(() => releaseNotesHeader({ ...FACTS, shasum: "" })).toThrow(/not an npm dist.shasum/);
    expect(() => releaseNotesHeader({ ...FACTS, integrity: "sha1-x" })).toThrow(/not an npm dist.integrity/);
  });

  it("marks only versions with a prerelease part as prereleases", () => {
    expect(isPrerelease("0.1.0-preview.3")).toBe(true);
    expect(isPrerelease("0.1.0")).toBe(false);
  });
});
