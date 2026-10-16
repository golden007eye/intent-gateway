// The built package works: `pnpm build` emits dist/main.js, which reports the version, plus build-info.json.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoFirstRun } from "./build-demo.ts";

const repo = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string; bin: Record<string, string>; files: string[] };

describe("pnpm build", () => {
  it("emits dist/main.js that prints the version, and dist/build-info.json", { timeout: 60_000 }, () => {
    execFileSync("pnpm", ["build"], { cwd: repo, stdio: "pipe" });

    expect(execFileSync("node", [join(repo, "dist/main.js"), "--version"], { encoding: "utf8" })).toBe(`${pkg.version}\n`);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    // A checkout with local edits (a developer's) builds as dirty; CI builds a clean checkout and records HEAD.
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" }) !== "";
    if (process.env.CI !== undefined) expect(dirty).toBe(false);
    expect(JSON.parse(readFileSync(join(repo, "dist/build-info.json"), "utf8"))).toEqual(
      dirty ? { version: pkg.version, buildCommit: null, dirty: true } : { version: pkg.version, buildCommit: head, dirty: false },
    );
  });

  it("ships demo mode (src/demo and the fake it runs) in dist, and no test file", () => {
    for (const file of ["dist/demo/index.js", "dist/cloud-fake/index.js"]) expect(existsSync(join(repo, file)), file).toBe(true);
    const files = readdirSync(join(repo, "dist"), { recursive: true }).map(String);
    expect(files.filter((f) => /\.test\.(js|d\.ts)$/.test(f))).toEqual([]);
    expect(pkg.files).toContain("dist");
    // The fake reads its test keys and the contract sums from the package's contract/ at run time.
    expect(pkg.files).toContain("contract");
  });

  it("runs the developer's first run from the build: intent demo → find → cart → Approve → approved → verify --demo", { timeout: 60_000 }, async () => {
    await demoFirstRun(join(repo, "dist/main.js"));
  });

  it("points both bin names at dist/main.js", () => {
    expect(pkg.bin).toEqual({ intent: "dist/main.js", "intent-gateway": "dist/main.js" });
  });
});
