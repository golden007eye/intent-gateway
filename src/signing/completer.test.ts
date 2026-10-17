// Completer keys on disk (contract 1.6.0, ADR-0016): one 0600 file per key in a 0700 folder that must be a real
// directory of the current user; a loaded key signs as the keyid it was saved under, and nothing else loads.
import { generateKeyPairSync } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPLETER_DIR,
  CompleterKeyError,
  createCompleterKey,
  createNonceCache,
  openCompleterKeys,
  sessionFromPem,
  SigningError,
  signRequest,
  verifyRequest,
} from "./index.ts";

const posix = process.platform !== "win32";

async function dataDir(): Promise<string> {
  return join(await fsp.mkdtemp(join(tmpdir(), "completer-")), "data");
}

describe("createCompleterKey and sessionFromPem", () => {
  it("make a fresh gw- key per call whose PEM signs as that keyid", () => {
    const a = createCompleterKey();
    const b = createCompleterKey();
    expect(a.keyid).toMatch(/^gw-[A-Za-z0-9_-]{43}$/);
    expect(a.keyid).not.toBe(b.keyid);
    const session = sessionFromPem(a.privateKeyPem);
    expect(session.keyid).toBe(a.keyid);
    const body = Buffer.from("{}");
    const headers = signRequest(session, { method: "GET", path: "/v1/approvals/ap_TEST0001", body, created: 1790251200 });
    expect(verifyRequest(headers, { method: "GET", path: "/v1/approvals/ap_TEST0001", body }, { now: 1790251200, seenNonce: createNonceCache() })).toMatchObject({
      ok: true,
      keyid: a.keyid,
    });
  });

  it("refuse anything but an Ed25519 private key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => sessionFromPem(rsa)).toThrow(SigningError);
    expect(() => sessionFromPem("not a key")).toThrow(SigningError);
  });
});

describe("openCompleterKeys", () => {
  it("saves each key 0600 in a 0700 <data>/completer, loads it back and lists it with its creation time", async () => {
    const dir = await dataDir();
    const keys = openCompleterKeys(dir, { now: () => 1_000 });
    expect(await keys.list()).toEqual([]);
    const session = await keys.create();
    expect(keys.dir).toBe(join(dir, COMPLETER_DIR));
    const file = join(keys.dir, `${session.keyid}.key`);
    if (posix) {
      expect((await fsp.stat(keys.dir)).mode & 0o777).toBe(0o700);
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await keys.load(session.keyid))?.keyid).toBe(session.keyid);
    expect(await keys.list()).toEqual([{ keyid: session.keyid, createdAt: 1_000 }]);
    await keys.remove(session.keyid);
    await keys.remove(session.keyid);
    expect(await keys.load(session.keyid)).toBeNull();
    expect(await keys.list()).toEqual([]);
  });

  it("replaces a key whose keyid the caller refuses", async () => {
    const keys = openCompleterKeys(await dataDir());
    let refused = 0;
    const session = await keys.create(() => refused++ > 0);
    expect(refused).toBe(2);
    expect((await keys.list()).map((k) => k.keyid)).toEqual([session.keyid]);
    await expect(keys.create(() => false)).rejects.toThrow(SigningError);
  });

  // Attack cases: a key file is never read through a link, under another name or from a folder that is not ours.
  it.runIf(posix)("refuses a completer folder that is a symbolic link", async () => {
    const dir = await dataDir();
    await fsp.mkdir(dir, { recursive: true });
    const elsewhere = await fsp.mkdtemp(join(tmpdir(), "elsewhere-"));
    await fsp.symlink(elsewhere, join(dir, COMPLETER_DIR));
    const keys = openCompleterKeys(dir);
    await expect(keys.create()).rejects.toThrow(CompleterKeyError);
    await expect(keys.list()).rejects.toThrow(CompleterKeyError);
  });

  it.runIf(posix)("does not load a key file that is a symbolic link, names another keyid or is not a key", async () => {
    const dir = await dataDir();
    const keys = openCompleterKeys(dir);
    const real = await keys.create();
    const other = createCompleterKey();
    await fsp.symlink(join(keys.dir, `${real.keyid}.key`), join(keys.dir, `${other.keyid}.key`));
    expect(await keys.load(other.keyid)).toBeNull();
    const third = createCompleterKey();
    await fsp.writeFile(join(keys.dir, `${third.keyid}.key`), JSON.stringify({ v: 1, keyid: real.keyid, created_at: 0, private_key_pem: other.privateKeyPem }));
    expect(await keys.load(third.keyid)).toBeNull();
    const fourth = createCompleterKey();
    await fsp.writeFile(join(keys.dir, `${fourth.keyid}.key`), "garbage");
    expect(await keys.load(fourth.keyid)).toBeNull();
    expect(await keys.load("../../etc/passwd")).toBeNull();
    await expect(keys.remove("../x")).rejects.toThrow(CompleterKeyError);
  });

  it("a new file never replaces an existing one", async () => {
    const keys = openCompleterKeys(await dataDir());
    const a = await keys.create();
    const b = await keys.create();
    expect(a.keyid).not.toBe(b.keyid);
    expect((await keys.list()).length).toBe(2);
  });
});
