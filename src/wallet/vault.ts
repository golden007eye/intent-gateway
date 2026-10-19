// The wallet vault: a wallet rail's token in one AES-256-GCM file, `<data>/wallet/<rail>.enc` (plan G6, D4).
//
// File: "IGWV" | version 0x01 | 12-byte random IV | 16-byte GCM tag | ciphertext, with the AAD
// "IGWV" 0x01 "intent-wallet-v1|<rail>": a file copied to another rail's name does not open, and a later format
// version cannot be relabelled as this one. Any changed byte, a wrong key or a
// short file is refused as WalletVaultError("tampered"): GCM cannot tell them apart, and neither should the caller.
// Written to a temporary 0600 file, fsync'd and renamed over the old one, so a crash leaves the old token or the new
// one, never half a file. The data dir and its `wallet` folder must be directories owned by this user and not
// symbolic links (as for the chain, src/store), so a planted link cannot redirect the write.
//
// The key comes from Config.wallet.key (INTENT_WALLET_KEY_FILE, INTENT_WALLET_KEY, or a generated 0600 file in the
// per-user config folder). Against malware running as the same user this is obfuscation, not protection: that
// is a known risk (plan AC-X3). Neither the key nor the token ever appears in an error message.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { type WalletConfig, type WalletKeySource, WALLET_KEY_TEXT } from "../config/index.ts";
import type { CheckoutIdStore, WalletRail } from "./port.ts";

export type WalletVaultFailure = "tampered" | "no_key" | "bad_key" | "unsafe";

