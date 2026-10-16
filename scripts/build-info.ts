// Writes dist/build-info.json after `tsc`, so the built gateway knows which commit it was built from.
// A bundled library policy records this commit, so a build outside a git checkout fails instead of guessing, and
// a build from a tree with uncommitted changes records no commit (`buildCommit: null, dirty: true`): its bundled
// policies may differ from that commit, so the gateway then refuses to apply them.
//
// A build with no git checkout (the Docker build: `.git` is not in its context) names its commit with BUILD_COMMIT.
// The override is taken only where git cannot check it; inside a checkout it must equal HEAD of a clean tree, so it
// never relabels a dirty or different tree. Outside a checkout, whoever passes it vouches that the files are that
// commit unchanged (CI's package job checks that its checkout is clean first).
//
// BUILD_COMMIT=unknown is the plain `docker build` with no --build-arg: outside a checkout it records that the commit
// is not known (`buildCommit: null, dirty: null`), so nothing claims a commit and bundled policies are refused as for a
// dirty tree. Inside a checkout it is refused like any other BUILD_COMMIT that is not HEAD.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BuildInfo =
  | { version: string; buildCommit: string; dirty: false }
  | { version: string; buildCommit: null; dirty: true }
  | { version: string; buildCommit: null; dirty: null };

/** The BUILD_COMMIT value for a build outside a checkout whose commit nobody named (the Dockerfile's fallback). */
export const UNKNOWN_COMMIT = "unknown";

/** The build info for `buildCommit`, or for a dirty tree when `dirty` is true (the commit is then not recorded). */
export function buildInfo(version: string, buildCommit: string, dirty = false): BuildInfo {
  if (!/^[0-9a-f]{40}$/.test(buildCommit)) throw new Error(`build commit is not a full git commit hash: ${JSON.stringify(buildCommit)}`);
  if (version === "") throw new Error("version is empty");
  return dirty ? { version, buildCommit: null, dirty: true } : { version, buildCommit, dirty: false };
}

/**
 * Writes `<outDir>/build-info.json` for the checkout at `repo`. `commitOverride` (BUILD_COMMIT) names the commit
 * when `repo` is not a git checkout; inside a checkout it must equal HEAD of a clean tree.
 */
export function writeBuildInfo(repo: string, outDir: string, commitOverride?: string): BuildInfo {
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  let commit: string;
  let dirty: boolean;
  try {
    commit = git("rev-parse", "HEAD").trim();
    // Untracked files count: a new file under policies/ is bundled even though git does not track it.
    dirty = git("status", "--porcelain", "--untracked-files=all") !== "";
  } catch (error) {
    if (commitOverride === undefined) throw error;
    commit = commitOverride;
    dirty = false;
  }
  if (commitOverride !== undefined && commitOverride !== commit) {
    throw new Error(`BUILD_COMMIT ${JSON.stringify(commitOverride)} is not HEAD (${commit}) of this checkout`);
  }
  if (commitOverride !== undefined && dirty) throw new Error("BUILD_COMMIT is set but the checkout has uncommitted changes");
  // Only reached outside a checkout: inside one, "unknown" is not HEAD and was refused above.
  if (commit === UNKNOWN_COMMIT) {
    if (pkg.version === "") throw new Error("version is empty");
    return write(outDir, { version: pkg.version, buildCommit: null, dirty: null });
  }
  return write(outDir, buildInfo(pkg.version, commit, dirty));
}

function write(outDir: string, info: BuildInfo): BuildInfo {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

function describe(info: BuildInfo): string {
  if (info.dirty === null) return `build-info: ${info.version}, commit unknown (local build without BUILD_COMMIT; none recorded)`;
  return info.dirty ? `build-info: ${info.version} from a dirty tree (no commit recorded)` : `build-info: ${info.version} at ${info.buildCommit}`;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  const repo = join(import.meta.dirname, "..");
  const override = process.env.BUILD_COMMIT;
  const info = writeBuildInfo(repo, join(repo, "dist"), override === undefined || override === "" ? undefined : override);
  console.log(describe(info));
}
