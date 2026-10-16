// `intent policy add` (AC-P3): each refusal writes nothing; a success writes meet(current, library) and a
// policy.lock that names the commit. GitHub is a mocked fetch, so the tests run offline.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "../jcs/index.ts";
import { PolicyError, loadPolicy, meet } from "../policy/index.ts";
import { noCommitReason } from "./add.ts";
import { addPolicy, LibraryError, LIBRARY_REPO, lockOrigin, MAX_GITHUB_BODY_BYTES, planPolicy, readLock, type AddOptions } from "./index.ts";

// Each add fsyncs three times (two temp files and the directory); on a busy disk that alone can pass the
// default 5 s timeout, which is latency, not a hang.
vi.setConfig({ testTimeout: 30_000 });

const POLICIES = new URL("../../policies/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, POLICIES), "utf8");
const SHA = "a".repeat(40);
const BUILD_SHA = "b".repeat(40);
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function workdir(): { dir: string; policyPath: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "library-"));
  return { dir, policyPath: join(dir, "data", "policy.yaml"), lockPath: join(dir, "data", "policy.lock") };
}

async function refusal(promise: Promise<unknown>): Promise<LibraryError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LibraryError);
  return error as LibraryError;
}

interface Repo {
  verified?: boolean;
  status?: string;
  files?: Record<string, string | undefined>;
  responses?: Record<string, Response>;
}

/** A fake GitHub API for LIBRARY_REPO at commit SHA, holding the real policies/ unless `files` overrides. */
function github(repo: Repo = {}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const files: Record<string, string | undefined> = {
    "policies/index.json": read("index.json"),
    "policies/no-history/policy.yaml": read("no-history/policy.yaml"),
    "policies/per-order-60/policy.yaml": read("per-order-60/policy.yaml"),
    ...repo.files,
  };
  const base = `https://api.github.com/repos/${LIBRARY_REPO}/`;
  const fake = (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    expect(url.startsWith(base)).toBe(true);
    const path = url.slice(base.length);
    const canned = repo.responses?.[path];
    if (canned !== undefined) return Promise.resolve(canned);
    if (path === `commits/${SHA}`) {
      return Promise.resolve(Response.json({ sha: SHA, commit: { verification: { verified: repo.verified ?? true } } }));
    }
    if (path === `compare/refs/heads/main...${SHA}`) return Promise.resolve(Response.json({ status: repo.status ?? "behind" }));
    const contents = /^contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    const file = contents?.[2] === SHA ? files[contents[1] ?? ""] : undefined;
    return Promise.resolve(file === undefined ? new Response("not found", { status: 404 }) : new Response(file));
  };
  return { fetch: fake, urls };
}

