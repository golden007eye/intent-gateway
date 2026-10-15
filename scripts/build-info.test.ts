import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInfo, writeBuildInfo } from "./build-info.ts";

const repo = join(import.meta.dirname, "..");
const commit = "0123456789abcdef0123456789abcdef01234567";

describe("buildInfo", () => {
  it("keeps a full commit hash and the version", () => {
    expect(buildInfo("1.2.3", commit)).toEqual({ version: "1.2.3", buildCommit: commit });
  });

  it.each(["", "unknown", commit.slice(0, 7), commit.toUpperCase(), `${commit}\n`, `${commit}0`])("rejects commit %j", (bad) => {
    expect(() => buildInfo("1.2.3", bad)).toThrow(/full git commit hash/);
  });

  it("rejects an empty version", () => {
    expect(() => buildInfo("", commit)).toThrow(/version is empty/);
  });
});

describe("writeBuildInfo", () => {
  it("writes HEAD and the package.json version to build-info.json", () => {
    const out = join(mkdtempSync(join(tmpdir(), "build-info-")), "dist");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };

    const info = writeBuildInfo(repo, out);

    expect(info).toEqual({ version: pkg.version, buildCommit: head });
    expect(JSON.parse(readFileSync(join(out, "build-info.json"), "utf8"))).toEqual(info);
  });

  it("fails outside a git checkout", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "no-git-"));
    expect(() => writeBuildInfo(notRepo, join(notRepo, "dist"))).toThrow();
  });
});
