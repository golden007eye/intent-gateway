// The wallet vault (plan G6 acceptance 1-4, 7): round trip, any changed byte or a wrong key refused as "tampered",
// 0600 files in a 0700 folder, links and loose modes refused, and no key or token in any message.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Secret, type WalletKeySource } from "../config/index.ts";
import {
  deleteSecret,
  hasSecret,
  loadSecret,
  loadWalletKey,
  saveSecret,
  vaultPath,
  WalletKey,
  walletKeyWarnings,
  WalletVaultError,
} from "./index.ts";

const TOKEN = "shop-refresh-token-0123456789abcdefghij";
const posix = process.platform !== "win32";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "wallet-"));
}

function newKey(source = "test"): WalletKey {
  return new WalletKey(randomBytes(32), source);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function refused(promise: Promise<unknown>): Promise<WalletVaultError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WalletVaultError);
  return error as WalletVaultError;
}

describe("vault round trip", () => {
  it("saves and loads a token; the file holds neither the token nor the key", async () => {
    const data = join(temp(), "data");
    const key = newKey();
    expect(await hasSecret(data, "shop")).toBe(false);
    expect(await loadSecret(data, "shop", key)).toBeNull();
    await saveSecret(data, "shop", key, TOKEN);
    expect(await hasSecret(data, "shop")).toBe(true);
    expect(await loadSecret(data, "shop", key)).toBe(TOKEN);
    const bytes = readFileSync(vaultPath(data, "shop"));
    expect(bytes.includes(Buffer.from(TOKEN))).toBe(false);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("IGWV\x01");
  });

  it("replaces an earlier token in one step and leaves no temporary file", async () => {
    const data = join(temp(), "data");
    const key = newKey();
    await saveSecret(data, "shop", key, TOKEN);
    await saveSecret(data, "shop", key, "second-token");
    expect(await loadSecret(data, "shop", key)).toBe("second-token");
    expect(readdirSync(join(data, "wallet"))).toEqual(["shop.enc"]);
  });

  it("uses a fresh IV on every save", async () => {
    const data = join(temp(), "data");
    const key = newKey();
    await saveSecret(data, "shop", key, TOKEN);
    const first = readFileSync(vaultPath(data, "shop"));
    await saveSecret(data, "shop", key, TOKEN);
    expect(readFileSync(vaultPath(data, "shop")).equals(first)).toBe(false);
  });

  it.runIf(posix)("writes the vault file 0600 in a 0700 folder", async () => {
    const data = join(temp(), "data");
    await saveSecret(data, "shop", newKey(), TOKEN);
    expect(mode(vaultPath(data, "shop"))).toBe(0o600);
    expect(mode(join(data, "wallet"))).toBe(0o700);
  });
});

describe("tamper and wrong key", () => {
  it("refuses a one-byte flip at every position of the file as tampered", async () => {
    const data = join(temp(), "data");
    const key = newKey();
    await saveSecret(data, "shop", key, TOKEN);
    const file = vaultPath(data, "shop");
    const good = readFileSync(file);
    for (let i = 0; i < good.length; i++) {
      const bad = Buffer.from(good);
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      writeFileSync(file, bad, { mode: 0o600 });
      const error = await refused(loadSecret(data, "shop", key));
      expect(error.reason, `byte ${String(i)}`).toBe("tampered");
    }
    writeFileSync(file, good, { mode: 0o600 });
    expect(await loadSecret(data, "shop", key)).toBe(TOKEN);
  });

  it("refuses a truncated file, an empty file and appended bytes as tampered", async () => {
    const data = join(temp(), "data");
    const key = newKey();
    await saveSecret(data, "shop", key, TOKEN);
    const file = vaultPath(data, "shop");
    const good = readFileSync(file);
    for (const bad of [good.subarray(0, good.length - 1), good.subarray(0, 20), Buffer.alloc(0), Buffer.concat([good, Buffer.from([0])])]) {
      writeFileSync(file, bad, { mode: 0o600 });
      expect((await refused(loadSecret(data, "shop", key))).reason).toBe("tampered");
    }
  });

  it("refuses a wrong key with the same error, naming neither key nor token", async () => {
    const data = join(temp(), "data");
    const right = randomBytes(32);
    const wrong = randomBytes(32);
    await saveSecret(data, "shop", new WalletKey(right, "right"), TOKEN);
    const error = await refused(loadSecret(data, "shop", new WalletKey(wrong, "wrong")));
    expect(error.reason).toBe("tampered");
    const said = `${error.message} ${String(error.stack)} ${inspect(error)}`;
    for (const secret of [TOKEN, right.toString("base64"), wrong.toString("base64"), right.toString("hex"), wrong.toString("hex")]) {
      expect(said).not.toContain(secret);
    }
  });
});

