// Build info: the version and the commit the gateway was built from.
// `pnpm build` writes dist/build-info.json (scripts/build-info.ts). Running from source has no build, and a build
// from a tree with uncommitted changes is not any commit, so buildCommit is null in both cases: a caller that
// must record a commit refuses instead of guessing one.
import { readFileSync } from "node:fs";

export interface Build {
  version: string;
  /** Full git commit hash of the build; null when running from source or when the build tree was dirty. */
  buildCommit: string | null;
  /** True when the build was made from a tree with uncommitted changes (buildCommit is then null). */
  dirty: boolean;
}

/** Reads `<root>/build-info.json`, or, when it is absent, the version from `<root>/../package.json`. */
export function readBuild(root: URL): Build {
  let text: string | undefined;
  try {
    text = readFileSync(new URL("build-info.json", root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text === undefined) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", root), "utf8")) as { version?: unknown };
    if (typeof pkg.version !== "string" || pkg.version === "") throw new Error("package.json has no version");
    return { version: pkg.version, buildCommit: null, dirty: false };
  }
  const info = JSON.parse(text) as { version?: unknown; buildCommit?: unknown; dirty?: unknown };
  if (typeof info.version !== "string" || info.version === "") throw new Error("build-info.json has no version");
  if (info.dirty === true) {
    if (info.buildCommit !== null) throw new Error("build-info.json records a commit for a dirty build");
    return { version: info.version, buildCommit: null, dirty: true };
  }
  if (info.dirty !== false) throw new Error("build-info.json does not say whether the build tree was dirty");
  if (typeof info.buildCommit !== "string" || !/^[0-9a-f]{40}$/.test(info.buildCommit)) {
    throw new Error("build-info.json has no full git commit hash");
  }
  return { version: info.version, buildCommit: info.buildCommit, dirty: false };
}
