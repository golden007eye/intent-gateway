// The command that runs this gateway again, so every command the gateway prints (help, demo next steps, error
// hints) is one the developer can paste as is. `intent` is on PATH only for a global install; an npx run, a local
// tarball, a source build and the Docker image each need their own prefix.
import { readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

/** What the command is derived from; the real values are taken once at start (INTENT). */
export interface InvocationInput {
  /** `process.argv[1]`: the script node was started with (a bin shim, `dist/main.js`, or a test runner). */
  argv1: string | undefined;
  /** The package root (beside `dist/` and `package.json`), as an absolute path. */
  packageRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Reads a file as text, or returns null. Defaults to readFileSync. */
  readText?: (path: string) => string | null;
  /** Resolves symlinks. Defaults to realpathSync, falling back to the path itself. */
  realpath?: (path: string) => string;
}

const SELF = new Set(["main.js", "main.ts", "intent", "intent-gateway"]);

/**
 * The prefix to print before a subcommand, e.g. `${invocation(...)} verify --demo`:
 * - in the Docker image: `docker exec <container id> intent` (see dockerExec);
 * - under npx: `npx -y <the package spec npx was given>`, e.g. `npx -y intent-gateway@next` or
 *   `npx -y file:/abs/intent-gateway.tgz`;
 * - from a bin on PATH (a global install): `intent` or `intent-gateway`;
 * - otherwise (a source build, a path): `node /abs/dist/main.js`;
 * - when this process is not the gateway's own script (a test runner, an embedding): `intent`.
 */
export function invocation(input: InvocationInput): string {
  const { argv1, env } = input;
  const realpath = input.realpath ?? realOrSame;
  if (argv1 === undefined || !SELF.has(basename(argv1))) return "intent";
  if (env.INTENT_RUNTIME === "container") return `${dockerExec(env)} intent`;
  const spec = npxSpec(input.packageRoot, input.readText ?? readOrNull);
  if (spec !== null) return `npx -y ${quote(spec)}`;
  const name = basename(argv1);
  if ((name === "intent" || name === "intent-gateway") && onPath(dirname(argv1), env.PATH)) return name;
  return `node ${quote(realpath(argv1))}`;
}

/**
 * `docker exec <id>` for this container: Docker sets HOSTNAME to the container's short id (12 hex digits), which
 * `docker exec` accepts. A HOSTNAME of any other shape (`--hostname`, `--network host`) is not an id, so the
 * placeholder `<container>` is printed instead of a name that would not work.
 */
export function dockerExec(env: Readonly<Record<string, string | undefined>>): string {
  return `docker exec ${containerRef(env)}`;
}

/** This container's short id for `docker exec`/`docker stop` (see dockerExec()), or the placeholder `<container>`. */
export function containerRef(env: Readonly<Record<string, string | undefined>>): string {
  const id = env.HOSTNAME ?? "";
  return /^[0-9a-f]{12}$/.test(id) ? id : "<container>";
}

/**
 * The README's demo run of the image. Hints printed when the container cannot start use it instead of
 * `docker exec … intent demo`: a container that failed to start has exited, so there is nothing to exec into.
 */
export const IMAGE_DEMO_RUN = "docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 -v intent-data:/data intent-gateway";

/** How to pass a root key file to the image: a read-only mount, then the flag (the entrypoint adds `serve --http`). */
export const IMAGE_TRUST_KEYS = `docker run … -v "$PWD/keys.json:/keys.json:ro" intent-gateway --trust-keys /keys.json`;

/** Inside the image: re-run this container in demo mode. `docker rm` first, since a second `--name intent` clashes. */
export function containerDemo(env: Readonly<Record<string, string | undefined>>): string {
  const id = env.HOSTNAME ?? "";
  return `re-run the container in demo mode: docker rm ${/^[0-9a-f]{12}$/.test(id) ? id : "<container>"} && ${IMAGE_DEMO_RUN}`;
}

/**
 * The spec npx installed this package from, read from the package.json of npx's cache folder (two levels above
 * `node_modules/intent-gateway`): a tarball or folder as `file:<absolute path>` (npx records it relative to the
 * cache folder), else the registry spec npx was given (`_npx.packages`), such as `intent-gateway@next`.
 */
function npxSpec(packageRoot: string, readText: (path: string) => string | null): string | null {
  const modules = dirname(packageRoot);
  if (basename(modules) !== "node_modules" || basename(packageRoot) !== "intent-gateway") return null;
  const folder = dirname(modules);
  const text = readText(join(folder, "package.json"));
  if (text === null) return null;
  let manifest: { dependencies?: Record<string, unknown>; _npx?: { packages?: unknown } };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return null;
  }
  const dep = manifest.dependencies?.["intent-gateway"];
  if (typeof dep === "string" && dep.startsWith("file:")) return `file:${resolve(folder, dep.slice("file:".length))}`;
  const packages = manifest._npx?.packages;
  if (!Array.isArray(packages)) return null;
  const named = packages.filter((p): p is string => typeof p === "string" && /^intent-gateway(@|$)/.test(p));
  return named.length === 1 ? (named[0] ?? null) : null;
}

function onPath(dir: string, path: string | undefined): boolean {
  return (path ?? "").split(delimiter).some((entry) => entry !== "" && entry.replace(/\/+$/, "") === dir.replace(/\/+$/, ""));
}

/** Single-quotes a word for a POSIX shell when it holds anything but plain path characters. */
function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
