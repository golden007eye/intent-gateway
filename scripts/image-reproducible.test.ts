// The image digest is checked twice: by the CI package job (three builds agree) and by the release rebuild job
// (a fresh runner gets the published digest). These tests keep the parts of the build that make that hold (F-q).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("../Dockerfile");
const workflows = [read("../.github/workflows/ci.yml"), read("../.github/workflows/release.yml")].join("\n");

describe("the reproducible image build", () => {
  it("copies the production dependencies instead of hard-linking them, and checks the tree holds no hard link", () => {
    expect(dockerfile).toMatch(/pnpm install --prod --frozen-lockfile --ignore-scripts --package-import-method=copy/);
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

  it("explains a digest mismatch in the CI log instead of only failing", () => {
    expect(workflows).toContain('scripts/image-diff.sh "${RUNNER_TEMP}/image-1.tar" "${RUNNER_TEMP}/image-$n.tar"');
  });
});
