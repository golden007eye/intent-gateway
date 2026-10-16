// `intent policy add`: fetch a library policy, check it is the one the library published, and apply it as
// meet(current, library), so adding a policy can only narrow the gateway (invariant 1, ADR-0009).
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { BUILD } from "../config/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { loadPolicy, meet, type Policy } from "../policy/index.ts";

export const LIBRARY_REPO = "golden007eye/intent-gateway";
export const GITHUB_API = "https://api.github.com";
/** The cap on any one GitHub response body; the index and a policy file are a few KiB. */
export const MAX_GITHUB_BODY_BYTES = 1024 * 1024;
const BUNDLED_ROOT = new URL("../../policies/", import.meta.url);
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * What `policy.lock` records: which library policy was applied, from which commit, the sha256 of the library's
 * policy.yaml (`sha256`), and the sha256 of the policy.yaml addPolicy wrote, which is meet(current, library)
 * (`policy_sha256`). A lock whose `policy_sha256` does not match the policy file does not describe it.
 */
export interface Lock {
  name: string;
  commit: string;
  sha256: string;
  source: "bundled" | "github";
  policy_sha256: string;
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
  | "GITHUB_ERROR"
  | "LOCK_INVALID"
  | "LOCK_STALE"
  | "POLICY_CHANGED";

/** A refused `policy add` (nothing was written), or a `policy.lock` that readLock cannot vouch for. */
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
  return (await planPolicy(name, opts)).apply();
}

/** What `policy add` would write, read and checked but not yet written, so a caller can show it first. */
export interface PolicyPlan {
  /** The policy.yaml there now, as its text; undefined when there is none. */
  before: string | undefined;
  /** The policy.yaml apply() writes: meet(current, library). */
  after: string;
  lock: Lock;
  /**
   * Writes policy.yaml and policy.lock. Refuses (LibraryError `POLICY_CHANGED`, nothing written) when policy.yaml
   * changed since the plan was made, so the change shown is the change applied.
   */
  apply(): Promise<Lock>;
}

/** Everything addPolicy does short of writing: fetch, check against the index, load, meet with the current policy. */
export async function planPolicy(name: string, opts: AddOptions): Promise<PolicyPlan> {
  if (!NAME.test(name)) throw new LibraryError("UNKNOWN_POLICY", `${JSON.stringify(name)} is not a library policy name`);
  const fetched = opts.commit === undefined ? await readBundled(name, opts) : await readGithub(name, opts.commit, opts);
  const library = loadPolicy(fetched.text);
  const currentBytes = await readOptional(opts.policyPath);
  const before = currentBytes === undefined ? undefined : new TextDecoder().decode(currentBytes);
  const result = before === undefined ? library : meet(loadPolicy(before), library);
  const yaml = policyYaml(result);
  const lock: Lock = {
    name,
    commit: fetched.commit,
    sha256: fetched.sha256,
    source: fetched.source,
    policy_sha256: sha256Hex(new TextEncoder().encode(yaml)),
  };
  const apply = async (): Promise<Lock> => {
    const now = await readOptional(opts.policyPath);
    const same = now === undefined || currentBytes === undefined ? now === currentBytes : Buffer.from(now).equals(currentBytes);
    if (!same) throw new LibraryError("POLICY_CHANGED", `${opts.policyPath} changed while policy add was running; run it again`);
    await writePolicy(opts.policyPath, yaml, lock);
    return lock;
  };
  return { before, after: yaml, lock, apply };
}

async function writePolicy(policyPath: string, yaml: string, lock: Lock): Promise<void> {
  const dir = dirname(policyPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Both files go to fresh temp files, fsynced, before either is renamed into place. The lock is renamed first:
  // a crash between the two renames leaves the new lock beside the old policy, and because the lock names the
  // hash of the policy it belongs to, readLock reports it stale instead of vouching for the wrong file.
  const temps: string[] = [];
  try {
    temps.push(await writeTemp(lockPath(policyPath), canonicalize(lock)));
    temps.push(await writeTemp(policyPath, yaml));
    const [lockTmp, policyTmp] = temps as [string, string];
    await rename(lockTmp, lockPath(policyPath));
    temps.shift();
    await rename(policyTmp, policyPath);
    temps.shift();
  } finally {
    await Promise.all(temps.map((tmp) => unlink(tmp).catch(() => undefined)));
  }
  await syncDir(dir);
}

const lockPath = (policyPath: string): string => join(dirname(policyPath), "policy.lock");

/**
 * Reads the `policy.lock` beside `policyPath`; undefined when there is none. Throws LibraryError `LOCK_STALE`
 * when the lock does not describe the policy file there (a `policy add` stopped between its two renames, or
 * policy.yaml was edited since), and `LOCK_INVALID` when it is not a lock addPolicy writes.
 */
export async function readLock(policyPath: string): Promise<Lock | undefined> {
  const text = await readOptional(lockPath(policyPath));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(text));
  } catch {
    throw new LibraryError("LOCK_INVALID", "policy.lock is not JSON");
  }
  if (!isLock(parsed)) throw new LibraryError("LOCK_INVALID", "policy.lock is not a lock written by intent policy add");
  const policy = (await readOptional(policyPath)) ?? new Uint8Array();
  if (sha256Hex(policy) !== parsed.policy_sha256) {
    throw new LibraryError(
      "LOCK_STALE",
      "policy.lock does not describe policy.yaml (the last policy add did not finish, or policy.yaml was edited since); run intent policy add again",
    );
  }
  return parsed;
}

