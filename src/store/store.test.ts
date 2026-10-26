// The append side: permissions, the fenced lease, and write failures. Attack cases for invariant 2 (log before
// send): a paused holder, a writer that ignores the lease, and failed or partial writes must all reject the append,
// because a rejected append is what stops the disclosure module's send.
//
// fsync latency on a busy disk can reach seconds, so this file runs with a 20 s timeout, and tests that do not
// exercise durability use `fast`, an fs whose datasync is a no-op. The 2×100 test and the write-failure tests keep
// the real datasync.
import { appendFileSync, constants, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, JcsError, sha256Hex } from "../jcs/index.ts";
import {
  type Entry,
  type EntryKind,
  openStore,
  readChain,
  StoreConflictError,
  StoreCorruptError,
  StoreFencedError,
  type StoreFs,
  StoreUnsafeError,
  verifyChain,
} from "./index.ts";

vi.setConfig({ testTimeout: 20_000 });

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
const isRead = (flags: unknown) => flags === (constants.O_RDONLY | ((constants as Partial<typeof constants>).O_NOFOLLOW ?? 0));
const isAppend = (flags: unknown) => typeof flags === "number" && (flags & constants.O_APPEND) !== 0;

/** The real fs with a no-op datasync, for tests that do not exercise durability. */
const fast: StoreFs = {
  ...fsp,
  open: (async (...args: Parameters<typeof fsp.open>) =>
    Object.assign(await fsp.open(...args), { datasync: () => Promise.resolve() })),
};

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
    ...fast,
    open: (async (...args: Parameters<typeof fsp.open>) => {
      if (args[0] === logPath() && isRead(args[1]) && ++reads === nth) await g.wait();
      return fast.open(...args);
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
      if (isAppend(args[1]) && args[0] === logPath()) patch(handle);
      return handle;
    }),
  };
}

async function filled(n: number) {
  const store = await openStore(dir, { clock, fs: fast });
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
    const store = await openStore(dir, { clock, fs: fast });
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
    const store = await openStore(dir, { clock, fs: fast });
    expect(await store.append("keys", {})).toMatchObject({ seq: 2, prev: store.entries()[1]?.hash });
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
  });

  it("refuses unknown kinds, non-JSON bodies and appends after close without touching the file", async () => {
    const store = await openStore(dir, { clock, fs: fast });
    await expect(store.append("note" as EntryKind, {})).rejects.toThrow(TypeError);
    await expect(store.append("block", { price: 1.5 })).rejects.toThrow(JcsError);
    await store.close();
    await expect(store.append("block", {})).rejects.toThrow("store is closed");
    expect(logText()).toBe("");
    expect(await exists(lockPath())).toBe(false);
  });

  it("reads a tail entry larger than one read chunk", async () => {
    const store = await openStore(dir, { clock, fs: fast });
    await store.append("receipt", { big: "x".repeat(150_000) });
    const reopened = await openStore(dir, { clock, fs: fast });
    expect(await reopened.append("receipt", {})).toMatchObject({ seq: 1 });
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
  });
});