describe("addPolicy: bundled source", () => {
  it("refuses a bundled policy.yaml whose hash differs from the bundled index, and writes nothing", async () => {
    const { dir, policyPath, lockPath } = workdir();
    const root = join(dir, "policies");
    cpSync(new URL(".", POLICIES), root, { recursive: true });
    // Attack: a tampered copy that still loads, but is looser (no per-order limit).
    writeFileSync(join(root, "per-order-60", "policy.yaml"), "version: 1\napproval: passkey\n");
    const error = await refusal(
      addPolicy("per-order-60", { policyPath, buildCommit: BUILD_SHA, bundledRoot: pathToFileURL(`${root}/`) }),
    );
    expect(error.code).toBe("HASH_MISMATCH");
    expect(existsSync(policyPath) || existsSync(lockPath)).toBe(false);
  });

  it("refuses when the build has no commit (running from source) and none is injected", async () => {
    const { policyPath, lockPath } = workdir();
    const error = await refusal(addPolicy("no-history", { policyPath, buildCommit: null }));
    expect(error.code).toBe("NO_BUILD_COMMIT");
    // The fix (pass --commit) is said once, by the CLI's error wording, not also in the message.
    expect(error.message).toBe("this gateway runs from source, so its bundled policies have no build commit to record");
    expect(existsSync(policyPath) || existsSync(lockPath)).toBe(false);
  });

  it.each([
    [null, "unknown", "commit unknown: a local build without BUILD_COMMIT"],
    [true, "uncommitted", "commit unknown: built from a tree with uncommitted changes"],
  ] as const)("a build with dirty %s applies the bundled policy and locks commit %s, never a SHA (F-j)", async (dirty, marker, said) => {
    const { policyPath } = workdir();
    const lock = await addPolicy("per-order-60", { policyPath, buildCommit: null, dirty });
    expect(lock).toEqual({
      name: "per-order-60",
      commit: marker,
      sha256: sha256(read("per-order-60/policy.yaml")),
      source: "bundled",
      policy_sha256: sha256(readFileSync(policyPath, "utf8")),
    });
    expect(await readLock(policyPath)).toEqual(lock);
    expect(lockOrigin(lock)).toBe(`the library bundled with this gateway (${said})`);
  });

  it("a build that knows no commit still refuses a bundled policy.yaml that differs from the bundled index", async () => {
    const { dir, policyPath, lockPath } = workdir();
    const root = join(dir, "policies");
    cpSync(new URL(".", POLICIES), root, { recursive: true });
    writeFileSync(join(root, "per-order-60", "policy.yaml"), "version: 1\napproval: passkey\n");
    const error = await refusal(addPolicy("per-order-60", { policyPath, buildCommit: null, dirty: null, bundledRoot: pathToFileURL(`${root}/`) }));
    expect(error.code).toBe("HASH_MISMATCH");
    expect(existsSync(policyPath) || existsSync(lockPath)).toBe(false);
  });

  it("names where a lock came from with its commit, and a GitHub lock always by its SHA", () => {
    expect(lockOrigin({ source: "bundled", commit: BUILD_SHA })).toBe(`the library bundled with this gateway (commit ${BUILD_SHA})`);
    expect(lockOrigin({ source: "github", commit: SHA })).toBe(`GitHub commit ${SHA}`);
  });

  it("names why a build has no commit to record, including a local build without BUILD_COMMIT (F-i)", () => {
    expect(noCommitReason({ dirty: null })).toBe("this gateway's commit is unknown (a local build without BUILD_COMMIT)");
    expect(noCommitReason({ dirty: true })).toBe("this gateway was built from a tree with uncommitted changes");
    expect(noCommitReason({ dirty: false })).toBe("this gateway runs from source");
  });

  it("refuses an unknown or path-like name", async () => {
    const { policyPath } = workdir();
    for (const name of ["nope", "../index", "a/b", ""]) {
      expect((await refusal(addPolicy(name, { policyPath, buildCommit: BUILD_SHA }))).code).toBe("UNKNOWN_POLICY");
    }
  });

  it("with no current policy writes the library policy and a lock recording the build commit", async () => {
    const { policyPath, lockPath } = workdir();
    const lock = await addPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
    const text = read("no-history/policy.yaml");
    expect(lock).toEqual({
      name: "no-history",
      commit: BUILD_SHA,
      sha256: sha256(text),
      source: "bundled",
      policy_sha256: sha256(readFileSync(policyPath, "utf8")),
    });
    expect(readFileSync(lockPath, "utf8")).toBe(canonicalize(lock));
    expect(await readLock(policyPath)).toEqual(lock);
    // Only the two files: no temp file is left beside them.
    expect(readdirSync(dirname(policyPath)).sort()).toEqual(["policy.lock", "policy.yaml"]);
    expect(loadPolicy(readFileSync(policyPath, "utf8"))).toEqual(loadPolicy(text));
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(statSync(policyPath).mode & 0o777).toBe(0o600);
  });
});

