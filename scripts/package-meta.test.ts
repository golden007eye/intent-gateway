// npm checks the provenance bundle against package.json: `repository.url` must name the GitHub repository the
// release workflow ran in, or `npm publish --provenance` is refused (E422) after the build and approval.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO = "https://github.com/golden007eye/intent-gateway";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  repository?: { type?: string; url?: string };
};

describe("package.json metadata npm provenance needs", () => {
  it("names the GitHub repository the release workflow runs in", () => {
    expect(pkg.repository?.type).toBe("git");
    const url = (pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    expect(url).toBe(REPO);
  });
});