describe("paths the vault refuses", () => {
  it.runIf(posix)("refuses a vault file that is a symbolic link", async () => {
    const data = join(temp(), "data");
    const key = newKey();
    await saveSecret(data, "shop", key, TOKEN);
    const elsewhere = join(temp(), "elsewhere.enc");
    writeFileSync(elsewhere, readFileSync(vaultPath(data, "shop")), { mode: 0o600 });
    await deleteSecret(data, "shop");
    symlinkSync(elsewhere, vaultPath(data, "shop"));
    expect((await refused(loadSecret(data, "shop", key))).reason).toBe("unsafe");
  });

  it.runIf(posix)("refuses a wallet folder or data dir that is a symbolic link", async () => {
    const root = temp();
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, "data"));
    expect((await refused(saveSecret(join(root, "data"), "shop", newKey(), TOKEN))).reason).toBe("unsafe");

    const data = join(root, "data2");
    mkdirSync(data, { mode: 0o700 });
    symlinkSync(real, join(data, "wallet"));
    expect((await refused(saveSecret(data, "shop", newKey(), TOKEN))).reason).toBe("unsafe");
    expect(readdirSync(real)).toEqual([]);
  });

  it.runIf(posix)("refuses a vault file others can read, with the chmod that fixes it", async () => {
    const data = join(temp(), "data");
    const key = newKey();
    await saveSecret(data, "shop", key, TOKEN);
    chmodSync(vaultPath(data, "shop"), 0o644);
    const error = await refused(loadSecret(data, "shop", key));
    expect(error.reason).toBe("unsafe");
    expect(error.message).toContain("chmod 600");
  });
});

describe("unlink", () => {
  it("deletes the vault file, and says when there was none", async () => {
    const data = join(temp(), "data");
    await saveSecret(data, "shop", newKey(), TOKEN);
    expect(await deleteSecret(data, "shop")).toBe(true);
    expect(existsSync(vaultPath(data, "shop"))).toBe(false);
    expect(await deleteSecret(data, "shop")).toBe(false);
    expect(await deleteSecret(join(temp(), "never"), "shop")).toBe(false);
  });
});