describe("addPolicy: --commit source (GitHub)", () => {
  const add = (name: string, opts: Partial<AddOptions> & { fetch: typeof fetch }): Promise<unknown> =>
    addPolicy(name, { policyPath: workdir().policyPath, commit: SHA, ...opts });

  it("refuses a commit GitHub has not verified as signed", async () => {
    expect((await refusal(add("no-history", github({ verified: false })))).code).toBe("COMMIT_UNSIGNED");
  });

  it("refuses a commit that is not on main", async () => {
    for (const status of ["ahead", "diverged"]) {
      expect((await refusal(add("no-history", github({ status })))).code).toBe("COMMIT_NOT_ON_MAIN");
    }
  });

  it("accepts a commit at the tip of main", async () => {
    const { policyPath } = workdir();
    const lock = await addPolicy("no-history", { policyPath, commit: SHA, ...github({ status: "identical" }) });
    expect(lock.source).toBe("github");
  });

  it("refuses a policy.yaml whose hash differs from the index at that commit", async () => {
    // Attack: the commit's policy file was changed without updating the index.
    const files = { "policies/per-order-60/policy.yaml": "version: 1\napproval: passkey\n" };
    expect((await refusal(add("per-order-60", github({ files })))).code).toBe("HASH_MISMATCH");
  });

  it("refuses a short or malformed commit before any request", async () => {
    const gh = github();
    for (const commit of ["abc123", "A".repeat(40), `${SHA}/../x`]) {
      expect((await refusal(add("no-history", { ...gh, commit }))).code).toBe("BAD_COMMIT");
    }
    expect(gh.urls).toEqual([]);
  });

  it("refuses when GitHub answers for a different commit", async () => {
    const responses = { [`commits/${SHA}`]: Response.json({ sha: "c".repeat(40), commit: { verification: { verified: true } } }) };
    expect((await refusal(add("no-history", github({ responses })))).code).toBe("BAD_COMMIT");
  });

  it("names GitHub's rate limit", async () => {
    const limited = new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } });
    const error = await refusal(add("no-history", github({ responses: { [`commits/${SHA}`]: limited } })));
    expect(error.code).toBe("GITHUB_RATE_LIMITED");
    expect(error.message).toMatch(/rate limit.*2023-11-14T22:13:20/);
    const secondary = new Response("{}", { status: 429 });
    expect((await refusal(add("no-history", github({ responses: { [`commits/${SHA}`]: secondary } })))).code).toBe(
      "GITHUB_RATE_LIMITED",
    );
  });

  it("refuses a missing file or a broken index with a named reason", async () => {
    expect((await refusal(add("no-history", github({ files: { "policies/no-history/policy.yaml": undefined } })))).code).toBe(
      "GITHUB_ERROR",
    );
    expect((await refusal(add("no-history", github({ files: { "policies/index.json": "not json" } })))).code).toBe("INDEX_INVALID");
    expect((await refusal(add("no-history", github({ files: { "policies/index.json": '{"version":2,"policies":{}}' } })))).code).toBe(
      "INDEX_INVALID",
    );
    expect((await refusal(add("no-history", github({ files: { "policies/index.json": '{"version":1,"policies":{}}' } })))).code).toBe(
      "UNKNOWN_POLICY",
    );
    const noHash = '{"version":1,"policies":{"no-history":{"sha256":"x"}}}';
    expect((await refusal(add("no-history", github({ files: { "policies/index.json": noHash } })))).code).toBe("INDEX_INVALID");
  });

  it("refuses a library policy that does not load, even when its hash matches the index", async () => {
    const loose = "version: 1\napproval: none\n";
    const files = {
      "policies/index.json": JSON.stringify({ version: 1, policies: { "no-history": { sha256: sha256(loose) } } }),
      "policies/no-history/policy.yaml": loose,
    };
    const error = await add("no-history", github({ files })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).code).toBe("POLICY_LOOSENS");
  });
});

