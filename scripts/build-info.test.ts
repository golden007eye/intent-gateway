import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInfo, UNKNOWN_COMMIT, writeBuildInfo } from "./build-info.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("buildInfo", () => {
  it("keeps a full commit hash and the version", () => {
    expect(buildInfo("1.2.3", commit)).toEqual({ version: "1.2.3", buildCommit: commit, dirty: false });
  });

  it("records no commit for a dirty tree", () => {
    expect(buildInfo("1.2.3", commit, true)).toEqual({ version: "1.2.3", buildCommit: null, dirty: true });
  });

  it.each(["", "unknown", commit.slice(0, 7), commit.toUpperCase(), `${commit}\n`, `${commit}0`])("rejects commit %j", (bad) => {
    expect(() => buildInfo("1.2.3", bad)).toThrow(/full git commit hash/);
  });

  it("rejects an empty version", () => {
    expect(() => buildInfo("", commit)).toThrow(/version is empty/);
  });
});

describe("writeBuildInfo", () => {
  /** A one-commit git repo holding package.json and a bundled policy; returns it and its HEAD. */
  function repo(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), "build-info-repo-"));
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.example", "-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        encoding: "utf8",
        stdio: "pipe",
      });
    git("init", "-q");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    mkdirSync(join(dir, "policies"));
    writeFileSync(join(dir, "policies", "index.json"), "{}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    return { dir, head: git("rev-parse", "HEAD").trim() };
  }

  const written = (out: string): unknown => JSON.parse(readFileSync(join(out, "build-info.json"), "utf8"));

  it("writes HEAD and the package.json version for a clean tree", () => {
    const { dir, head } = repo();
    const out = join(dir, "dist");
    const info = writeBuildInfo(dir, out);
    expect(info).toEqual({ version: "1.2.3", buildCommit: head, dirty: false });
    expect(written(out)).toEqual(info);
  });

  // Attack: an edited bundled policy built into a gateway must not be recorded as the policy at HEAD.
  it.each([
    [
      "an edited tracked file",
      (dir: string) => {
        writeFileSync(join(dir, "policies", "index.json"), '{"edited":true}\n');
      },
    ],
    [
      "an untracked file",
      (dir: string) => {
        writeFileSync(join(dir, "policies", "new.yaml"), "version: 1\n");
      },
    ],
    [
      "a staged change",
      (dir: string) => {
        writeFileSync(join(dir, "policies", "index.json"), "[]\n");
        execFileSync("git", ["add", "."], { cwd: dir });
      },
    ],
  ])("records no commit and dirty: true for %s", (_label, change) => {
    const { dir } = repo();
    change(dir);
    const out = mkdtempSync(join(tmpdir(), "build-info-out-"));
    const info = writeBuildInfo(dir, out);
    expect(info).toEqual({ version: "1.2.3", buildCommit: null, dirty: true });
    expect(written(out)).toEqual(info);
  });

  it("fails outside a git checkout", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "no-git-"));
    expect(() => writeBuildInfo(notRepo, join(notRepo, "dist"))).toThrow();
  });

  /** A folder with package.json and no .git, as the Docker build context is. */
  function exported(): string {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    return dir;
  }

  it("records BUILD_COMMIT outside a git checkout (the Docker build)", () => {
    const dir = exported();
    const out = join(dir, "dist");
    expect(writeBuildInfo(dir, out, commit)).toEqual({ version: "1.2.3", buildCommit: commit, dirty: false });
    expect(written(out)).toEqual({ version: "1.2.3", buildCommit: commit, dirty: false });
  });

  // A plain `docker build` with no --build-arg BUILD_COMMIT: the Dockerfile passes "unknown" (F-i).
  it("records an unknown commit for BUILD_COMMIT=unknown outside a git checkout, and names no commit", () => {
    const dir = exported();
    const out = join(dir, "dist");
    expect(UNKNOWN_COMMIT).toBe("unknown");
    expect(writeBuildInfo(dir, out, UNKNOWN_COMMIT)).toEqual({ version: "1.2.3", buildCommit: null, dirty: null });
    expect(written(out)).toEqual({ version: "1.2.3", buildCommit: null, dirty: null });
  });

  // Attack: "unknown" must not relabel a checkout git can see (clean or dirty) as a build of unknown commit.
  it("refuses BUILD_COMMIT=unknown inside a checkout", () => {
    const { dir } = repo();
    expect(() => writeBuildInfo(dir, join(dir, "dist"), UNKNOWN_COMMIT)).toThrow(/is not HEAD/);
  });

  it("refuses a BUILD_COMMIT outside a checkout that is not a full commit hash", () => {
    const dir = exported();
    expect(() => writeBuildInfo(dir, join(dir, "dist"), "HEAD")).toThrow(/full git commit hash/);
  });

  it("accepts BUILD_COMMIT inside a clean checkout when it is HEAD", () => {
    const { dir, head } = repo();
    expect(writeBuildInfo(dir, join(dir, "dist"), head)).toEqual({ version: "1.2.3", buildCommit: head, dirty: false });
  });

  // Attack: the override must not relabel a checkout git can see as another commit, or a dirty tree as clean.
  it("refuses a BUILD_COMMIT inside a checkout that is not HEAD", () => {
    const { dir } = repo();
    expect(() => writeBuildInfo(dir, join(dir, "dist"), commit)).toThrow(/is not HEAD/);
  });

  it("refuses a BUILD_COMMIT inside a checkout with uncommitted changes", () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, "policies", "index.json"), '{"edited":true}\n');
    const out = mkdtempSync(join(tmpdir(), "build-info-out-"));
    expect(() => writeBuildInfo(dir, out, head)).toThrow(/uncommitted changes/);
  });
});