describe("wallet key sources", () => {
  const b64 = randomBytes(32).toString("base64");

  it("reads a key file as base64, base64url, hex or 32 raw bytes, and they open the same vault", async () => {
    const dir = temp();
    const raw = randomBytes(32);
    const forms = [raw.toString("base64") + "\n", raw.toString("base64url"), raw.toString("hex"), raw];
    const data = join(dir, "data");
    await saveSecret(data, "shop", new WalletKey(raw, "raw"), TOKEN);
    for (const [i, form] of forms.entries()) {
      const path = join(dir, `key${String(i)}`);
      writeFileSync(path, form);
      const key = await loadWalletKey({ kind: "file", path }, { create: false });
      expect(key).not.toBeNull();
      expect(await loadSecret(data, "shop", key as WalletKey)).toBe(TOKEN);
    }
  });

  it("refuses a key file that is not a key, without printing its contents", async () => {
    const path = join(temp(), "key");
    writeFileSync(path, "hunter2-not-a-key");
    const error = await refused(loadWalletKey({ kind: "file", path }, { create: false }));
    expect(error.reason).toBe("bad_key");
    expect(error.message).not.toContain("hunter2");
    expect((await refused(loadWalletKey({ kind: "file", path: join(temp(), "absent") }, { create: false }))).reason).toBe("no_key");
  });

  it("takes the env key, and warns that it is visible, naming INTENT_WALLET_KEY_FILE", async () => {
    const source: WalletKeySource = { kind: "env", value: new Secret(b64) };
    const key = await loadWalletKey(source, { create: false });
    expect(key?.source).toBe("INTENT_WALLET_KEY");
    const warnings = walletKeyWarnings({ key: source, envKeyIgnored: false, shopMcpUrl: null, shopAuthUrl: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("INTENT_WALLET_KEY_FILE");
    expect(warnings[0]).not.toContain(b64);
    expect(walletKeyWarnings({ key: { kind: "file", path: "/k" }, envKeyIgnored: true, shopMcpUrl: null, shopAuthUrl: null })[0]).toContain("unset INTENT_WALLET_KEY");
    expect(walletKeyWarnings({ key: { kind: "file", path: "/k" }, envKeyIgnored: false, shopMcpUrl: null, shopAuthUrl: null })).toEqual([]);
  });

  it("refuses with the reason when there is no safe source", async () => {
    const error = await refused(loadWalletKey({ kind: "none", reason: "set INTENT_WALLET_KEY_FILE" }, { create: true }));
    expect(error).toMatchObject({ reason: "no_key", message: "set INTENT_WALLET_KEY_FILE" });
  });

  it("generates the default key file 0600 only when asked, then reuses it", async () => {
    const path = join(temp(), "config", "intent-gateway", "wallet-key");
    expect(await loadWalletKey({ kind: "default", path }, { create: false })).toBeNull();
    expect(existsSync(path)).toBe(false);
    const first = await loadWalletKey({ kind: "default", path }, { create: true });
    if (posix) {
      expect(mode(path)).toBe(0o600);
      expect(mode(join(path, ".."))).toBe(0o700);
    }
    const data = join(temp(), "data");
    await saveSecret(data, "shop", first as WalletKey, TOKEN);
    const again = await loadWalletKey({ kind: "default", path }, { create: false });
    expect(await loadSecret(data, "shop", again as WalletKey)).toBe(TOKEN);
    expect(readdirSync(join(path, ".."))).toEqual(["wallet-key"]);
  });

  it("gives two parallel first runs the same default key", async () => {
    const path = join(temp(), "cfg", "wallet-key");
    const [a, b] = await Promise.all([loadWalletKey({ kind: "default", path }, { create: true }), loadWalletKey({ kind: "default", path }, { create: true })]);
    const data = join(temp(), "data");
    await saveSecret(data, "shop", a as WalletKey, TOKEN);
    expect(await loadSecret(data, "shop", b as WalletKey)).toBe(TOKEN);
  });

  it.runIf(posix)("refuses a default key file others can read, or a link", async () => {
    const dir = join(temp(), "cfg");
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, "wallet-key");
    writeFileSync(path, b64, { mode: 0o644 });
    chmodSync(path, 0o644);
    expect((await refused(loadWalletKey({ kind: "default", path }, { create: true }))).reason).toBe("unsafe");
    const linked = join(dir, "linked.key");
    symlinkSync(path, linked);
    expect((await refused(loadWalletKey({ kind: "default", path: linked }, { create: true }))).reason).toBe("unsafe");
  });

  it("prints keys and secrets as [redacted]", () => {
    const bytes = randomBytes(32);
    const key = new WalletKey(bytes, "test");
    const secret = new Secret(b64);
    for (const shown of [String(key), JSON.stringify({ key, secret }), inspect(key), inspect({ secret }), String(secret)]) {
      expect(shown).toContain("[redacted]");
      expect(shown).not.toContain(b64);
      expect(shown).not.toContain(bytes.toString("base64"));
    }
    expect(secret.reveal()).toBe(b64);
    expect(() => new WalletKey(randomBytes(16), "short")).toThrow(WalletVaultError);
  });
});
