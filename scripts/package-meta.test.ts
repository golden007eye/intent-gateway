// npm checks the provenance bundle against package.json: `repository.url` must name the GitHub repository the
// release workflow ran in, or `npm publish --provenance` is refused (E422) after the build and approval.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO = "https://github.com/golden007eye/intent-gateway";
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json")) as {
  description?: string;
  keywords?: string[];
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

// Without a description npm shows the README's first lines, which are the logo's HTML (R-2).
describe("package.json metadata npmjs.com shows", () => {
  it("has a one-line plain-text description that says it is pre-alpha", () => {
    const description = pkg.description ?? "";
    expect(description).toMatch(/^Self-hosted gateway .*\. Pre-alpha\.$/);
    expect(description).not.toMatch(/[<>\n]/);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  // npmjs.com does not resolve repo-relative paths in the README's HTML, and the README ships in the tarball.
  it("README links and images are absolute URLs, so they work on npmjs.com as on GitHub", () => {
    const readme = read("../README.md");
    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)|\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? "");
    expect(targets.length).toBeGreaterThan(10);
    expect(targets.filter((t) => !/^(https:\/\/|#)/.test(t))).toEqual([]);
  });

  it("has the search keywords", () => {
    expect(pkg.keywords).toEqual(expect.arrayContaining(["mcp", "model-context-protocol", "ai-agents", "agentic-commerce", "privacy", "self-hosted"]));
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

  it("tells end users Node 22.22.2+, 24.15+ or 26+, the range src/runtime checks (F-t)", () => {
    expect(pkg.engines?.node).toBe("^22.22.2 || ^24.15.0 || >=26.0.0");
  });
});