describe("addPolicy: result is meet(current, library)", () => {
  const CURRENT = [
    "version: 1",
    "approval: passkey",
    "share: { ship_to: none }",
    "spend: { per_order_usd: 100, per_day_usd: 50 }",
    "quantity: { max: 2 }",
    "merchants: { allow: [a.example, b.example], block: [c.example] }",
    "categories: { block: [toys] }",
    "",
  ].join("\n");

  it("writes meet(current, library) and a lock with the commit", async () => {
    const { policyPath, lockPath } = workdir();
    mkdirSync(dirname(policyPath));
    writeFileSync(policyPath, CURRENT);
    const gh = github();
    const lock = await addPolicy("per-order-60", { policyPath, commit: SHA, fetch: gh.fetch });

    const library = read("per-order-60/policy.yaml");
    expect(lock).toEqual({
      name: "per-order-60",
      commit: SHA,
      sha256: sha256(library),
      source: "github",
      policy_sha256: sha256(readFileSync(policyPath, "utf8")),
    });
    expect(lock.policy_sha256).not.toBe(lock.sha256);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(lock);
    expect(readFileSync(lockPath, "utf8")).toBe(canonicalize(lock));

    const current = loadPolicy(CURRENT);
    const result = loadPolicy(readFileSync(policyPath, "utf8"));
    expect(result).toEqual(meet(current, loadPolicy(library)));
    expect(result.spend.per_order_usd).toBe(60);
    // Never looser than current: every current rule survives.
    expect(meet(result, current)).toEqual(result);
    expect(gh.urls.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("never loosens current, even when the library policy is looser on every field", async () => {
    // Attack: a library policy that is the loosest a policy can be must not undo the developer's rules.
    const loosest = "version: 1\napproval: passkey\n";
    const files = {
      "policies/index.json": JSON.stringify({ version: 1, policies: { "no-history": { sha256: sha256(loosest) } } }),
      "policies/no-history/policy.yaml": loosest,
    };
    const { policyPath } = workdir();
    mkdirSync(dirname(policyPath));
    writeFileSync(policyPath, CURRENT);
    await addPolicy("no-history", { policyPath, commit: SHA, ...github({ files }) });
    const current = loadPolicy(CURRENT);
    const result = loadPolicy(readFileSync(policyPath, "utf8"));
    expect(result).toEqual(current);
    expect(meet(result, current)).toEqual(result);
  });
});

describe("addPolicy: GitHub reads", () => {
  it("checks the commit against the full ref refs/heads/main", async () => {
    const gh = github();
    await addPolicy("no-history", { policyPath: workdir().policyPath, commit: SHA, fetch: gh.fetch });
    expect(gh.urls).toContain(`https://api.github.com/repos/${LIBRARY_REPO}/compare/refs/heads/main...${SHA}`);
    expect(gh.urls.some((u) => u.includes("compare/main..."))).toBe(false);
  });

  // Attack: a hostile or broken answer must not be buffered without bound.
  it("refuses a body over the cap, declared or streamed, and writes nothing", async () => {
    const big = "x".repeat(MAX_GITHUB_BODY_BYTES + 1);
    const chunk = new TextEncoder().encode(big.slice(0, 64 * 1024));
    const declared = new Response("{}", { headers: { "content-length": String(MAX_GITHUB_BODY_BYTES + 1) } });
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
      }),
    );
    for (const response of [declared, endless, new Response(big)]) {
      const { policyPath, lockPath } = workdir();
      const responses = { [`contents/policies/index.json?ref=${SHA}`]: response };
      const error = await refusal(addPolicy("no-history", { policyPath, commit: SHA, ...github({ responses }) }));
      expect(error.code).toBe("GITHUB_ERROR");
      expect(error.message).toMatch(/larger than 1048576 bytes/);
      expect(existsSync(policyPath) || existsSync(lockPath)).toBe(false);
    }
  });

  it("refuses an API answer that is not JSON, or empty", async () => {
    for (const body of ["not json", null]) {
      const responses = { [`commits/${SHA}`]: new Response(body) };
      const error = await refusal(addPolicy("no-history", { policyPath: workdir().policyPath, commit: SHA, ...github({ responses }) }));
      expect(error.code).toBe("GITHUB_ERROR");
    }
  });
});

describe("addPolicy: writing", () => {
  it("does not follow a symlink planted at the old predictable temp name", async () => {
    const { dir, policyPath, lockPath } = workdir();
    mkdirSync(dirname(policyPath));
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, `${policyPath}.tmp-${String(process.pid)}`);
    symlinkSync(victim, `${lockPath}.tmp-${String(process.pid)}`);
    await addPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
    expect(await readLock(policyPath)).toBeDefined();
  });
});