/** The vault or its key cannot be used. `reason` is the kind; the message says what and the fix, never a secret. */
export class WalletVaultError extends Error {
  override name = "WalletVaultError";
  readonly reason: WalletVaultFailure;
  constructor(reason: WalletVaultFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Each WalletKey's bytes, readable only inside this module. */
const KEY_BYTES_OF = new WeakMap<WalletKey, Buffer>();

function bytesOf(key: WalletKey): Buffer {
  const bytes = KEY_BYTES_OF.get(key);
  if (bytes === undefined) throw new WalletVaultError("bad_key", "not a wallet key");
  return bytes;
}

/** A 32-byte vault key. Prints as `[redacted]`; only this module reads its bytes. */
export class WalletKey {
  /** Where it came from, for messages: a path, or the variable's name. Never the key. */
  readonly source: string;
  constructor(bytes: Buffer, source: string) {
    if (bytes.length !== KEY_BYTES) throw new WalletVaultError("bad_key", `the wallet key from ${source} is not 32 bytes`);
    KEY_BYTES_OF.set(this, Buffer.from(bytes));
    this.source = source;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [inspect.custom](): string {
    return "[redacted]";
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAGIC = Buffer.from("IGWV\x01", "latin1");
const HEADER = MAGIC.length + IV_BYTES + TAG_BYTES;
const NOFOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;
const DIRECTORY = (constants as Partial<typeof constants>).O_DIRECTORY ?? 0;
const READ = constants.O_RDONLY | NOFOLLOW;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;

/** The AAD: the file's magic and version bytes, then "intent-wallet-v1|<rail>", so neither the header nor the rail can be swapped. */
function aad(rail: WalletRail): Buffer {
  return Buffer.concat([MAGIC, Buffer.from(`intent-wallet-v1|${rail}`, "utf8")]);
}

/** `<data>/wallet/<rail>.enc`. */
export function vaultPath(dataDir: string, rail: WalletRail): string {
  return join(dataDir, "wallet", `${rail}.enc`);
}

/** The stderr warnings the wallet key's source calls for: an env key is visible to anyone who can read the process. */
export function walletKeyWarnings(wallet: WalletConfig): string[] {
  const exposed = "its value is visible in /proc/<pid>/environ and docker inspect";
  if (wallet.key.kind === "env") return [`the wallet key comes from INTENT_WALLET_KEY: ${exposed}; put it in a file and set INTENT_WALLET_KEY_FILE instead`];
  if (wallet.envKeyIgnored) return [`INTENT_WALLET_KEY is set but INTENT_WALLET_KEY_FILE wins; unset INTENT_WALLET_KEY, ${exposed}`];
  return [];
}

/** Where the key comes from, in words for a status line. */
export function describeKeySource(source: WalletKeySource): string {
  switch (source.kind) {
    case "file":
      return `INTENT_WALLET_KEY_FILE (${source.path})`;
    case "env":
      return "INTENT_WALLET_KEY";
    case "default":
      return source.path;
    case "none":
      return "none";
  }
}

/**
 * The vault key from its configured source. `create`: generate the default key file when it does not exist yet (only
 * linking a wallet does); otherwise a missing default file gives null. A named file or env value that is not a key,
 * or a default file that is a link, another user's or readable by others, is refused.
 */
export async function loadWalletKey(source: WalletKeySource, options: { create: boolean }): Promise<WalletKey | null> {
  switch (source.kind) {
    case "none":
      throw new WalletVaultError("no_key", source.reason);
    case "env":
      return new WalletKey(parseKey(Buffer.from(source.value.reveal(), "utf8"), "INTENT_WALLET_KEY"), "INTENT_WALLET_KEY");
    case "file": {
      // A Docker or Kubernetes secret is often a link to a root-owned, world-readable file: the developer chose it, so
      // only its contents are checked.
      let text: Buffer;
      try {
        text = await fs.readFile(source.path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "error";
        throw new WalletVaultError("no_key", `cannot read INTENT_WALLET_KEY_FILE ${source.path} (${code}); mount the secret there or fix the path`);
      }
      return new WalletKey(parseKey(text, `INTENT_WALLET_KEY_FILE ${source.path}`), source.path);
    }
    case "default":
      return defaultKey(source.path, options.create);
  }
}

/** 32 raw bytes, or their base64, base64url or hex text (trailing whitespace ignored). */
function parseKey(content: Buffer, where: string): Buffer {
  // Raw bytes only when they cannot be text: a 32-character passphrase is not 32 random bytes.
  if (content.length === KEY_BYTES && !content.every((b) => (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d)) return content;
  const text = content.toString("utf8").trim();
  if (WALLET_KEY_TEXT.test(text)) {
    const bytes = text.length === 64 ? Buffer.from(text, "hex") : Buffer.from(text, text.includes("-") || text.includes("_") ? "base64url" : "base64");
    if (bytes.length === KEY_BYTES) return bytes;
  }
  throw new WalletVaultError("bad_key", `${where} is not a wallet key: it must hold 32 random bytes as base64 (openssl rand -base64 32)`);
}

async function defaultKey(path: string, create: boolean): Promise<WalletKey | null> {
  const dir = dirname(path);
  const existing = await readOwnFile(path);
  if (existing !== null) return new WalletKey(parseKey(existing, path), path);
  if (!create) return null;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await checkOwnDir(dir);
  // Published with link(), which fails if another process created the file first; then that file is the key.
  const temp = join(dir, `.wallet-key.${randomBytes(8).toString("hex")}.tmp`);
  await writeNew(temp, Buffer.from(`${randomBytes(KEY_BYTES).toString("base64")}\n`, "utf8"));
  try {
    await fs.link(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
  await syncDir(dir);
  const content = await readOwnFile(path);
  if (content === null) throw new WalletVaultError("no_key", `the wallet key file ${path} vanished while it was created; run the command again`);
  return new WalletKey(parseKey(content, path), path);
}

/** Saves `secret` for `rail`, replacing any earlier one in one step. */
export async function saveSecret(dataDir: string, rail: WalletRail, key: WalletKey, secret: string): Promise<void> {
  await seal(dataDir, vaultPath(dataDir, rail), aad(rail), key, secret);
}

/** Encrypts `secret` under `key` and `additional` into `file` (below `dataDir`), replacing any earlier file in one step. */
async function seal(dataDir: string, file: string, additional: Buffer, key: WalletKey, secret: string): Promise<void> {
  const dir = dirname(file);
  await checkOwnDir(dataDir, true);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await checkOwnDir(dataDir);
  await checkOwnDir(dirname(dir));
  await checkOwnDir(dir);
  await fs.chmod(dir, 0o700);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", bytesOf(key), iv);
  cipher.setAAD(additional);
  const plain = Buffer.from(secret, "utf8");
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  const content = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), sealed]);

  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  await writeNew(temp, content);
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
  await syncDir(dir);
}

/** The secret saved for `rail`, or null when none is. Refuses a changed file or a wrong key as "tampered". */
export async function loadSecret(dataDir: string, rail: WalletRail, key: WalletKey): Promise<string | null> {
  return unseal(dataDir, vaultPath(dataDir, rail), aad(rail), key);
}

async function unseal(dataDir: string, file: string, additional: Buffer, key: WalletKey): Promise<string | null> {
  await checkOwnDir(dataDir, true);
  await checkOwnDir(dirname(file), true);
  const content = await readOwnFile(file);
  if (content === null) return null;
  const tampered = new WalletVaultError(
    "tampered",
    `the wallet vault ${file} does not open with the wallet key from ${key.source}: the file was changed or the key is not the one it was saved with; unlink and link the wallet again`,
  );
  if (content.length < HEADER || !content.subarray(0, MAGIC.length).equals(MAGIC)) throw tampered;
  const iv = content.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = content.subarray(MAGIC.length + IV_BYTES, HEADER);
  try {
    const decipher = createDecipheriv("aes-256-gcm", bytesOf(key), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additional);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(content.subarray(HEADER)), decipher.final()]);
    const secret = plain.toString("utf8");
    plain.fill(0);
    return secret;
  } catch {
    throw tampered;
  }
}

const CHECKOUT_REF = /^sha256:([0-9a-f]{64})$/;
/** How long a checkout id is kept at most: the completer read window (48 h) after a 15-minute snapshot, plus a day. */
export const CHECKOUT_ID_MAX_AGE_MS = 73 * 3_600_000;

/** `<data>/wallet/<rail>-checkouts`: one encrypted file per checkout id (ADR-0019). */
export function checkoutVaultDir(dataDir: string, rail: WalletRail): string {
  return join(dataDir, "wallet", `${rail}-checkouts`);
}

/**
 * The rail's raw checkout ids, each AES-256-GCM sealed under the wallet key in its own 0600 file named by the
 * checkout ref's hex (never the id), with the AAD naming the rail and the ref: a file copied under another ref's
 * name does not open (ADR-0019). Opening it deletes files older than CHECKOUT_ID_MAX_AGE_MS, by which time no
 * completer key can read the approval any more.
 */
export async function openCheckoutVault(dataDir: string, rail: WalletRail, key: WalletKey, now: () => number = Date.now): Promise<CheckoutIdStore> {
  const dir = checkoutVaultDir(dataDir, rail);
  const fileOf = (ref: string): string => {
    const hex = CHECKOUT_REF.exec(ref)?.[1];
    if (hex === undefined) throw new WalletVaultError("unsafe", "a checkout is named by its sha256 checkout ref");
    return join(dir, `${hex}.enc`);
  };
  const additional = (ref: string): Buffer => Buffer.concat([MAGIC, Buffer.from(`intent-wallet-v1|${rail}|checkout|${ref}`, "utf8")]);
  await checkOwnDir(dataDir, true);
  await checkOwnDir(dir, true);
  const names = await fs.readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.enc$/.test(name)) continue;
    const info = await fs.lstat(join(dir, name)).catch(missing);
    if (info !== null && info.isFile() && now() - info.mtimeMs > CHECKOUT_ID_MAX_AGE_MS) await fs.unlink(join(dir, name)).catch(() => undefined);
  }
  return {
    get: (ref) => unseal(dataDir, fileOf(ref), additional(ref), key),
    set: (ref, id) => seal(dataDir, fileOf(ref), additional(ref), key, id),
    async delete(ref) {
      try {
        await fs.unlink(fileOf(ref));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await syncDir(dir);
    },
  };
}

/** Whether a vault file exists for `rail` (it may still not open). */
export async function hasSecret(dataDir: string, rail: WalletRail): Promise<boolean> {
  return (await fs.lstat(vaultPath(dataDir, rail)).catch(missing)) !== null;
}

/**
 * Deletes `rail`'s vault file. True when a file was deleted, false when there was none. The bytes are unlinked, not
 * overwritten: on journaling and copy-on-write file systems and SSDs an overwrite does not reach the old blocks.
 */
export async function deleteSecret(dataDir: string, rail: WalletRail): Promise<boolean> {
  const file = vaultPath(dataDir, rail);
  await checkOwnDir(dataDir, true);
  await checkOwnDir(dirname(file), true);
  try {
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await syncDir(dirname(file));
  return true;
}

// The pending sign-in (`intent wallet link <rail> --start`, then `--finish`): a device grant the developer has not
// approved yet. Whoever holds its device code can redeem the tokens once the developer approves, so it is sealed
// exactly as the tokens are (same key, same 0600 temporary file, fsync and rename, same directory checks, read
// without following a link), as `<data>/wallet/<rail>-pending.enc` with the AAD "intent-wallet-v1|<rail>|pending".
//
// A `--finish` claims it first by renaming it to `<rail>-pending.<pid>.<hex>.claim`: rename() moves a file once, so
// two processes never both hold one grant. A claim whose process is gone (Ctrl-C, a killed shell) is taken over the
// same way by the next `--finish`; one whose process still runs is left to it. A claim naming this process's pid that
// this process did not make belongs to a gone one (in a container every run is pid 1).

/** `<data>/wallet/<rail>-pending.enc`. */
export function pendingGrantPath(dataDir: string, rail: WalletRail): string {
  return join(dataDir, "wallet", `${rail}-pending.enc`);
}

const pendingAad = (rail: WalletRail): Buffer => Buffer.concat([MAGIC, Buffer.from(`intent-wallet-v1|${rail}|pending`, "utf8")]);
const claimName = (rail: WalletRail): RegExp => new RegExp(`^${rail}-pending\\.([0-9]{1,10})\\.[0-9a-f]{16}\\.claim$`);

/** A pending grant this process claimed: its text, and the two ways to let go of it. */
export interface ClaimedGrant {
  readonly text: string;
  /** Puts it back as the pending grant (a newer one, from a later --start, wins), for a finish that ended early. */
  release(): Promise<void>;
  /** Deletes it: the sign-in ended (tokens, a refusal, an expiry). */
  discard(): Promise<void>;
}

export type GrantClaim = { readonly kind: "claimed"; readonly grant: ClaimedGrant } | { readonly kind: "none" } | { readonly kind: "busy"; readonly pid: number };

/**
 * Seals `text` as `rail`'s pending grant, replacing any earlier one in one step, and deletes the claims of processes
 * that are gone. `replaced` is true when an earlier pending grant or such a claim was there.
 */
export async function savePendingGrant(dataDir: string, rail: WalletRail, key: WalletKey, text: string): Promise<{ replaced: boolean }> {
  const file = pendingGrantPath(dataDir, rail);
  await checkOwnDir(dataDir, true);
  await checkOwnDir(dirname(file), true);
  let replaced = (await fs.lstat(file).catch(missing)) !== null;
  await seal(dataDir, file, pendingAad(rail), key, text);
  let swept = false;
  for (const { path, pid } of await claims(dataDir, rail)) {
    if (!alive(path, pid) && (await unlinkIfThere(path))) swept = true;
  }
  if (swept) await syncDir(dirname(file));
  replaced ||= swept;
  return { replaced };
}

/**
 * Claims `rail`'s pending grant for this process: the pending file, else a claim whose process is gone. "busy" names
 * the process that holds the only claim left; "none" means there is nothing to finish. A claimed file that does not
 * open is deleted, and the WalletVaultError thrown.
 */
export async function claimPendingGrant(dataDir: string, rail: WalletRail, key: WalletKey): Promise<GrantClaim> {
  const file = pendingGrantPath(dataDir, rail);
  const dir = dirname(file);
  await checkOwnDir(dataDir, true);
  await checkOwnDir(dir, true);
  const mine = join(dir, `${rail}-pending.${String(process.pid)}.${randomBytes(8).toString("hex")}.claim`);
  // The pending file first; the claims are listed only after that rename failed, so a claim made meanwhile is seen.
  const held: { pid: number | null } = { pid: null };
  const candidates = async function* (): AsyncGenerator<string> {
    yield file;
    for (const { path, pid } of await claims(dataDir, rail)) {
      if (alive(path, pid)) held.pid ??= pid;
      else yield path;
    }
  };
  for await (const candidate of candidates()) {
    try {
      await fs.rename(candidate, mine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await syncDir(dir);
    let text: string | null;
    try {
      text = await unseal(dataDir, mine, pendingAad(rail), key);
    } catch (error) {
      await unlinkIfThere(mine);
      throw error;
    }
    if (text === null) continue;
    OWN_CLAIMS.add(mine);
    return { kind: "claimed", grant: claimed(text, mine, file) };
  }
  return held.pid === null ? { kind: "none" } : { kind: "busy", pid: held.pid };
}

function claimed(text: string, mine: string, file: string): ClaimedGrant {
  const dir = dirname(file);
  return {
    text,
    async release() {
      try {
        // link() fails when a later --start has saved a newer grant: that one wins.
        await fs.link(mine, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await unlinkIfThere(mine);
      OWN_CLAIMS.delete(mine);
      await syncDir(dir);
    },
    async discard() {
      await unlinkIfThere(mine);
      OWN_CLAIMS.delete(mine);
      await syncDir(dir);
    },
  };
}

/** The claim files of `rail`, with the pid each names. */
async function claims(dataDir: string, rail: WalletRail): Promise<{ path: string; pid: number }[]> {
  const dir = dirname(pendingGrantPath(dataDir, rail));
  await checkOwnDir(dataDir, true);
  await checkOwnDir(dir, true);
  const names = await fs.readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const pattern = claimName(rail);
  return names.flatMap((name) => {
    const pid = pattern.exec(name)?.[1];
    return pid === undefined ? [] : [{ path: join(dir, name), pid: Number(pid) }];
  });
}

/** The claim files this process holds now. */
const OWN_CLAIMS = new Set<string>();

/** Whether the claim at `path` is held by a running process (another user's counts as running). */
function alive(path: string, pid: number): boolean {
  // This pid with a claim this process did not make: a gone process had it (in a container every run is pid 1).
  if (pid === process.pid) return OWN_CLAIMS.has(path);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function unlinkIfThere(path: string): Promise<boolean> {
  try {
    await fs.unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function missing(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

function currentUid(): number | undefined {
  return process.platform === "win32" ? undefined : process.getuid?.();
}

/** Refuses a directory that is a symbolic link, not a directory, or another user's (not checked on Windows). */
async function checkOwnDir(dir: string, mayBeMissing = false): Promise<void> {
  const info = mayBeMissing ? await fs.lstat(dir).catch(missing) : await fs.lstat(dir);
  if (info === null) return;
  if (info.isSymbolicLink()) throw new WalletVaultError("unsafe", `${dir} is a symbolic link; the wallet vault is never written through one`);
  if (!info.isDirectory()) throw new WalletVaultError("unsafe", `${dir} is not a directory`);
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) throw new WalletVaultError("unsafe", `${dir} is owned by uid ${String(info.uid)}, not the current user`);
}

/**
 * A file this user owns, opened without following a link: null when absent. Refused when it is not a regular file,
 * is another user's, or group or others may read it (fix: chmod 600).
 */
async function readOwnFile(path: string): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, READ);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new WalletVaultError("unsafe", `${path} is a symbolic link`);
    throw error;
  }
  try {
    const info: Stats = await handle.stat();
    if (!info.isFile()) throw new WalletVaultError("unsafe", `${path} is not a regular file`);
    const uid = currentUid();
    if (uid !== undefined) {
      if (info.uid !== uid) throw new WalletVaultError("unsafe", `${path} is owned by uid ${String(info.uid)}, not the current user`);
      if ((info.mode & 0o077) !== 0) {
        throw new WalletVaultError("unsafe", `${path} can be read by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 ${path}`);
      }
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Creates `path` (it must not exist) with mode 0600, writes `content` and fsyncs it. */
async function writeNew(path: string, content: Buffer): Promise<void> {
  const handle = await fs.open(path, CREATE, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

/** fsyncs a directory so a rename or unlink in it survives a crash. Windows cannot open a directory for that. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
