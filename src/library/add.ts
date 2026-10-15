// `intent policy add`: fetch a library policy, check it is the one the library published, and apply it as
// meet(current, library), so adding a policy can only narrow the gateway (invariant 1, ADR-0009).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { BUILD } from "../config/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { loadPolicy, meet, type Policy } from "../policy/index.ts";

export const LIBRARY_REPO = "golden007eye/intent-gateway";
export const GITHUB_API = "https://api.github.com";
const BUNDLED_ROOT = new URL("../../policies/", import.meta.url);
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** What `policy.lock` records: which library policy was applied, from which commit, with which file hash. */
export interface Lock {
  name: string;
  commit: string;
  sha256: string;
  source: "bundled" | "github";
}

export interface AddOptions {
  /** The configured policy path (`Config.policyPath`); `policy.lock` is written beside it. */
  policyPath: string;
  /** Take the policy from this library commit on GitHub instead of the copy bundled with the gateway. */
  commit?: string;
  /** Overrides `BUILD.buildCommit` for the bundled source (tests; a build from source has none). */
  buildCommit?: string | null;
  /** Overrides the bundled `policies/` folder (tests). */
  bundledRoot?: URL;
  /** Overrides the global fetch (tests). */
  fetch?: typeof fetch;
}

export type LibraryErrorCode =
  | "UNKNOWN_POLICY"
  | "INDEX_INVALID"
  | "HASH_MISMATCH"
  | "NO_BUILD_COMMIT"
  | "BAD_COMMIT"
  | "COMMIT_UNSIGNED"
  | "COMMIT_NOT_ON_MAIN"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_ERROR";

/** A refused `policy add`. `code` names the reason; nothing was written. */
export class LibraryError extends Error {
  override readonly name = "LibraryError";
  readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Applies library policy `name`. The result written to `opts.policyPath` is meet(current, library), where
 * current is the policy already there (if any); `policy.lock` beside it records the source. Throws
 * LibraryError (or PolicyError for a policy that does not load) and writes nothing on any refusal.
 */
export async function addPolicy(name: string, opts: AddOptions): Promise<Lock> {
  if (!NAME.test(name)) throw new LibraryError("UNKNOWN_POLICY", `${JSON.stringify(name)} is not a library policy name`);
  const fetched = opts.commit === undefined ? await readBundled(name, opts) : await readGithub(name, opts.commit, opts);
  const library = loadPolicy(fetched.text);
  const current = await readCurrent(opts.policyPath);
  const result = current === undefined ? library : meet(current, library);
  const lock: Lock = { name, commit: fetched.commit, sha256: fetched.sha256, source: fetched.source };

  await mkdir(dirname(opts.policyPath), { recursive: true, mode: 0o700 });
  await writePrivate(opts.policyPath, policyYaml(result));
  await writePrivate(join(dirname(opts.policyPath), "policy.lock"), canonicalize(lock));
  return lock;
}

interface Fetched {
  text: string;
  sha256: string;
  commit: string;
  source: Lock["source"];
}

async function readBundled(name: string, opts: AddOptions): Promise<Fetched> {
  const commit = opts.buildCommit === undefined ? BUILD.buildCommit : opts.buildCommit;
  if (commit === null) {
    throw new LibraryError(
      "NO_BUILD_COMMIT",
      "this gateway runs from source, so its bundled policies have no build commit to record; use --commit <sha>",
    );
  }
  const root = opts.bundledRoot ?? BUNDLED_ROOT;
  const expected = indexHash(name, await readFile(new URL("index.json", root), "utf8"), "the bundled index");
  const bytes = await readFile(new URL(`${name}/policy.yaml`, root));
  return { ...checked(name, bytes, expected, "bundled"), commit, source: "bundled" };
}

async function readGithub(name: string, commit: string, opts: AddOptions): Promise<Fetched> {
  if (!FULL_SHA.test(commit)) throw new LibraryError("BAD_COMMIT", `--commit needs a full 40-character commit hash, got ${JSON.stringify(commit)}`);
  const get = opts.fetch ?? fetch;
  const api = async (path: string, accept = "application/vnd.github+json"): Promise<Response> => {
    const response = await get(`${GITHUB_API}/repos/${LIBRARY_REPO}/${path}`, {
      headers: { accept, "x-github-api-version": "2022-11-28" },
    });
    if (response.ok) return response;
    if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : "";
      throw new LibraryError("GITHUB_RATE_LIMITED", `GitHub's unauthenticated API rate limit is used up${when}; try again later`);
    }
    if (response.status === 429) throw new LibraryError("GITHUB_RATE_LIMITED", "GitHub is rate-limiting requests; try again later");
    throw new LibraryError("GITHUB_ERROR", `GitHub answered ${String(response.status)} for ${path}`);
  };

