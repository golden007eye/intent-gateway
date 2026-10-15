// The append side: permissions, the fenced lease, and write failures. Attack cases for invariant 2 (log before
// send): a paused holder, a writer that ignores the lease, and failed or partial writes must all reject the append,
// because a rejected append is what stops the disclosure module's send.
import { appendFileSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, JcsError, sha256Hex } from "../jcs/index.ts";
import {
  type Entry,
  type EntryKind,
  openStore,
  readChain,
  StoreCorruptError,
  StoreFencedError,
  type StoreFs,
  verifyChain,
} from "./index.ts";

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const LEASE = 30_000;
let dir: string;
let now: number;
const clock = () => now;

beforeEach(async () => {
  dir = join(await fsp.mkdtemp(join(tmpdir(), "store-")), "data");
  now = T0;
});

const logPath = () => join(dir, "audit.jsonl");
const lockPath = () => join(dir, "audit.lock");
const logText = () => readFileSync(logPath(), "utf8");
const exists = (path: string) =>
  fsp.access(path).then(
    () => true,
    () => false,
  );
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const errno = (code: string) => Object.assign(new Error(code), { code });

/** A gate a test opens by hand; `reached` resolves when the code under test arrives at it. */
function gate() {
  let open: () => void = () => undefined;
  let arrive: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  return { open, reached, wait: () => (arrive(), opened) };
}

/** Pauses the nth read-only open of the log (1 = the head sync right after the lease is acquired, 2 = the tail
 * check inside the fence, after the lease token was already checked). */
function pauseAtRead(nth: number) {
  const g = gate();
  let reads = 0;
  const fs: StoreFs = {
    ...fsp,
    open: (async (...args: Parameters<typeof fsp.open>) => {
      if (args[0] === logPath() && args[1] === "r" && ++reads === nth) await g.wait();
      return fsp.open(...args);
    }),
  };
  return { fs, gate: g };
}

/** An fs whose append handles are changed by `patch`. */
function patchedAppends(patch: (handle: fsp.FileHandle) => void): StoreFs {
  return {
    ...fsp,
    open: (async (...args: Parameters<typeof fsp.open>) => {
      const handle = await fsp.open(...args);
      if (args[1] === "a" && args[0] === logPath()) patch(handle);
      return handle;
    }),
  };
}

async function filled(n: number) {
  const store = await openStore(dir, { clock });
  for (let i = 0; i < n; i++) await store.append("session", { i });
  return store;
}

describe("openStore", () => {
  it("creates the data dir 0700 and the log 0600, also over looser existing modes", async () => {
    await fsp.mkdir(dir, { mode: 0o755 });
    await fsp.writeFile(logPath(), "", { mode: 0o644 });
    await openStore(dir);
    expect((await fsp.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(logPath())).mode & 0o777).toBe(0o600);
  });

  it("appends linked entries and reads them back", async () => {
    const store = await openStore(dir, { clock });
    const a = await store.append("session", { s: 1 });
    now += 5;
    const b = await store.append("approval", { ok: true });
    expect(a).toMatchObject({ seq: 0, prev: "0".repeat(64), kind: "session", ts: "2026-10-15T12:00:00.000Z" });
    expect(b).toMatchObject({ seq: 1, prev: a.hash, ts: "2026-10-15T12:00:00.005Z" });
    expect(store.entries()).toEqual([a, b]);
    expect(await exists(lockPath())).toBe(false);
    await store.close();
  });

  it("continues an existing chain when reopened", async () => {
    await (await filled(2)).close();
    const store = await openStore(dir, { clock });
    expect(await store.append("keys", {})).toMatchObject({ seq: 2, prev: store.entries()[1]?.hash });
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
  });

  it("refuses unknown kinds, non-JSON bodies and appends after close without touching the file", async () => {
    const store = await openStore(dir, { clock });
    await expect(store.append("note" as EntryKind, {})).rejects.toThrow(TypeError);
    await expect(store.append("block", { price: 1.5 })).rejects.toThrow(JcsError);
    await store.close();
    await expect(store.append("block", {})).rejects.toThrow("store is closed");
    expect(logText()).toBe("");
    expect(await exists(lockPath())).toBe(false);
  });

  it("reads a tail entry larger than one read chunk", async () => {
    const store = await openStore(dir, { clock });
    await store.append("receipt", { big: "x".repeat(150_000) });
    const reopened = await openStore(dir, { clock });
    expect(await reopened.append("receipt", {})).toMatchObject({ seq: 1 });
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
  });
});

