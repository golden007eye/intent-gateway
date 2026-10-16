// The append side of the local hash chain: one JSONL file guarded by a fenced lease lock (ADR-0007).
//
// Invariant 2 (log before send) rests on this file: append() resolves only once the entry is on disk and is the
// chain's tail, and it rejects whenever that cannot be shown, so the caller's send does not happen.
//
// Lease: `audit.lock` holds {token, holder, expires_at}. A writer creates it with link() (fails if present) or
// takes over an expired one with rename(); both publish a complete file in one step. The lease is held while the
// handle has appends queued and is released when the queue drains, so writers on one data directory take turns.
// Liveness comes only from expires_at, never from the holder's pid, which means nothing across pid namespaces. A
// holder killed mid-append leaves its lease behind until it expires; a handle waiting on it longer than
// waitNoticeMs calls onWait once, so the CLI can say what it waits for.
//
// Fencing: before each write the handle checks that the lock still holds its token, unexpired, and that the file's
// tail is the head it last saw; after the write it checks that the tail is its own entry. Any mismatch throws
// StoreFencedError and the handle refuses every later append, so a holder that was paused past its expiry cannot
// write after its successor.
//
// Verify on acquire: each time the handle takes the lease it verifies every entry appended since the head it last
// verified, which on its first acquire is the whole file. A broken chain throws StoreCorruptError and the handle
// refuses every later append, so a restarted gateway does not extend a chain a stray writer has damaged.
//
// Paths: the data dir, `audit.jsonl` and `audit.lock` must not be symbolic links, and the data dir must belong to
// the current user, so a planted link cannot redirect the chain or its chmod to another file.