describe("directory fsync (a new audit.jsonl survives a crash)", () => {
  /** `fast`, recording each datasync of the log and each open and sync of the data dir, in order. */
  function recording(syncDir: () => Promise<void> = () => Promise.resolve()) {
    const calls: string[] = [];
    const fs: StoreFs = {
      ...fast,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fast.open(...args);
        if (args[0] === dir) {
          calls.push(isRead(args[1]) ? "open dir" : "open dir (not read-only)");
          return Object.assign(handle, { sync: () => (calls.push("sync dir"), syncDir()) });
        }
        if (args[0] === logPath() && isAppend(args[1])) {
          return Object.assign(handle, { datasync: () => (calls.push("datasync log"), Promise.resolve()) });
        }
        return handle;
      }),
    };
    return { fs, calls };
  }

  it("fsyncs the data dir once, after the first entry is datasync'd, before the append resolves", async () => {
    const { fs, calls } = recording();
    const store = await openStore(dir, { clock, fs });
    expect(calls).toEqual([]);
    await store.append("session", { i: 0 });
    expect(calls).toEqual(["datasync log", "open dir", "sync dir"]);
    await store.append("session", { i: 1 });
    expect(calls).toEqual(["datasync log", "open dir", "sync dir", "datasync log"]);
    await store.close();
  });

  it("refuses the first append when the dir fsync fails, and leaves nothing in the file (attack: log before send)", async () => {
    const { fs } = recording(() => Promise.reject(errno("EIO")));
    const store = await openStore(dir, { clock, fs });
    await expect(store.append("disclosure", { field: "zip" })).rejects.toThrow("EIO");
    expect(logText()).toBe("");
    await expect(store.append("disclosure", { field: "zip" })).rejects.toThrow(StoreFencedError);
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
      ...fast,
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
    const store = await openStore(dir, { clock, fs: fast });
    expect(await store.append("session", {})).toMatchObject({ seq: 0 });
  });

  it("waits for a live lease and takes it over once the clock passes its expiry", async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(lockPath(), JSON.stringify({ token: "live", holder: "x:1", expires_at: T0 + 1000 }));
    const store = await openStore(dir, { clock, fs: fast });
    let done = false;
    const run = store.append("session", {}).then((e) => ((done = true), e));
    await tick();
    expect(done).toBe(false);
    expect(logText()).toBe("");
    now = T0 + 1000;
    expect(await run).toMatchObject({ seq: 0 });
  });

  it("says once what it waits for after waitNoticeMs: the lock, its holder and its expiry (F-l)", async () => {
    await fsp.mkdir(dir, { recursive: true });
    // What a holder killed mid-append leaves: its lease, unexpired, naming a pid that no longer runs.
    await fsp.writeFile(lockPath(), JSON.stringify({ token: "killed", holder: "box:999999", expires_at: T0 + 30_000 }));
    const waits: unknown[] = [];
    // Each step waits for the store to poll the lock twice more, so a busy machine cannot skip a clock setting.
    let polls = 0;
    const fs: StoreFs = {
      ...fast,
      readFile: ((...args: Parameters<typeof fsp.readFile>) => {
        if (args[0] === lockPath()) polls++;
        return fsp.readFile(...args);
      }) as typeof fsp.readFile,
    };
    const polled = async (): Promise<void> => {
      const target = polls + 2;
      while (polls < target) await tick();
    };
    const store = await openStore(dir, { clock, fs, waitNoticeMs: 1000, onWait: (w) => waits.push(w) });
    const run = store.append("session", {});
    await polled();
    now = T0 + 999;
    await polled();
    expect(waits).toEqual([]);
    now = T0 + 1000;
    await polled();
    now = T0 + 5000;
    await polled();
    expect(waits).toEqual([{ lock: lockPath(), holder: "box:999999", expiresAt: new Date(T0 + 30_000) }]);
    // Attack (single writer): a dead-looking pid is never a reason to take over; only the expiry is.
    expect(logText()).toBe("");
    now = T0 + 30_000;
    expect(await run).toMatchObject({ seq: 0 });
    expect(waits).toHaveLength(1);
  });

  it("says nothing when the lease is free or expired, or freed before waitNoticeMs", async () => {
    const waits: unknown[] = [];
    const onWait = (w: unknown) => waits.push(w);
    const store = await openStore(dir, { clock, fs: fast, onWait });
    await store.append("session", {});
    await fsp.writeFile(lockPath(), JSON.stringify({ token: "old", holder: "box:1", expires_at: T0 - 1 }));
    await store.append("session", {});
    await fsp.writeFile(lockPath(), JSON.stringify({ token: "brief", holder: "box:2", expires_at: T0 + 30_000 }));
    const run = store.append("session", {});
    now = T0 + 500;
    await tick();
    await fsp.unlink(lockPath());
    expect(await run).toMatchObject({ seq: 2 });
    expect(waits).toEqual([]);
  });

  it("waits when another writer creates the lock between its read and its link", async () => {
    let raced = false;
    const fs: StoreFs = {
      ...fast,
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
      ...fast,
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
      ...fast,
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
    const fs: StoreFs = { ...fast, readFile: () => Promise.reject(errno("EACCES")) };
    await expect((await openStore(dir, { clock, fs })).append("session", {})).rejects.toThrow("EACCES");
    const fs2: StoreFs = { ...fast, link: () => Promise.reject(errno("EPERM")) };
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
      const b = await openStore(dir, { clock, fs: fast });
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
    const next = await openStore(dir, { clock, fs: fast });
    await expect(next.append("disclosure", {})).rejects.toThrow(StoreCorruptError);
    expect(await exists(lockPath())).toBe(false);
  });
});