describe("lease", () => {
  it("makes two stores on one dir take turns: 2×100 interleaved appends give one chain of 200", async () => {
    const a = await openStore(dir);
    const b = await openStore(dir);
    const runs: Promise<Entry>[] = [];
    for (let i = 0; i < 100; i++) {
      runs.push(a.append("disclosure", { w: "a", i }), b.append("disclosure", { w: "b", i }));
    }
    const appended = await Promise.all(runs);
    const entries = a.entries();
    expect(entries).toHaveLength(200);
    expect(verifyChain(entries)).toEqual({ ok: true });
    expect(new Set(appended.map((e) => e.seq)).size).toBe(200);
    for (const w of ["a", "b"]) {
      const order = entries.filter((e) => (e.body as { w: string }).w === w).map((e) => (e.body as { i: number }).i);
      expect(order).toEqual([...Array(100).keys()]);
    }
    expect(await exists(lockPath())).toBe(false);
  });

  it("writes {token, holder, expires_at} while held; the holder is informational", async () => {
    let seen: unknown;
    const fs = patchedAppends((h) => {
      const real = h.datasync.bind(h);
      Object.assign(h, {
        datasync: async () => {
          seen = JSON.parse(readFileSync(lockPath(), "utf8"));
          return real();
        },
      });
    });
    const store = await openStore(dir, { clock, fs, pid: 4242, host: "box" });
    await store.append("session", {});
    expect((seen as { token: string }).token).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toMatchObject({ holder: "box:4242", expires_at: T0 + LEASE });
  });

  it("takes over an expired lease by rename, even one naming its own pid", async () => {
    await fsp.mkdir(dir, { recursive: true });
    const stale = { token: "stale", holder: `box:${String(process.pid)}`, expires_at: T0 - 1 };
    await fsp.writeFile(lockPath(), JSON.stringify(stale));
    const renames: string[][] = [];
    const fs: StoreFs = {
      ...fsp,
      rename: async (from, to) => {
        renames.push([String(from), String(to)]);
        return fsp.rename(from, to);
      },
    };
    const store = await openStore(dir, { clock, fs, host: "box" });
    expect(await store.append("session", {})).toMatchObject({ seq: 0 });
    expect(renames).toEqual([[expect.stringMatching(/audit\.lock\..+\.tmp$/), lockPath()]]);
    expect(await fsp.readdir(dir)).toEqual(["audit.jsonl"]);
  });

  it("treats an unreadable lock file as expired", async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(lockPath(), "{not json");
    const store = await openStore(dir, { clock });
    expect(await store.append("session", {})).toMatchObject({ seq: 0 });
  });

  it("waits for a live lease and takes it over once the clock passes its expiry", async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(lockPath(), JSON.stringify({ token: "live", holder: "x:1", expires_at: T0 + 1000 }));
    const store = await openStore(dir, { clock });
    let done = false;
    const run = store.append("session", {}).then((e) => ((done = true), e));
    await tick();
    expect(done).toBe(false);
    expect(logText()).toBe("");
    now = T0 + 1000;
    expect(await run).toMatchObject({ seq: 0 });
  });

  it("waits when another writer creates the lock between its read and its link", async () => {
    let raced = false;
    const fs: StoreFs = {
      ...fsp,
      link: async (from, to) => {
        if (!raced) {
          raced = true;
          await fsp.writeFile(lockPath(), JSON.stringify({ token: "other", holder: "x:1", expires_at: T0 + 10 }));
        }
        return fsp.link(from, to);
      },
    };
    const store = await openStore(dir, { clock, fs });
    const run = store.append("session", {});
    await tick();
    now = T0 + 10;
    expect(await run).toMatchObject({ seq: 0 });
  });

  it("retries when a concurrent takeover replaces its lease right after its rename", async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(lockPath(), JSON.stringify({ token: "old", holder: "x:1", expires_at: T0 - 1 }));
    let raced = false;
    const fs: StoreFs = {
      ...fsp,
      rename: async (from, to) => {
        await fsp.rename(from, to);
        if (!raced) {
          raced = true;
          await fsp.writeFile(lockPath(), JSON.stringify({ token: "thief", holder: "x:2", expires_at: T0 - 1 }));
        }
      },
    };
    const store = await openStore(dir, { clock, fs });
    expect(await store.append("session", {})).toMatchObject({ seq: 0 });
  });

  it("renews its lease during a long run of appends", async () => {
    let renews = 0;
    const fs: StoreFs = {
      ...fsp,
      rename: async (from, to) => {
        renews++;
        return fsp.rename(from, to);
      },
    };
    const store = await openStore(dir, { clock: () => (now += 100), fs, leaseMs: 1000 });
    const runs = Array.from({ length: 10 }, (_, i) => store.append("disclosure", { i }));
    await Promise.all(runs);
    expect(renews).toBeGreaterThan(0);
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
  });

  it("surfaces lock errors other than a missing file", async () => {
    const fs: StoreFs = { ...fsp, readFile: () => Promise.reject(errno("EACCES")) };
    await expect((await openStore(dir, { clock, fs })).append("session", {})).rejects.toThrow("EACCES");
    const fs2: StoreFs = { ...fsp, link: () => Promise.reject(errno("EPERM")) };
    await expect((await openStore(dir, { clock, fs: fs2 })).append("session", {})).rejects.toThrow("EPERM");
  });
});