  const info = (await (await api(`commits/${commit}`)).json()) as {
    sha?: unknown;
    commit?: { verification?: { verified?: unknown } };
  };
  if (info.sha !== commit) throw new LibraryError("BAD_COMMIT", `GitHub returned a different commit for ${commit}`);
  if (info.commit?.verification?.verified !== true) {
    throw new LibraryError("COMMIT_UNSIGNED", `commit ${commit} does not carry a signature GitHub verified`);
  }
  const compare = (await (await api(`compare/main...${commit}`)).json()) as { status?: unknown };
  if (compare.status !== "behind" && compare.status !== "identical") {
    throw new LibraryError("COMMIT_NOT_ON_MAIN", `commit ${commit} is not on main (compare status ${JSON.stringify(compare.status)})`);
  }
  const raw = async (path: string): Promise<Uint8Array> =>
    new Uint8Array(await (await api(`contents/${path}?ref=${commit}`, "application/vnd.github.raw+json")).arrayBuffer());
  const index = new TextDecoder("utf-8", { fatal: true }).decode(await raw("policies/index.json"));
  const expected = indexHash(name, index, `the index at ${commit}`);
  const bytes = await raw(`policies/${name}/policy.yaml`);
  return { ...checked(name, bytes, expected, `commit ${commit}`), commit, source: "github" };
}

function indexHash(name: string, text: string, where: string): string {
  let index: unknown;
  try {
    index = JSON.parse(text);
  } catch {
    throw new LibraryError("INDEX_INVALID", `${where} is not JSON`);
  }
  const policies = (index as { version?: unknown; policies?: unknown } | null)?.policies;
  if ((index as { version?: unknown }).version !== 1 || typeof policies !== "object" || policies === null) {
    throw new LibraryError("INDEX_INVALID", `${where} is not a version 1 policy index`);
  }
  const entry = Object.hasOwn(policies, name) ? (policies as Record<string, { sha256?: unknown }>)[name] : undefined;
  if (entry === undefined) throw new LibraryError("UNKNOWN_POLICY", `${name} is not in ${where}`);
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new LibraryError("INDEX_INVALID", `${where} has no sha256 for ${name}`);
  }
  return entry.sha256;
}

function checked(name: string, bytes: Uint8Array, expected: string, where: string): { text: string; sha256: string } {
  const sha256 = sha256Hex(bytes);
  if (sha256 !== expected) {
    throw new LibraryError("HASH_MISMATCH", `${name}/policy.yaml from ${where} has sha256 ${sha256}, but the index lists ${expected}`);
  }
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), sha256 };
}

async function readCurrent(path: string): Promise<Policy | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return loadPolicy(text);
}

/** The policy as a v1 policy.yaml. Reloading it gives the same policy, which addPolicy checks before writing. */
function policyYaml(policy: Policy): string {
  const text = stringify(policy);
  if (canonicalize(loadPolicy(text)) !== canonicalize(policy)) throw new Error("policy.yaml does not round-trip");
  return text;
}

async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${String(process.pid)}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}