describe("any append failure fences the handle (attack: no answer lost mid-chain)", () => {
  // A disclosure whose follow-up append failed must stay the last thing this handle wrote: if a later append could
  // succeed, the unanswered disclosure would sit inside the chain with later sends after it. Each case fails one
  // fs call once with an error that is not a fence, then checks the next append is refused and nothing is written.
  type Method = "open" | "readFile" | "writeFile" | "link";
  function failOnce(method: Method, when: (args: unknown[]) => boolean, code: string): StoreFs {
    let armed = false;
    let done = false;
    const wrap =
      (name: Method) =>
      (...args: unknown[]): Promise<unknown> => {
        if (armed && !done && name === method && when(args)) {
          done = true;
          return Promise.reject(errno(code));
        }
        return (fast[name] as (...a: unknown[]) => Promise<unknown>)(...args);
      };
    const fs = { ...fast, open: wrap("open"), readFile: wrap("readFile"), writeFile: wrap("writeFile"), link: wrap("link") } as StoreFs;
    return Object.assign(fs, { arm: () => (armed = true) });
  }
  const cases: [string, Method, (args: unknown[]) => boolean, string, boolean][] = [
    ["the append-mode open of audit.jsonl", "open", (a) => a[0] === logPath() && isAppend(a[1]), "EMFILE", false],
    ["the read of audit.jsonl in verify-on-acquire", "open", (a) => a[0] === logPath() && isRead(a[1]), "EMFILE", true],
    ["the read of the lease file", "readFile", (a) => a[0] === lockPath(), "EACCES", true],
    ["the write of the lease temp file", "writeFile", () => true, "ENOSPC", true],
    ["the link that publishes the lease", "link", () => true, "EPERM", true],
  ];
  for (const [what, method, when, code, onAcquire] of cases) {
    it(`fences on ${code} from ${what}`, async () => {
      await (await filled(2)).close();
      const fs = failOnce(method, when, code);
      const store = await openStore(dir, { clock, fs });
      // Warm the handle (lease taken, chain verified) unless the failure is one only a fresh acquire hits.
      if (!onAcquire) await store.append("session", { warm: true });
      (fs as StoreFs & { arm: () => void }).arm();
      const text = logText();
      await expect(store.append("disclosure", { n: 1 })).rejects.toThrow(code);
      await expect(store.append("disclosure", { n: 2 })).rejects.toThrow(StoreFencedError);
      expect(logText()).toBe(text);
      expect(verifyChain(readChain(dir))).toEqual({ ok: true });
    });
  }
});