describe("paused holder (attack)", () => {
  for (const [nth, where, reason] of [
    [1, "right after acquiring the lease", "the lease is held by another writer"],
    [2, "after its lease check, before its tail check", "the chain's tail moved since this handle last wrote"],
  ] as const) {
    it(`refuses A's append when A paused ${where} and B took over`, async () => {
      const paused = pauseAtRead(nth);
      const a = await openStore(dir, { clock, fs: paused.fs });
      const aRun = a.append("disclosure", { from: "a" });
      await paused.gate.reached;

      now = T0 + LEASE + 1;
      const b = await openStore(dir, { clock });
      const bEntry = await b.append("disclosure", { from: "b" });

      paused.gate.open();
      await expect(aRun).rejects.toThrow(new StoreFencedError(reason));
      await expect(a.append("disclosure", { from: "a again" })).rejects.toThrow(StoreFencedError);

      expect(b.entries()).toEqual([bEntry]);
      expect(logText()).not.toContain('"from":"a');
      expect(verifyChain(readChain(dir))).toEqual({ ok: true });
      expect(await b.append("disclosure", { from: "b" })).toMatchObject({ seq: 1 });
    });
  }

  it("refuses A's append when A's own lease expired while it was paused, even with no successor", async () => {
    const paused = pauseAtRead(1);
    const a = await openStore(dir, { clock, fs: paused.fs });
    const aRun = a.append("disclosure", {});
    await paused.gate.reached;
    now = T0 + LEASE;
    paused.gate.open();
    await expect(aRun).rejects.toThrow("the lease expired");
    expect(logText()).toBe("");
  });

  for (const [what, line] of [
    ["a line that is not an entry", () => '{"intruder":true}\n'],
    ["a valid entry chained after ours", () => `${canonicalize(rechained(readChain(dir).at(-1) as Entry))}\n`],
  ] as const) {
    it(`refuses and reports when ${what} lands right after its write (a writer ignoring the lease)`, async () => {
      const fs = patchedAppends((h) => {
        const real = h.datasync.bind(h);
        Object.assign(h, {
          datasync: async () => {
            await real();
            appendFileSync(logPath(), line());
          },
        });
      });
      const store = await openStore(dir, { clock, fs });
      await expect(store.append("disclosure", {})).rejects.toThrow("the chain's tail after the write is not this entry");
      await expect(store.append("disclosure", {})).rejects.toThrow(StoreFencedError);
    });
  }
});

/** A valid entry chained after `last`, as a second writer would append it. */
function rechained(last: Entry): Entry {
  const fields = { body: {}, kind: "session" as const, prev: last.hash, seq: last.seq + 1, ts: "t" };
  return { ...fields, hash: sha256Hex(canonicalize(fields)) };
}

describe("write failures (attack: log before send)", () => {
  async function failing(patch: (h: fsp.FileHandle) => void) {
    await (await filled(2)).close();
    const text = logText();
    const store = await openStore(dir, { clock, fs: patchedAppends(patch) });
    return { store, text };
  }
  const partialThen = (result: () => unknown) => async (buf: Buffer) => {
    await fsp.appendFile(logPath(), buf.subarray(0, 10));
    return result();
  };

  it("rejects when fdatasync fails, cuts the line back off and refuses later appends", async () => {
    const { store, text } = await failing((h) => Object.assign(h, { datasync: () => Promise.reject(errno("EIO")) }));
    await expect(store.append("disclosure", {})).rejects.toThrow("EIO");
    expect(logText()).toBe(text);
    await expect(store.append("disclosure", {})).rejects.toThrow(StoreFencedError);
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
  });

  it("rejects on ENOSPC after a partial write and leaves no partial line", async () => {
    const { store, text } = await failing((h) =>
      Object.assign(h, { write: partialThen(() => Promise.reject(errno("ENOSPC"))) }),
    );
    await expect(store.append("disclosure", {})).rejects.toThrow("ENOSPC");
    expect(logText()).toBe(text);
    expect(store.entries()).toHaveLength(2);
  });

  it("rejects a short write that reports fewer bytes than the line", async () => {
    const { store, text } = await failing((h) => Object.assign(h, { write: partialThen(() => ({ bytesWritten: 10 })) }));
    await expect(store.append("disclosure", {})).rejects.toThrow("short write");
    expect(logText()).toBe(text);
  });

  it("leaves a torn final line when the cut-back also fails; entries() reports it, verifyChain flags it", async () => {
    const { store } = await failing((h) =>
      Object.assign(h, {
        write: partialThen(() => Promise.reject(errno("ENOSPC"))),
        truncate: () => Promise.reject(errno("EIO")),
      }),
    );
    await expect(store.append("disclosure", {})).rejects.toThrow("ENOSPC");
    expect(() => store.entries()).toThrow(StoreCorruptError);
    expect(verifyChain(readChain(dir))).toMatchObject({ ok: false, brokenSeq: 2 });
    const next = await openStore(dir, { clock });
    await expect(next.append("disclosure", {})).rejects.toThrow(StoreCorruptError);
    expect(await exists(lockPath())).toBe(false);
  });
});