describe("readLock", () => {
  it("is undefined when no policy was added", async () => {
    expect(await readLock(workdir().policyPath)).toBeUndefined();
  });

  it("reports a lock that no longer describes policy.yaml as stale", async () => {
    const { policyPath } = workdir();
    await addPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
    writeFileSync(policyPath, "version: 1\napproval: passkey\nquantity: { max: 1 }\n");
    expect((await refusal(readLock(policyPath))).code).toBe("LOCK_STALE");
    // A new add writes a lock that describes the file again.
    await addPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
    expect((await readLock(policyPath))?.policy_sha256).toBe(sha256(readFileSync(policyPath, "utf8")));
  });

  it("still reports a tampered policy.yaml as stale when the lock's commit is unknown (F-j)", async () => {
    const { policyPath } = workdir();
    await addPolicy("per-order-60", { policyPath, buildCommit: null, dirty: null });
    // Attack: loosen the applied policy (drop the per-order limit) and keep the unknown-commit lock beside it.
    writeFileSync(policyPath, "version: 1\napproval: passkey\n");
    expect((await refusal(readLock(policyPath))).code).toBe("LOCK_STALE");
  });

  it("reports a lock without its policy.yaml as stale", async () => {
    const { policyPath, lockPath } = workdir();
    await addPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
    const other = workdir();
    mkdirSync(dirname(other.lockPath));
    writeFileSync(other.lockPath, readFileSync(lockPath));
    expect((await refusal(readLock(other.policyPath))).code).toBe("LOCK_STALE");
  });

  const z = "0".repeat(64);
  it.each([
    ["not JSON", "{"],
    ["null", "null"],
    ["an old lock without policy_sha256", JSON.stringify({ name: "a", commit: SHA, sha256: z, source: "bundled" })],
    ["an unknown source", JSON.stringify({ name: "a", commit: SHA, sha256: z, source: "web", policy_sha256: z })],
    ["a short commit", JSON.stringify({ name: "a", commit: "abc", sha256: z, source: "github", policy_sha256: z })],
    // Attacks on the no-commit marker (F-j): only a bundled lock may say its commit is unknown.
    ["a GitHub lock with commit unknown", JSON.stringify({ name: "a", commit: "unknown", sha256: z, source: "github", policy_sha256: z })],
    ["a GitHub lock with commit uncommitted", JSON.stringify({ name: "a", commit: "uncommitted", sha256: z, source: "github", policy_sha256: z })],
    ["a marker mixed with a SHA", JSON.stringify({ name: "a", commit: `unknown-${SHA}`, sha256: z, source: "bundled", policy_sha256: z })],
    ["a SHA mixed with a marker", JSON.stringify({ name: "a", commit: `${SHA}unknown`, sha256: z, source: "bundled", policy_sha256: z })],
    ["an inherited property name as the commit", JSON.stringify({ name: "a", commit: "toString", sha256: z, source: "bundled", policy_sha256: z })],
    ["a marker in another case", JSON.stringify({ name: "a", commit: "Unknown", sha256: z, source: "bundled", policy_sha256: z })],
  ])("refuses %s as LOCK_INVALID", async (_label, text) => {
    const { policyPath, lockPath } = workdir();
    mkdirSync(dirname(lockPath));
    writeFileSync(lockPath, text);
    expect((await refusal(readLock(policyPath))).code).toBe("LOCK_INVALID");
  });
});

describe("planPolicy", () => {
  it("shows the text before and after without writing, and apply() writes exactly the after text", async () => {
    const { policyPath, lockPath } = workdir();
    mkdirSync(dirname(policyPath), { recursive: true });
    const before = "# mine\nversion: 1\napproval: passkey\nspend:\n  per_order_usd: 100\n";
    writeFileSync(policyPath, before);
    const plan = await planPolicy("per-order-60", { policyPath, buildCommit: BUILD_SHA });
    expect(plan.before).toBe(before);
    expect(plan.after).toMatch(/per_order_usd: 60/);
    expect(readFileSync(policyPath, "utf8")).toBe(before);
    expect(existsSync(lockPath)).toBe(false);
    expect(await plan.apply()).toEqual(plan.lock);
    expect(readFileSync(policyPath, "utf8")).toBe(plan.after);
    expect(await readLock(policyPath)).toEqual(plan.lock);
  });

  it("has no before text when there is no policy yet", async () => {
    const { policyPath } = workdir();
    const plan = await planPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
    expect(plan.before).toBeUndefined();
  });

  it.each([
    ["edited", (p: string) => { writeFileSync(p, "version: 1\napproval: passkey\nquantity:\n  max: 1\n"); }],
    ["created", (p: string) => { writeFileSync(p, "version: 1\napproval: passkey\n"); }],
  ])("apply() refuses when policy.yaml was %s after the plan, and writes nothing", async (_label, change) => {
    const { policyPath, lockPath } = workdir();
    const created = _label === "created";
    mkdirSync(dirname(policyPath), { recursive: true });
    if (!created) writeFileSync(policyPath, "version: 1\napproval: passkey\n");
    const plan = await planPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
    change(policyPath);
    const changed = readFileSync(policyPath, "utf8");
    expect((await refusal(plan.apply())).code).toBe("POLICY_CHANGED");
    expect(readFileSync(policyPath, "utf8")).toBe(changed);
    expect(existsSync(lockPath)).toBe(false);
  });
});