describe("verify on acquire (attack: a broken chain is not extended)", () => {
  const firstLine = () => `${logText().split("\n")[0] as string}\n`;

  it("refuses a restarted handle when a stray writer appended a well-formed duplicate of entry 0", async () => {
    await (await filled(2)).close();
    appendFileSync(logPath(), firstLine());
    const text = logText();
    expect(verifyChain(readChain(dir))).toMatchObject({ ok: false, brokenSeq: 2 });

    const restarted = await openStore(dir, { clock, fs: fast });
    await expect(restarted.append("disclosure", {})).rejects.toThrow(
      new StoreCorruptError("the log is broken at entry #2: seq is 0, expected 2"),
    );
    await expect(restarted.append("disclosure", {})).rejects.toThrow(StoreCorruptError);
    expect(logText()).toBe(text);
    expect(await exists(lockPath())).toBe(false);
  });

  it("refuses a restarted handle when an early entry was rewritten and re-hashed", async () => {
    await (await filled(3)).close();
    const lines = logText().split("\n");
    const entry = JSON.parse(lines[0] as string) as Entry;
    const fields = { body: { forged: true }, kind: entry.kind, prev: entry.prev, seq: entry.seq, ts: entry.ts };
    lines[0] = canonicalize({ ...fields, hash: sha256Hex(canonicalize(fields)) });
    await fsp.writeFile(logPath(), lines.join("\n"));
    const restarted = await openStore(dir, { clock, fs: fast });
    await expect(restarted.append("disclosure", {})).rejects.toThrow("the log is broken at entry #1");
  });

  it("refuses a running handle when a stray line landed between its turns", async () => {
    const store = await filled(2);
    appendFileSync(logPath(), firstLine());
    await expect(store.append("disclosure", {})).rejects.toThrow("the log is broken at entry #2");
    await expect(store.append("disclosure", {})).rejects.toThrow(StoreCorruptError);
  });

  it("refuses a running handle when the file is shorter than it last saw", async () => {
    const store = await filled(2);
    await fsp.writeFile(logPath(), firstLine());
    await expect(store.append("disclosure", {})).rejects.toThrow("the chain is shorter than this handle last saw it");
  });

  it("accepts entries another writer appended between its turns", async () => {
    const a = await filled(1);
    const b = await openStore(dir, { clock, fs: fast });
    await b.append("disclosure", { from: "b" });
    expect(await a.append("disclosure", { from: "a" })).toMatchObject({ seq: 2 });
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
  });
});

