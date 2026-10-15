// The crash points of `policy add`'s two-file write: whichever step fails, policy.lock never vouches for a
// policy.yaml it does not describe, and no temp file is left behind. node:fs/promises is wrapped so a chosen
// step throws, which is where a crash would stop the write.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addPolicy, LibraryError, readLock } from "./index.ts";

const fail = vi.hoisted(() => ({ step: undefined as undefined | ((op: string, path: string) => boolean) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const guard =
    <A extends unknown[], R>(op: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const target = String(op === "rename" ? args[1] : args[0]);
      if (fail.step?.(op, target) === true) return Promise.reject(new Error(`crash at ${op} ${basename(target)}`));
      return fn(...args);
    };
  return { ...real, rename: guard("rename", real.rename), open: guard("open", real.open) };
});

// The adds fsync; on a busy disk that latency alone can pass the default 5 s timeout (see add.test.ts).
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  fail.step = undefined;
});

const BUILD_SHA = "b".repeat(40);
const CURRENT = "version: 1\napproval: passkey\nspend: { per_order_usd: 100 }\n";

/** A data dir holding a policy and the lock of an earlier add, as a crash would find it. */
async function earlierAdd(): Promise<{ policyPath: string; lockPath: string; before: { policy: string; lock: string } }> {
  const policyPath = join(mkdtempSync(join(tmpdir(), "library-crash-")), "data", "policy.yaml");
  const lockPath = join(dirname(policyPath), "policy.lock");
  mkdirSync(dirname(policyPath));
  writeFileSync(policyPath, CURRENT);
  await addPolicy("no-history", { policyPath, buildCommit: BUILD_SHA });
  return { policyPath, lockPath, before: { policy: readFileSync(policyPath, "utf8"), lock: readFileSync(lockPath, "utf8") } };
}

const files = (policyPath: string): string[] => readdirSync(dirname(policyPath)).sort();

describe("addPolicy crash points", () => {
  it.each([
    ["creating the lock temp", (op: string, p: string) => op === "open" && p.includes("policy.lock.tmp-")],
    ["creating the policy temp", (op: string, p: string) => op === "open" && p.includes("policy.yaml.tmp-")],
    ["renaming the lock", (op: string, p: string) => op === "rename" && p.endsWith("policy.lock")],
  ])("a failure at %s leaves both files as they were", async (_label, step) => {
    const { policyPath, lockPath, before } = await earlierAdd();
    fail.step = step;
    await expect(addPolicy("per-order-60", { policyPath, buildCommit: BUILD_SHA })).rejects.toThrow(/crash at/);
    fail.step = undefined;
    expect(readFileSync(policyPath, "utf8")).toBe(before.policy);
    expect(readFileSync(lockPath, "utf8")).toBe(before.lock);
    expect(await readLock(policyPath)).toEqual(JSON.parse(before.lock));
    expect(files(policyPath)).toEqual(["policy.lock", "policy.yaml"]);
  });

  // The one window where the two files disagree: the new lock is in place, the policy rename has not happened.
  it("a failure between the two renames leaves a lock that readLock reports stale", async () => {
    const { policyPath, before } = await earlierAdd();
    fail.step = (op, p) => op === "rename" && p.endsWith("policy.yaml");
    await expect(addPolicy("per-order-60", { policyPath, buildCommit: BUILD_SHA })).rejects.toThrow(/crash at/);
    fail.step = undefined;

    expect(readFileSync(policyPath, "utf8")).toBe(before.policy);
    const error = await readLock(policyPath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LibraryError);
    expect((error as LibraryError).code).toBe("LOCK_STALE");
    expect(files(policyPath)).toEqual(["policy.lock", "policy.yaml"]);

    // Running the add again completes it, and the lock describes the policy once more.
    const lock = await addPolicy("per-order-60", { policyPath, buildCommit: BUILD_SHA });
    expect(await readLock(policyPath)).toEqual(lock);
  });

  it("a first add that stops between the renames leaves a lock with no policy, reported stale", async () => {
    const policyPath = join(mkdtempSync(join(tmpdir(), "library-crash-")), "data", "policy.yaml");
    fail.step = (op, p) => op === "rename" && p.endsWith("policy.yaml");
    await expect(addPolicy("no-history", { policyPath, buildCommit: BUILD_SHA })).rejects.toThrow(/crash at/);
    fail.step = undefined;
    expect(existsSync(policyPath)).toBe(false);
    await expect(readLock(policyPath)).rejects.toThrow(/does not describe policy.yaml/);
  });
});
