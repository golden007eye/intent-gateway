// npm checks the provenance bundle against package.json: `repository.url` must name the GitHub repository the
// release workflow ran in, or `npm publish --provenance` is refused (E422) after the build and approval.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO = "https://github.com/golden007eye/intent-gateway";
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json")) as {
  repository?: { type?: string; url?: string };
  engines?: { node?: string };
  devEngines?: { runtime?: { name?: string; version?: string; onFail?: string } };
};

describe("package.json metadata npm provenance needs", () => {
  it("names the GitHub repository the release workflow runs in", () => {
    expect(pkg.repository?.type).toBe("git");
    const url = (pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    expect(url).toBe(REPO);
  });
});

// pnpm runs the repo's scripts on the Node that devEngines.runtime pins, whatever `node` is first on PATH, so
// `pnpm release` and `pnpm boundaries` work on a machine whose default Node is another major (F-r).
describe("the Node the repo's pnpm scripts run on", () => {
  it("is the major in .node-version, downloaded by pnpm when the machine's Node is another one", () => {
    expect(pkg.devEngines?.runtime).toEqual({ name: "node", version: read("../.node-version").trim(), onFail: "download" });
  });

  it("is locked to a release the published engines range accepts", () => {
    const locked = /node@runtime:(\d+)\.(\d+)\.(\d+):/.exec(read("../pnpm-lock.yaml"));
    expect(locked).not.toBeNull();
    const [major, minor] = [Number(locked?.[1]), Number(locked?.[2])];
    expect(major === 24 ? minor >= 15 : major >= 26).toBe(true);
  });

  it("leaves what end users need unchanged: engines still accepts Node 24.15+ and 26+", () => {
    expect(pkg.engines?.node).toBe("^24.15.0 || >=26.0.0");
  });
});