describe("paths (attack: a planted symbolic link or a foreign data dir)", () => {
  const linkError = /is a symbolic link/;

  it("refuses a data dir that is a symbolic link, without changing its target", async () => {
    const target = `${dir}-target`;
    await fsp.mkdir(target);
    await fsp.chmod(target, 0o755);
    await fsp.symlink(target, dir);
    await expect(openStore(dir)).rejects.toThrow(new StoreUnsafeError(`the data dir ${dir} is a symbolic link`));
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o755);
    expect(await fsp.readdir(target)).toEqual([]);
  });

  it("refuses a data dir that is not a directory", async () => {
    await fsp.writeFile(dir, "");
    await expect(openStore(dir)).rejects.toThrow(new StoreUnsafeError(`the data dir ${dir} is not a directory`));
  });

  it("refuses audit.jsonl as a symbolic link, without touching the file it points to", async () => {
    await fsp.mkdir(dir, { mode: 0o700 });
    const victim = `${dir}-victim.txt`;
    await fsp.writeFile(victim, "");
    await fsp.chmod(victim, 0o644);
    await fsp.symlink(victim, logPath());
    await expect(openStore(dir)).rejects.toThrow(linkError);
    expect((await fsp.stat(victim)).mode & 0o777).toBe(0o644);
    expect(() => readChain(dir)).toThrow(StoreUnsafeError);
  });

  it("refuses audit.lock as a symbolic link at open", async () => {
    await fsp.mkdir(dir, { mode: 0o700 });
    await fsp.symlink(`${dir}-elsewhere`, lockPath());
    await expect(openStore(dir)).rejects.toThrow(new StoreUnsafeError(`${lockPath()} is a symbolic link`));
  });

  it("refuses links planted after open: the lock before an append, the log before the next turn", async () => {
    const store = await openStore(dir, { clock, fs: fast });
    const leaseFile = `${dir}-lease.json`;
    await fsp.writeFile(leaseFile, JSON.stringify({ token: "t", holder: "x:1", expires_at: T0 - 1 }));
    await fsp.symlink(leaseFile, lockPath());
    await expect(store.append("disclosure", {})).rejects.toThrow(linkError);
    await fsp.unlink(lockPath());

    const other = await openStore(dir, { clock, fs: fast });
    const victim = `${dir}-victim.txt`;
    await fsp.writeFile(victim, "");
    await fsp.rename(logPath(), `${logPath()}.old`);
    await fsp.symlink(victim, logPath());
    await expect(other.append("disclosure", {})).rejects.toThrow(linkError);
    expect(await fsp.readFile(victim, "utf8")).toBe("");
  });

  it("refuses a data dir owned by another user before changing its mode", async () => {
    await fsp.mkdir(dir);
    await fsp.chmod(dir, 0o755);
    const chmods: string[] = [];
    const fs: StoreFs = {
      ...fast,
      lstat: (async (path: string) => {
        const info = await fsp.lstat(path);
        return path === dir ? Object.assign(info, { uid: info.uid + 1 }) : info;
      }) as typeof fsp.lstat,
      chmod: async (path, mode) => {
        chmods.push(String(path));
        return fsp.chmod(path, mode);
      },
    };
    await expect(openStore(dir, { fs })).rejects.toThrow(/is owned by uid \d+, not the current user/);
    expect(chmods).toEqual([]);
    expect((await fsp.stat(dir)).mode & 0o777).toBe(0o755);
  });

  it("surfaces lstat and open errors other than a missing file or a link", async () => {
    const fs: StoreFs = { ...fast, lstat: (() => Promise.reject(errno("EACCES"))) as typeof fsp.lstat };
    await expect(openStore(dir, { fs })).rejects.toThrow("EACCES");
    const fs2: StoreFs = { ...fast, open: () => Promise.reject(errno("EMFILE")) };
    await expect(openStore(dir, { fs: fs2 })).rejects.toThrow("EMFILE");
    await fsp.rm(dir, { recursive: true });
    expect(() => readChain(dir)).toThrow("ENOENT");
  });
});


describe("appendUnless: compare-and-append (plan G7b)", () => {
  it("writes when the conflict is absent; on a conflict writes nothing and the handle stays usable", async () => {
    const store = await openStore(dir, { clock });
    await store.appendUnless("completion", { handle: "ap_1" }, () => false);
    const has = (entries: readonly Entry[]) => entries.some((e) => e.kind === "completion");
    await expect(store.appendUnless("completion", { handle: "ap_1" }, has)).rejects.toBeInstanceOf(StoreConflictError);
    expect(store.entries().map((e) => e.kind)).toEqual(["completion"]);
    await store.append("observed", { n: 1 });
    expect(store.entries().map((e) => e.kind)).toEqual(["completion", "observed"]);
    expect(verifyChain(store.entries()).ok).toBe(true);
    await store.close();
  });

  it("sees what another handle appended: the conflict is judged under the lease, after catching up", async () => {
    const a = await openStore(dir, { clock });
    const b = await openStore(dir, { clock });
    await b.append("observed", { warm: true });
    await a.append("complete_attempt", { handle: "ap_1", owner: "a" });
    const attempted = (entries: readonly Entry[]) => entries.some((e) => e.kind === "complete_attempt");
    await expect(b.appendUnless("complete_attempt", { handle: "ap_1", owner: "b" }, attempted)).rejects.toBeInstanceOf(StoreConflictError);
    await b.append("observed", { after: true });
    expect(b.entries().filter((e) => e.kind === "complete_attempt")).toHaveLength(1);
    expect(verifyChain(b.entries()).ok).toBe(true);
    await a.close();
    await b.close();
  });
});
