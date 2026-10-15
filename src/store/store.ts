// The append side of the local hash chain: one JSONL file guarded by a fenced lease lock (ADR-0007).
//
// Invariant 2 (log before send) rests on this file: append() resolves only once the entry is on disk and is the
// chain's tail, and it rejects whenever that cannot be shown, so the caller's send does not happen.
//
// Lease: `audit.lock` holds {token, holder, expires_at}. A writer creates it with link() (fails if present) or
// takes over an expired one with rename(); both publish a complete file in one step. The lease is held while the
// handle has appends queued and is released when the queue drains, so writers on one data directory take turns.
// Liveness comes only from expires_at, never from the holder's pid, which means nothing across pid namespaces.
//
// Fencing: before each write the handle checks that the lock still holds its token, unexpired, and that the file's
// tail is the head it last saw; after the write it checks that the tail is its own entry. Any mismatch throws
// StoreFencedError and the handle refuses every later append, so a holder that was paused past its expiry cannot
// write after its successor.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { canonicalize } from "../jcs/index.ts";
import { type Entry, type EntryKind, entryHash, entryProblem, GENESIS, isEntryKind, parseLines } from "./chain.ts";

export type StoreFs = Pick<
  typeof nodeFs,
  "chmod" | "link" | "mkdir" | "open" | "readFile" | "rename" | "unlink" | "writeFile"
>;

export interface StoreOptions {
  /** Milliseconds since the epoch. Drives entry timestamps and lease expiry. */
  readonly clock?: () => number;
  /** Recorded in the lease as holder information only; never used to judge liveness. */
  readonly pid?: number;
  readonly host?: string;
  readonly leaseMs?: number;
  readonly fs?: StoreFs;
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

/** The file holds a line that is not a valid entry, so the store will not read or extend it. */
export class StoreCorruptError extends Error {
  override name = "StoreCorruptError";
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
const POLL_MS = 2;

/** Reads the chain in `dir` as `parseLines` items, for verifyChain, without opening a store. */
export function readChain(dir: string): unknown[] {
  return parseLines(readFileSync(join(dir, LOG), "utf8"));
}

export async function openStore(dir: string, opts: StoreOptions = {}): Promise<Store> {
  const fs = opts.fs ?? nodeFs;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = join(dir, LOG);
  await (await fs.open(file, "a", 0o600)).close();
  await fs.chmod(file, 0o600);
  return new FileStore(dir, fs, opts);
}

class FileStore implements Store {
  readonly #fs: StoreFs;
  readonly #dir: string;
  readonly #file: string;
  readonly #lock: string;
  readonly #clock: () => number;
  readonly #holder: string;
  readonly #leaseMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #closed = false;
  #fenced: string | null = null;
  #lease: Lease | null = null;
  #tail: Tail = { size: 0, hash: GENESIS, seq: -1 };

  constructor(dir: string, fs: StoreFs, opts: StoreOptions) {
    this.#fs = fs;
    this.#dir = dir;
    this.#file = join(dir, LOG);
    this.#lock = join(dir, LOCK);
    this.#clock = opts.clock ?? Date.now;
    this.#holder = `${opts.host ?? hostname()}:${String(opts.pid ?? process.pid)}`;
    this.#leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
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
    const handle = await this.#fs.open(this.#file, "a", 0o600);
    try {
      const { bytesWritten } = await handle.write(line);
      if (bytesWritten !== line.length) throw new Error(`short write: ${String(bytesWritten)} of ${String(line.length)}`);
      await handle.datasync();
    } catch (error) {
      this.#fenced = `write failed: ${(error as Error).message}`;
      await handle.truncate(size).then(() => handle.datasync()).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
  }

  async #acquire(): Promise<void> {
    for (;;) {
      const current = await this.#readLease();
      const now = this.#clock();
      if (current !== null && current !== "invalid" && current.expires_at > now) {
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
      this.#tail = await this.#readTail();
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
      text = await this.#fs.readFile(this.#lock, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
    const handle = await this.#fs.open(this.#file, "r");
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
