// Writes dist/build-info.json after `tsc`, so the built gateway knows which commit it was built from.
// A bundled library policy records this commit, so a build outside a git checkout fails instead of guessing.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  version: string;
  buildCommit: string;
}

export function buildInfo(version: string, buildCommit: string): BuildInfo {
  if (!/^[0-9a-f]{40}$/.test(buildCommit)) throw new Error(`build commit is not a full git commit hash: ${JSON.stringify(buildCommit)}`);
  if (version === "") throw new Error("version is empty");
  return { version, buildCommit };
}

export function writeBuildInfo(repo: string, outDir: string): BuildInfo {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  const info = buildInfo(pkg.version, commit);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  const repo = join(import.meta.dirname, "..");
  const info = writeBuildInfo(repo, join(repo, "dist"));
  console.log(`build-info: ${info.version} at ${info.buildCommit}`);
}
