// `intent policy add` (AC-P3): each refusal writes nothing; a success writes meet(current, library) and a
// policy.lock that names the commit. GitHub is a mocked fetch, so the tests run offline.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../jcs/index.ts";
import { PolicyError, loadPolicy, meet } from "../policy/index.ts";
import { addPolicy, LibraryError, LIBRARY_REPO, type AddOptions } from "./index.ts";

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
    if (path === `compare/main...${SHA}`) return Promise.resolve(Response.json({ status: repo.status ?? "behind" }));
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
    expect(error.message).toMatch(/--commit/);
    expect(existsSync(policyPath) || existsSync(lockPath)).toBe(false);
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
    expect(lock).toEqual({ name: "no-history", commit: BUILD_SHA, sha256: sha256(text), source: "bundled" });
    expect(readFileSync(lockPath, "utf8")).toBe(canonicalize(lock));
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
    expect(lock).toEqual({ name: "per-order-60", commit: SHA, sha256: sha256(library), source: "github" });
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
