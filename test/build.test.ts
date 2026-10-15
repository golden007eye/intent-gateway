// The built package works: `pnpm build` emits dist/main.js, which reports the version, plus build-info.json.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string; bin: Record<string, string> };

describe("pnpm build", () => {
  it("emits dist/main.js that prints the version, and dist/build-info.json", { timeout: 60_000 }, () => {
    execFileSync("pnpm", ["build"], { cwd: repo, stdio: "pipe" });

    expect(execFileSync("node", [join(repo, "dist/main.js"), "--version"], { encoding: "utf8" })).toBe(`${pkg.version}\n`);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    expect(JSON.parse(readFileSync(join(repo, "dist/build-info.json"), "utf8"))).toEqual({ version: pkg.version, buildCommit: head });
  });

  it("points both bin names at dist/main.js", () => {
    expect(pkg.bin).toEqual({ intent: "dist/main.js", "intent-gateway": "dist/main.js" });
  });
});