import { randomUUID } from "node:crypto";
import { constants, openSync, readFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { canonicalize } from "../jcs/index.ts";
import {
  type Entry,
  type EntryKind,
  entryHash,
  entryProblem,
  GENESIS,
  isEntryKind,
  parseLines,
  verifyChain,
} from "./chain.ts";

export type StoreFs = Pick<
  typeof nodeFs,
  "chmod" | "link" | "lstat" | "mkdir" | "open" | "readFile" | "rename" | "unlink" | "writeFile"
>;

export interface StoreOptions {
  /** Milliseconds since the epoch. Drives entry timestamps and lease expiry. */
  readonly clock?: () => number;
  /** Recorded in the lease as holder information only; never used to judge liveness. */
  readonly pid?: number;
  readonly host?: string;
  readonly leaseMs?: number;
  readonly fs?: StoreFs;
  /**
   * Called once per wait for the lease, when another holder's unexpired lease has kept this handle waiting for
   * `waitNoticeMs` (default 1000), so a caller can say what it waits for instead of hanging silently. The wait itself
   * is unchanged: it ends when the holder releases the lease or the lease expires.
   */
  readonly onWait?: (wait: LeaseWait) => void;
  readonly waitNoticeMs?: number;
}

/** The lease a handle is waiting on: the lock file, its holder (`host:pid`, information only) and its expiry. */
export interface LeaseWait {
  readonly lock: string;
  readonly holder: string;
  readonly expiresAt: Date;
}

export interface Store {
  /** Appends one entry and resolves once it is fdatasync'd and confirmed as the chain's tail. */
  append(kind: EntryKind, body: unknown): Promise<Entry>;
  /** Every entry in the file, unverified (see verifyChain). Throws StoreCorruptError on a line that is not an entry. */
  entries(): Entry[];
  /** Waits for queued appends, then releases the lease. */
  close(): Promise<void>;
}

/** The handle lost its lease or the chain moved under it; it refuses all further appends. */
export class StoreFencedError extends Error {
  override name = "StoreFencedError";
}

/** The file holds a line that is not a valid entry, or the chain is broken, so the store will not extend it. */
export class StoreCorruptError extends Error {
  override name = "StoreCorruptError";
}

/** A store path is a symbolic link, or the data dir is not a directory owned by the current user. */
export class StoreUnsafeError extends Error {
  override name = "StoreUnsafeError";
}

interface Lease {
  readonly token: string;
  readonly holder: string;
  readonly expires_at: number;
}

interface Tail {
  readonly size: number;
  readonly hash: string;
  readonly seq: number;
}

const LOG = "audit.jsonl";
const LOCK = "audit.lock";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WAIT_NOTICE_MS = 1000;
const POLL_MS = 2;
// O_NOFOLLOW makes open() fail on a symbolic link; Windows has no such flag, and there the lstat checks in
// openStore are the only guard.
const NOFOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;
const READ = constants.O_RDONLY | NOFOLLOW;
const APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW;

/** Reads the chain in `dir` as `parseLines` items, for verifyChain, without opening a store. */
export function readChain(dir: string): unknown[] {
  const file = join(dir, LOG);
  return parseLines(readFileSync(noFollowSync(() => openSync(file, READ), file), "utf8"));
}

export async function openStore(dir: string, opts: StoreOptions = {}): Promise<Store> {
  const fs = opts.fs ?? nodeFs;
  await checkDir(fs, dir, true);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await checkDir(fs, dir, false);
  await fs.chmod(dir, 0o700);
  const lock = await fs.lstat(join(dir, LOCK)).catch(missing);
  if (lock?.isSymbolicLink() === true) throw new StoreUnsafeError(`${join(dir, LOCK)} is a symbolic link`);
  const file = join(dir, LOG);
  const handle = await noFollow(fs.open(file, APPEND, 0o600), file);
  try {
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return new FileStore(dir, fs, opts);
}

/** Refuses a data dir that is a symbolic link, not a directory, or owned by another user (not checked on Windows). */
async function checkDir(fs: StoreFs, dir: string, mayBeMissing: boolean): Promise<void> {
  const info = mayBeMissing ? await fs.lstat(dir).catch(missing) : await fs.lstat(dir);
  if (info === null) return;
  if (info.isSymbolicLink()) throw new StoreUnsafeError(`the data dir ${dir} is a symbolic link`);
  if (!info.isDirectory()) throw new StoreUnsafeError(`the data dir ${dir} is not a directory`);
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new StoreUnsafeError(`the data dir ${dir} is owned by uid ${String(info.uid)}, not the current user`);
  }
}

function missing(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

/** O_NOFOLLOW reports a symbolic link as ELOOP (EMLINK on FreeBSD); both become StoreUnsafeError. */
function isLinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EMLINK";
}

async function noFollow<T>(open: Promise<T>, path: string): Promise<T> {
  try {
    return await open;
  } catch (error) {
    if (isLinkError(error)) throw new StoreUnsafeError(`${path} is a symbolic link`);
    throw error;
  }
}

function noFollowSync<T>(open: () => T, path: string): T {
  try {
    return open();
  } catch (error) {
    if (isLinkError(error)) throw new StoreUnsafeError(`${path} is a symbolic link`);
    throw error;
  }
}

class FileStore implements Store {
  readonly #fs: StoreFs;
  readonly #dir: string;
  readonly #file: string;
  readonly #lock: string;
  readonly #clock: () => number;
  readonly #holder: string;
  readonly #leaseMs: number;
  readonly #onWait: ((wait: LeaseWait) => void) | undefined;
  readonly #waitNoticeMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #closed = false;
  #fenced: string | null = null;
  #broken: string | null = null;
  #lease: Lease | null = null;
  #dirSynced = false;
  /** The head this handle last verified or wrote; on first acquire, genesis, so the whole file is verified. */
  #tail: Tail = { size: 0, hash: GENESIS, seq: -1 };

  constructor(dir: string, fs: StoreFs, opts: StoreOptions) {
    this.#fs = fs;
    this.#dir = dir;
    this.#file = join(dir, LOG);
    this.#lock = join(dir, LOCK);
    this.#clock = opts.clock ?? Date.now;
    this.#holder = `${opts.host ?? hostname()}:${String(opts.pid ?? process.pid)}`;
    this.#leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.#onWait = opts.onWait;
    this.#waitNoticeMs = opts.waitNoticeMs ?? DEFAULT_WAIT_NOTICE_MS;
  }

  async append(kind: EntryKind, body: unknown): Promise<Entry> {
    // Checked synchronously, before anything is queued, so a refused entry never touches the lease or the file.
    if (this.#closed) throw new Error("store is closed");
    if (!isEntryKind(kind)) throw new TypeError(`unknown entry kind: ${String(kind)}`);
    canonicalize(body);
    this.#pending++;
    const run = this.#queue
      .then(() => this.#appendOne(kind, body))
      .finally(async () => {
        if (--this.#pending === 0) await this.#release();
      });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  entries(): Entry[] {
    return readChain(this.#dir).map((item, seq) => {
      if (typeof item === "string") throw new StoreCorruptError(`line ${String(seq)} is not a canonical JSON entry`);
      return item as Entry;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
  }

  async #appendOne(kind: EntryKind, body: unknown): Promise<Entry> {
    if (this.#broken !== null) throw new StoreCorruptError(`handle refused after: ${this.#broken}`);
    if (this.#fenced !== null) throw new StoreFencedError(`handle refused after: ${this.#fenced}`);
    if (this.#lease === null) await this.#acquire();
    else if (this.#lease.expires_at - this.#clock() < this.#leaseMs / 2) await this.#renew();
    await this.#checkFence();

    const before = this.#tail;
    const fields = { seq: before.seq + 1, prev: before.hash, ts: new Date(this.#clock()).toISOString(), kind, body };
    const entry: Entry = { ...fields, hash: entryHash(fields) };
    const line = Buffer.from(`${canonicalize(entry)}\n`, "utf8");
    await this.#write(line, before.size);

    const after = await this.#readTail().catch(() => null);
    if (after?.hash !== entry.hash || after.size !== before.size + line.length) {
      this.#refuse("the chain's tail after the write is not this entry");
    }
    this.#tail = after;
    return entry;
  }

  /** One write plus fdatasync. On failure the file is cut back to `size`, the handle is fenced, and the error rethrown. */
  async #write(line: Buffer, size: number): Promise<void> {
    const handle = await noFollow(this.#fs.open(this.#file, APPEND, 0o600), this.#file);
    try {
      const { bytesWritten } = await handle.write(line);
      if (bytesWritten !== line.length) throw new Error(`short write: ${String(bytesWritten)} of ${String(line.length)}`);
      await handle.datasync();
      if (!this.#dirSynced) await this.#syncDir();
    } catch (error) {
      this.#fenced = `write failed: ${(error as Error).message}`;
      await handle.truncate(size).then(() => handle.datasync()).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
  }

  /**
   * fsyncs the data dir, once per handle, after its first entry is on disk. fdatasync makes the entry durable but not
   * the directory entries of a newly created `audit.jsonl` and `audit.lock`; without this, POSIX allows a crash to
   * lose the whole file after the first send. Windows cannot open a directory for fsync, and there it is skipped.
   */
  async #syncDir(): Promise<void> {
    if (process.platform !== "win32") {
      const dir = await this.#fs.open(this.#dir, READ);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    this.#dirSynced = true;
  }

  async #acquire(): Promise<void> {
    const since = this.#clock();
    let noticed = false;
    for (;;) {
      const current = await this.#readLease();
      const now = this.#clock();
      if (current !== null && current !== "invalid" && current.expires_at > now) {
        if (!noticed && now - since >= this.#waitNoticeMs) {
          noticed = true;
          this.#onWait?.({ lock: this.#lock, holder: current.holder, expiresAt: new Date(current.expires_at) });
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      const lease = this.#newLease(now);
      const temp = await this.#writeTemp(lease);
      try {
        if (current === null) await this.#fs.link(temp, this.#lock);
        else await this.#fs.rename(temp, this.#lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        continue;
      } finally {
        await this.#fs.unlink(temp).catch(() => undefined);
      }
      const confirmed = await this.#readLease();
      if (confirmed === null || confirmed === "invalid" || confirmed.token !== lease.token) continue;
      this.#lease = lease;
      this.#tail = await this.#verifySince(this.#tail);
      return;
    }
  }

  async #renew(): Promise<void> {
    await this.#checkLease();
    const lease = this.#newLease(this.#clock());
    await this.#fs.rename(await this.#writeTemp(lease), this.#lock);
    this.#lease = lease;
  }

  async #release(): Promise<void> {
    const lease = this.#lease;
    this.#lease = null;
    if (lease === null) return;
    const current = await this.#readLease().catch(() => null);
    if (current !== null && current !== "invalid" && current.token === lease.token) {
      await this.#fs.unlink(this.#lock).catch(() => undefined);
    }
  }

  async #checkFence(): Promise<void> {
    await this.#checkLease();
    const tail = await this.#readTail();
    if (tail.hash !== this.#tail.hash || tail.size !== this.#tail.size) {
      this.#refuse("the chain's tail moved since this handle last wrote");
    }
  }

  async #checkLease(): Promise<void> {
    const current = await this.#readLease();
    if (current === null || current === "invalid" || current.token !== this.#lease?.token) {
      this.#refuse("the lease is held by another writer");
    }
    if (current.expires_at <= this.#clock()) this.#refuse("the lease expired");
  }

  /** Verifies the entries appended after `from` and returns the new head; a broken chain refuses the handle. */
  async #verifySince(from: Tail): Promise<Tail> {
    const handle = await noFollow(this.#fs.open(this.#file, READ), this.#file);
    try {
      const { size } = await handle.stat();
      if (size < from.size) this.#corrupt(`the chain is shorter than this handle last saw it`);
      const buf = Buffer.alloc(size - from.size);
      let read = 0;
      while (read < buf.length) {
        const { bytesRead } = await handle.read(buf, read, buf.length - read, from.size + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const items = parseLines(buf.subarray(0, read).toString("utf8"));
      const result = verifyChain(items, from);
      if (!result.ok) this.#corrupt(`the chain is broken at seq ${String(result.brokenSeq)}: ${result.reason}`);
      const last = items.at(-1) as Entry | undefined;
      return last === undefined ? from : { size: from.size + read, hash: last.hash, seq: last.seq };
    } finally {
      await handle.close();
    }
  }

  #corrupt(reason: string): never {
    this.#broken = reason;
    throw new StoreCorruptError(reason);
  }

  #refuse(reason: string): never {
    this.#fenced = reason;
    this.#lease = null;
    throw new StoreFencedError(reason);
  }

  #newLease(now: number): Lease {
    return { token: randomUUID(), holder: this.#holder, expires_at: now + this.#leaseMs };
  }

  async #writeTemp(lease: Lease): Promise<string> {
    const temp = `${this.#lock}.${lease.token}.tmp`;
    await this.#fs.writeFile(temp, JSON.stringify(lease), { mode: 0o600, flag: "wx" });
    return temp;
  }

  /** The lease in the lock file; null when there is none, "invalid" when it cannot be read as a lease. */
  async #readLease(): Promise<Lease | null | "invalid"> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#lock, { encoding: "utf8", flag: READ });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (isLinkError(error)) throw new StoreUnsafeError(`${this.#lock} is a symbolic link`);
      throw error;
    }
    try {
      const lease = JSON.parse(text) as Lease;
      if (typeof lease.token === "string" && Number.isSafeInteger(lease.expires_at)) return lease;
    } catch {
      // A lock that does not parse is treated as expired.
    }
    return "invalid";
  }

  /** The last line of the file, which must be a valid entry; reads backwards so cost does not grow with the chain. */
  async #readTail(): Promise<Tail> {
    const handle = await noFollow(this.#fs.open(this.#file, READ), this.#file);
    try {
      const { size } = await handle.stat();
      if (size === 0) return { size, hash: GENESIS, seq: -1 };
      let position = size;
      let chunk = Buffer.alloc(0);
      let start = -1;
      while (start < 0 && position > 0) {
        const length = Math.min(65_536, position);
        position -= length;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, position);
        chunk = Buffer.concat([buf, chunk]);
        start = chunk.lastIndexOf(0x0a, chunk.length - 2);
      }
      const items = parseLines(chunk.subarray(start + 1).toString("utf8"));
      const problem = items.length === 1 ? entryProblem(items[0]) : "the last line is torn";
      if (problem !== null) throw new StoreCorruptError(`the chain's last line is not a valid entry: ${problem}`);
      const entry = items[0] as Entry;
      return { size, hash: entry.hash, seq: entry.seq };
    } finally {
      await handle.close();
    }
  }
}
