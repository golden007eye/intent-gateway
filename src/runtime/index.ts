// The Node releases the gateway runs on (ADR-0012). No imports, so src/main.ts can check the running Node before it loads the
// rest of the gateway. The range is package.json `engines`, which is also the floor of the sigstore packages that
// `intent verify` uses: below it npm warns at install and those packages are untested.

/** package.json `engines.node`, in words. */
export const SUPPORTED_NODE = "Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+";

/** Whether Node `version` (as in process.versions.node, a leading v allowed) satisfies `^22.22.2 || ^24.15.0 || >=26.0.0`. */
export function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  if (major === 24) return minor >= 15;
  return major >= 26;
}

/** How to get a supported Node, with each tool the onboarding prompt detects. Homebrew's node@24 is keg-only: it is not on PATH until added. */
export const NODE_FIX =
  "Install Node 24 LTS: nvm install 24, fnm install 24, brew install node@24 (then put $(brew --prefix node@24)/bin first on PATH), " +
  "or the installer at https://nodejs.org/en/download; then run it again from a new terminal.";

/** The one line the gateway prints, then exits, when it runs on a Node outside SUPPORTED_NODE. */
export function unsupportedNodeLine(version: string): string {
  return `intent-gateway needs ${SUPPORTED_NODE}; this is Node ${version.replace(/^v/, "")}. ${NODE_FIX}`;
}
