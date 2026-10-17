// `intent wallet status | unlink shop` (plan G6 acceptance 5-7): the env-key warning names INTENT_WALLET_KEY_FILE,
// unlink deletes the vault file and chains `wallet {rail, action: "unlinked", revoked: false}`, and the token is in
// neither the chain, nor stdout, nor stderr.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readChain } from "../store/index.ts";
import { saveSecret, vaultPath, WalletKey } from "../wallet/index.ts";
import { type Io, main } from "./index.ts";

const TOKEN = "shop-refresh-token-do-not-print-0123456789";

interface Setup {
  dir: string;
  keyBytes: Buffer;
  keyText: string;
  run(argv: string[], env?: Record<string, string>): Promise<{ code: number; out: string; err: string }>;
}

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "wallet-cli-"));
  const dir = join(root, "data");
  const keyBytes = randomBytes(32);
  const keyText = keyBytes.toString("base64");
  const keyFile = join(root, "wallet.key");
  writeFileSync(keyFile, `${keyText}\n`, { mode: 0o600 });
  return {
    dir,
    keyBytes,
    keyText,
    async run(argv, env = { INTENT_WALLET_KEY_FILE: keyFile }) {
      const out: string[] = [];
      const err: string[] = [];
      const io: Io = {
        env: { INTENT_DATA_DIR: dir, ...env },
        stdin: new PassThrough(),
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        isTTY: { stdin: false, stdout: false },
      };
      const { code } = await main(argv, io);
      return { code, out: out.join(""), err: err.join("") };
    },
  };
}

describe("intent wallet status", () => {
  it("says not linked when there is no vault", async () => {
    const s = setup();
    const r = await s.run(["wallet", "status"]);
    expect(r).toMatchObject({ code: 0, out: "Shop wallet: not linked\n", err: "" });
  });

  it("says linked when the vault opens, and prints neither the token nor the key", async () => {
    const s = setup();
    await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), TOKEN);
    const r = await s.run(["wallet", "status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Shop wallet: linked (encrypted vault");
    expect(r.out).toContain("INTENT_WALLET_KEY_FILE");
    for (const secret of [TOKEN, s.keyText]) expect(r.out + r.err).not.toContain(secret);
  });

  it("warns on stderr, naming INTENT_WALLET_KEY_FILE, when the key comes from INTENT_WALLET_KEY", async () => {
    const s = setup();
    await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), TOKEN);
    const r = await s.run(["wallet", "status"], { INTENT_WALLET_KEY: s.keyText });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/^intent: warning: the wallet key comes from INTENT_WALLET_KEY: .*set INTENT_WALLET_KEY_FILE instead\n$/);
    for (const secret of [TOKEN, s.keyText]) expect(r.out + r.err).not.toContain(secret);
  });

  it("exits 1 with the fix when the vault was changed or the key is wrong", async () => {
    const s = setup();
    await saveSecret(s.dir, "shop", new WalletKey(randomBytes(32), "other"), TOKEN);
    const r = await s.run(["wallet", "status"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Shop wallet: vault unreadable:");
    expect(r.out).toContain("wallet unlink shop");
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it("refuses an INTENT_WALLET_KEY that is not a key, without echoing it", async () => {
    const s = setup();
    const r = await s.run(["wallet", "status"], { INTENT_WALLET_KEY: "hunter2-not-a-key" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("INTENT_WALLET_KEY must be 32 random bytes");
    expect(r.err).not.toContain("hunter2");
  });
});

describe("intent wallet unlink shop", () => {
  it("deletes the vault file and chains the unlink, with the token nowhere in the chain or the output", async () => {
    const s = setup();
    await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), TOKEN);
    const r = await s.run(["wallet", "unlink", "shop"]);
    expect(r.code).toBe(0);
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
    expect(r.out).toContain("Shop wallet unlinked: deleted");
    expect(r.err).toContain("revoke the gateway's access in your Shop account settings");

    const chain = readChain(s.dir) as { kind: string; body: unknown }[];
    expect(chain.map((e) => [e.kind, e.body])).toEqual([["wallet", { rail: "shop", action: "unlinked", revoked: false }]]);
    const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
    for (const secret of [TOKEN, s.keyText]) {
      expect(audit).not.toContain(secret);
      expect(r.out + r.err).not.toContain(secret);
    }

    const status = await s.run(["wallet", "status"]);
    expect(status.out).toBe("Shop wallet: not linked\n");
    const log = await s.run(["log", "-v"]);
    expect(log.code).toBe(0);
    expect(log.out).toContain("shop wallet unlinked, token not revoked");
    expect(log.out + log.err).not.toContain(TOKEN);
    const verify = await s.run(["verify", "--skip-install-check"]);
    expect(verify.code, verify.out + verify.err).toBe(0);
  });

  it("chains nothing when no wallet was linked", async () => {
    const s = setup();
    const r = await s.run(["wallet", "unlink", "shop"]);
    expect(r).toMatchObject({ code: 0, out: "Shop wallet: not linked; nothing to unlink\n" });
    expect(existsSync(join(s.dir, "audit.jsonl"))).toBe(false);
  });

  it("refuses an unknown wallet and a missing one with exit 2", async () => {
    const s = setup();
    expect((await s.run(["wallet", "unlink", "paypal"])).code).toBe(2);
    expect((await s.run(["wallet", "unlink"])).code).toBe(2);
    const bare = await s.run(["wallet"]);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("wallet needs one of: status, unlink");
  });
});
