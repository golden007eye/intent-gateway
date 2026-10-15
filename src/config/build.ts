// Build info: the version and the commit the gateway was built from.
// `pnpm build` writes dist/build-info.json (scripts/build-info.ts). Running from source has no build, so
// buildCommit is null there: a caller that must record a commit refuses instead of guessing one.
import { readFileSync } from "node:fs";

export interface Build {
  version: string;
  /** Full git commit hash of the build, or null when running from source. */
  buildCommit: string | null;
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
    return { version: pkg.version, buildCommit: null };
  }
  const info = JSON.parse(text) as { version?: unknown; buildCommit?: unknown };
  if (typeof info.version !== "string" || info.version === "") throw new Error("build-info.json has no version");
  if (typeof info.buildCommit !== "string" || !/^[0-9a-f]{40}$/.test(info.buildCommit)) {
    throw new Error("build-info.json has no full git commit hash");
  }
  return { version: info.version, buildCommit: info.buildCommit };
}
