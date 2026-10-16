// The image digest is checked twice: by the CI package job (three builds agree) and by the release rebuild job
// (a fresh runner gets the published digest). These tests keep the parts of the build that make that hold (F-q).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("../Dockerfile");
const workflows = [read("../.github/workflows/ci.yml"), read("../.github/workflows/release.yml")].join("\n");

describe("the reproducible image build", () => {
  // The dependencies are compiled into dist/ (ADR-0013): the app tree is the package's files and nothing installed.
  it("copies only the package's files into the app tree, installs nothing there, and checks it holds no hard link", () => {
    expect(dockerfile).toContain("cp -R package.json dist policies contract LICENSE NOTICE README.md /out/");
    expect(dockerfile).toContain("test ! -e node_modules");
    expect(dockerfile).not.toMatch(/pnpm install --prod/);
    expect(dockerfile).toContain('test -z "$(find /out -type f -links +1)"');
  });

  it("dates every file of the app tree SOURCE_DATE_EPOCH", () => {
    expect(dockerfile).toMatch(/^ARG SOURCE_DATE_EPOCH$/m);
    expect(dockerfile).toContain('find /out -exec touch --no-dereference --date="@${SOURCE_DATE_EPOCH}" {} +');
  });

  it("builds with one BuildKit, pinned by digest, in the package, image and rebuild jobs", () => {
    const setups = workflows.match(/uses: docker\/setup-buildx-action@\S+.*\n(?:\s+#.*\n|\s+with:\n)*/g) ?? [];
    expect(setups).toHaveLength(3);
    const pins = [...workflows.matchAll(/driver-opts: image=(moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64})$/gm)].map((m) => m[1]);
    expect(pins).toHaveLength(3);
    expect(new Set(pins).size).toBe(1);
  });

  // syft's package catalogers cannot see packages compiled into one file; the sbom-cataloger reads the build's
  // dist/sbom.cdx.json instead. CI scans with the same syft and flag the release uses, so a miss fails before a tag.
  it("makes the image SBOM with the sbom-cataloger, with one sha256-pinned syft in CI and the release", () => {
    const scans = [...workflows.matchAll(/syft scan .*\\\n.*/g)].map((m) => m[0]);
    expect(scans).toHaveLength(2);
    for (const scan of scans) expect(scan).toContain('--select-catalogers "+sbom-cataloger"');
    const versions = [...workflows.matchAll(/^ {2}SYFT_VERSION: "([\d.]+)"$/gm)].map((m) => m[1]);
    const sums = [...workflows.matchAll(/^ {2}SYFT_SHA256: ([0-9a-f]{64})$/gm)].map((m) => m[1]);
    expect(versions).toHaveLength(2);
    expect(new Set(versions).size).toBe(1);
    expect(sums).toHaveLength(2);
    expect(new Set(sums).size).toBe(1);
    expect(workflows.match(/startswith\("pkg:npm\/%40sigstore\/verify@"\)/g)).toHaveLength(2);
  });

  it("explains a digest mismatch in the CI log instead of only failing", () => {
    expect(workflows).toContain('scripts/image-diff.sh "${RUNNER_TEMP}/image-1.tar" "${RUNNER_TEMP}/image-$n.tar"');
  });
});
