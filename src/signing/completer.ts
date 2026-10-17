// The completer keys of open purchases (contract 1.6.0; ADR-0016): one file per key, `<data>/completer/<keyid>.key`,
// mode 0600 in a 0700 folder that must be a real directory owned by the current user, as the data dir itself is
// (src/store). A key is saved, and fsync'd, before the cart request that names it leaves; the gateway deletes it by
// the retention rules of ADR-0016. The file is named by keyid, not by approval handle, because the handle exists only
// once the approval is created, after the cart request; the gateway's `approval_pending` entry names the keyid.
//
// A file holds {v: 1, keyid, created_at, private_key_pem}. `created_at` (the gateway's clock) lets the retention rule
// tell a key that was just made, whose cart has not reached the chain yet, from one a crash left behind.
import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { createCompleterKey, type Session, SigningError, sessionFromPem } from "./sign.ts";

export const COMPLETER_DIR = "completer";
const KEY_FILE = /^(gw-[A-Za-z0-9_-]{43})\.key$/;
const KEYID = /^gw-[A-Za-z0-9_-]{43}$/;
// O_NOFOLLOW makes open() fail on a symbolic link; Windows has no such flag.
const NOFOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const READ = constants.O_RDONLY | NOFOLLOW;
/** A fresh key whose keyid the caller refuses (see `create`) is replaced, at most this many times. */
const MAX_TRIES = 8;

/** A key on disk: its keyid and when the gateway made it (milliseconds since the epoch). */
export interface CompleterKey {
  readonly keyid: string;
  readonly createdAt: number;
}

export interface CompleterKeys {
  /** `<data>/completer`. */
  readonly dir: string;
  /**
   * Makes a fresh key and resolves once its file is on disk and fsync'd, so a request naming it can follow. `accept`
   * may refuse a keyid (the gateway refuses one its identity check would flag); a new key is then made instead.
   */
  create(accept?: (keyid: string) => boolean): Promise<Session>;
  /** The key's session, or null when no readable key file for it exists. */
  load(keyid: string): Promise<Session | null>;
  /** Deletes the key file; a missing one is not an error. */
  remove(keyid: string): Promise<void>;
  /** The keys on disk; an unreadable file is listed with createdAt NaN. */
  list(): Promise<CompleterKey[]>;
}

/** The completer folder is a symbolic link, not a directory, or owned by another user. */
export class CompleterKeyError extends Error {
  override name = "CompleterKeyError";
}

/** The completer keys under `dataDir`. Nothing is touched until the first call. */
export function openCompleterKeys(dataDir: string, options: { now?: () => number } = {}): CompleterKeys {
  const dir = join(dataDir, COMPLETER_DIR);
  const now = options.now ?? Date.now;
  const fileOf = (keyid: string): string => {
    if (!KEYID.test(keyid)) throw new CompleterKeyError(`not a completer keyid: ${JSON.stringify(keyid)}`);
    return join(dir, `${keyid}.key`);
  };

  async function ensureDir(): Promise<void> {
    await checkDir(dir, true);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await checkDir(dir, false);
    await fsp.chmod(dir, 0o700);
  }

  async function read(keyid: string): Promise<{ createdAt: number; pem: string } | null> {
    let text: string;
    try {
      const handle = await fsp.open(fileOf(keyid), READ);
      try {
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP" || code === "EMLINK") return null;
      throw error;
    }
    try {
      const body = JSON.parse(text) as { v?: unknown; keyid?: unknown; created_at?: unknown; private_key_pem?: unknown };
      if (body.v !== 1 || body.keyid !== keyid || typeof body.created_at !== "number" || typeof body.private_key_pem !== "string") return null;
      return { createdAt: body.created_at, pem: body.private_key_pem };
    } catch {
      return null;
    }
  }

  return {
    dir,
    async create(accept = () => true) {
      await ensureDir();
      for (let i = 0; i < MAX_TRIES; i++) {
        const { keyid, privateKeyPem } = createCompleterKey();
        if (!accept(keyid)) continue;
        const text = `${JSON.stringify({ v: 1, keyid, created_at: now(), private_key_pem: privateKeyPem })}\n`;
        const handle = await fsp.open(fileOf(keyid), CREATE, 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(text, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDir(dir);
        return sessionFromPem(privateKeyPem);
      }
      throw new SigningError(`no acceptable completer key in ${String(MAX_TRIES)} tries`);
    },
    async load(keyid) {
      if (!KEYID.test(keyid)) return null;
      await checkDir(dir, true);
      const found = await read(keyid);
      if (found === null) return null;
      try {
        const session = sessionFromPem(found.pem);
        return session.keyid === keyid ? session : null;
      } catch {
        return null;
      }
    },
    async remove(keyid) {
      try {
        await fsp.unlink(fileOf(keyid));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async list() {
      await checkDir(dir, true);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const keys: CompleterKey[] = [];
      for (const name of names.sort()) {
        const keyid = KEY_FILE.exec(name)?.[1];
        if (keyid === undefined) continue;
        keys.push({ keyid, createdAt: (await read(keyid))?.createdAt ?? Number.NaN });
      }
      return keys;
    },
  };
}

/** Refuses a folder that is a symbolic link, not a directory, or owned by another user (not checked on Windows). */
async function checkDir(dir: string, mayBeMissing: boolean): Promise<void> {
  let info: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    info = await fsp.lstat(dir);
  } catch (error) {
    if (mayBeMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new CompleterKeyError(`the completer key folder ${dir} is a symbolic link`);
  if (!info.isDirectory()) throw new CompleterKeyError(`the completer key folder ${dir} is not a directory`);
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new CompleterKeyError(`the completer key folder ${dir} is owned by uid ${String(info.uid)}, not the current user`);
  }
}

/** fsyncs a folder so a new file in it survives a crash; a platform that cannot open a folder skips it. */
async function syncDir(dir: string): Promise<void> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(dir, constants.O_RDONLY);
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Some file systems refuse fsync on a directory; the file itself was fsync'd.
  } finally {
    await handle.close();
  }
}