function isLock(value: unknown): value is Lock {
  if (typeof value !== "object" || value === null) return false;
  const l = value as Record<string, unknown>;
  return (
    Object.keys(l).sort().join() === "commit,name,policy_sha256,sha256,source" &&
    typeof l.name === "string" &&
    typeof l.commit === "string" &&
    FULL_SHA.test(l.commit) &&
    typeof l.sha256 === "string" &&
    SHA256.test(l.sha256) &&
    typeof l.policy_sha256 === "string" &&
    SHA256.test(l.policy_sha256) &&
    (l.source === "bundled" || l.source === "github")
  );
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
    const why =
      opts.buildCommit === undefined && BUILD.dirty
        ? "this gateway was built from a tree with uncommitted changes"
        : "this gateway runs from source";
    throw new LibraryError("NO_BUILD_COMMIT", `${why}, so its bundled policies have no build commit to record; use --commit <sha>`);
  }
  const root = opts.bundledRoot ?? BUNDLED_ROOT;
  const expected = indexHash(name, await readFile(new URL("index.json", root), "utf8"), "the bundled index");
  const bytes = await readFile(new URL(`${name}/policy.yaml`, root));
  return { ...checked(name, bytes, expected, "bundled"), commit, source: "bundled" };
}

async function readGithub(name: string, commit: string, opts: AddOptions): Promise<Fetched> {
  if (!FULL_SHA.test(commit)) throw new LibraryError("BAD_COMMIT", `--commit needs a full 40-character commit hash, got ${JSON.stringify(commit)}`);
  const get = opts.fetch ?? fetch;
  const api = async (path: string, accept = "application/vnd.github+json"): Promise<Uint8Array> => {
    const response = await get(`${GITHUB_API}/repos/${LIBRARY_REPO}/${path}`, {
      headers: { accept, "x-github-api-version": "2022-11-28" },
    });
    if (response.ok) return capped(response, path);
    await response.body?.cancel().catch(() => undefined);
    if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : "";
      throw new LibraryError("GITHUB_RATE_LIMITED", `GitHub's unauthenticated API rate limit is used up${when}; try again later`);
    }
    if (response.status === 429) throw new LibraryError("GITHUB_RATE_LIMITED", "GitHub is rate-limiting requests; try again later");
    throw new LibraryError("GITHUB_ERROR", `GitHub answered ${String(response.status)} for ${path}`);
  };
  const json = async (path: string): Promise<unknown> => {
    const body = await api(path);
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new LibraryError("GITHUB_ERROR", `GitHub's answer for ${path} is not JSON`);
    }
  };

  const info = (await json(`commits/${commit}`)) as {
    sha?: unknown;
    commit?: { verification?: { verified?: unknown } };
  } | null;
  if (info?.sha !== commit) throw new LibraryError("BAD_COMMIT", `GitHub returned a different commit for ${commit}`);
  if (info.commit?.verification?.verified !== true) {
    throw new LibraryError("COMMIT_UNSIGNED", `commit ${commit} does not carry a signature GitHub verified`);
  }
  // The full ref name: a bare `main` could resolve to a tag or another ref named main before the branch.
  const compare = (await json(`compare/refs/heads/main...${commit}`)) as { status?: unknown } | null;
  if (compare?.status !== "behind" && compare?.status !== "identical") {
    throw new LibraryError("COMMIT_NOT_ON_MAIN", `commit ${commit} is not on main (compare status ${JSON.stringify(compare?.status)})`);
  }
  const raw = (path: string): Promise<Uint8Array> => api(`contents/${path}?ref=${commit}`, "application/vnd.github.raw+json");
  const index = new TextDecoder("utf-8", { fatal: true }).decode(await raw("policies/index.json"));
  const expected = indexHash(name, index, `the index at ${commit}`);
  const bytes = await raw(`policies/${name}/policy.yaml`);
  return { ...checked(name, bytes, expected, `commit ${commit}`), commit, source: "github" };
}

/** Reads a GitHub response body, refusing one larger than MAX_GITHUB_BODY_BYTES. */
async function capped(response: Response, path: string): Promise<Uint8Array> {
  const tooLarge = (): LibraryError =>
    new LibraryError("GITHUB_ERROR", `GitHub's answer for ${path} is larger than ${String(MAX_GITHUB_BODY_BYTES)} bytes`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_GITHUB_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_GITHUB_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
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
  if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
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

/** The policy as a v1 policy.yaml. Reloading it gives the same policy, which addPolicy checks before writing. */
function policyYaml(policy: Policy): string {
  const text = stringify(policy);
  if (canonicalize(loadPolicy(text)) !== canonicalize(policy)) throw new Error("policy.yaml does not round-trip");
  return text;
}

/**
 * Writes `text` to a new file beside `path` and fsyncs it. The name has a random suffix and is opened with `wx`,
 * so a file or symlink planted at a predictable name is never followed or overwritten.
 */
async function writeTemp(path: string, text: string): Promise<string> {
  const tmp = `${path}.tmp-${randomBytes(12).toString("hex")}`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return tmp;
}

/** Makes the renames durable. Windows cannot open a directory to fsync it, so there the renames stand alone. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
