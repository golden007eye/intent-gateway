// `intent wallet status | unlink shop` (plan G6 acceptance 5-7): the env-key warning names INTENT_WALLET_KEY_FILE,
// unlink deletes the vault file and chains `wallet {rail, action: "unlinked", revoked: false}`, and the token is in
// neither the chain, nor stdout, nor stderr.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readChain } from "../store/index.ts";
import { saveSecret, vaultPath, WalletKey } from "../wallet/index.ts";
import { type FakeShop, startFakeShop } from "../wallet-shop-fake/index.ts";
import { type FakeCloud, LIVE_CURRENCIES, startFakeCloud } from "../cloud-fake/index.ts";
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
  it("says not linked when there is no vault, with or without INTENT_SHOP_CLIENT_ID (the gateway has its own client)", async () => {
    const s = setup();
    const r = await s.run(["wallet", "status"]);
    expect(r).toMatchObject({ code: 0, out: "Shop wallet: not linked; link it with intent wallet link shop --start\n", err: "" });
    const withClient = await s.run(["wallet", "status"], { INTENT_SHOP_CLIENT_ID: "my-gateway-client" });
    expect(withClient).toMatchObject({ code: 0, out: "Shop wallet: not linked; link it with intent wallet link shop --start\n", err: "" });
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
    expect(r.err).toMatch(/^intent: warning: the wallet key comes from INTENT_WALLET_KEY: .*set INTENT_WALLET_KEY_FILE instead\n/);
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

  describe("with a Shop client set: one get_account through the log (S1 shapes)", () => {
    let shop: FakeShop | undefined;
    // Intent Cloud's meta, read for the ceilings when Shop shows a budget.
    let cloud: FakeCloud | undefined;
    afterEach(async () => {
      await shop?.close();
      await cloud?.close();
    });
    const statusOf = async (faults: Parameters<typeof startFakeShop>[0]) => {
      shop = await startFakeShop(faults);
      cloud = await startFakeCloud({ currencies: LIVE_CURRENCIES });
      const s = setup();
      const vault = JSON.stringify({ v: 1, client_id: shop.clientId, access_token: shop.accessToken, refresh_token: shop.refreshToken });
      await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), vault);
      const trustKeys = join(s.dir, "..", "keys.json");
      writeFileSync(trustKeys, JSON.stringify({ rootKeys: [cloud.keys.rootPin] }));
      const r = await s.run(["wallet", "status", "--trust-keys", trustKeys], {
        INTENT_WALLET_KEY_FILE: join(s.dir, "..", "wallet.key"),
        INTENT_SHOP_CLIENT_ID: shop.clientId,
        INTENT_SHOP_AUTH_URL: shop.authUrl,
        INTENT_SHOP_MCP_URL: shop.mcpUrl,
        INTENT_CLOUD_URL: cloud.url,
      });
      return { r, s };
    };

    it("prints the budget left, logged before it was sent; no identity printed", async () => {
      const { r, s } = await statusOf({});
      expect(r.code).toBe(0);
      expect(r.out).toContain("Shop agent payments left for the gateway: 50.00 USD");
      expect((readChain(s.dir) as { kind: string; body: Record<string, unknown> }[]).map((e) => [e.kind, e.body.endpoint])).toEqual([
        ["session", undefined],
        ["disclosure", "get_account"],
        ["response", undefined],
        // The ceilings: Intent Cloud's meta, then its key statement, so `intent verify` can check the meta's receipt (a session of its own).
        ["session", undefined],
        ["disclosure", "getMeta"],
        ["receipt", undefined],
        ["disclosure", "getKeyStatement"],
        ["receipt", undefined],
        ["keys", undefined],
      ]);
      expect(r.out + r.err).not.toMatch(/jane|Springfield|4242/i);
    });

    it("no budget for the connection: one-tap unavailable, with what to turn on in the Shop app", async () => {
      const { r } = await statusOf({ faults: { budgetMinor: null } });
      expect(r.out).toContain('Shop shows none for this connection, so one-tap is unavailable; turn on "Allow agent to pay" with a budget in the Shop app');
    });

    it("the connection removed in the Shop app (S1 step 12b): not linked at Shop, one-tap unavailable, how to link again", async () => {
      const { r } = await statusOf({ faults: { connectionRemoved: true } });
      expect(r.code).toBe(0);
      expect(r.out).toContain("Shop connection: not linked at Shop: Shop answered that this connection can no longer read the account");
      expect(r.out).toContain("Shop one-tap: unavailable; run intent wallet unlink shop, then intent wallet link shop");
    });
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
    expect(r.err).toContain("the Shop tokens were not both revoked by this gateway");
    expect(r.out).toContain("To finish, remove the connection in the Shop app: Account › Connections");

    const chain = readChain(s.dir) as { kind: string; body: unknown }[];
    expect(chain.map((e) => [e.kind, e.body])).toEqual([["wallet", { rail: "shop", action: "unlinked", revoked: false }]]);
    const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
    for (const secret of [TOKEN, s.keyText]) {
      expect(audit).not.toContain(secret);
      expect(r.out + r.err).not.toContain(secret);
    }

    const status = await s.run(["wallet", "status"]);
    expect(status.out).toBe("Shop wallet: not linked; link it with intent wallet link shop --start\n");
    const log = await s.run(["log", "-v"]);
    expect(log.code).toBe(0);
    expect(log.out).toContain("Shop wallet unlinked, token not revoked (deleted here only)");
    expect(log.out + log.err).not.toContain(TOKEN);
    const verify = await s.run(["verify", "--skip-install-check"]);
    expect(verify.code, verify.out + verify.err).toBe(0);
  });

  it.runIf(process.platform !== "win32")("keeps the vault file when the chain cannot be opened: the store opens before the delete", async () => {
    const s = setup();
    await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), TOKEN);
    const elsewhere = join(mkdtempSync(join(tmpdir(), "wallet-cli-")), "audit.jsonl");
    writeFileSync(elsewhere, "");
    symlinkSync(elsewhere, join(s.dir, "audit.jsonl"));
    const r = await s.run(["wallet", "unlink", "shop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("symbolic link");
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(true);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  describe("revokes at Shop first (plan G7a test 4), logged before it is sent", () => {
    let shop: FakeShop;
    afterEach(async () => {
      await shop.close();
    });
    const vaultText = (s: FakeShop) => JSON.stringify({ v: 1, client_id: s.clientId, access_token: s.accessToken, refresh_token: s.refreshToken });
    const linked = async (s: Setup, fake: FakeShop) => {
      await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), vaultText(fake));
    };
    const env = (s: Setup, fake: FakeShop): Record<string, string> => ({
      INTENT_WALLET_KEY_FILE: join(s.dir, "..", "wallet.key"),
      INTENT_SHOP_AUTH_URL: fake.authUrl,
      INTENT_SHOP_MCP_URL: fake.mcpUrl,
    });

    it("revoked: Shop acknowledged (HTTP 200), then the file is deleted and the chain says revoked:true; no token in the chain", async () => {
      shop = await startFakeShop();
      const s = setup();
      await linked(s, shop);
      const r = await s.run(["wallet", "unlink", "shop"], env(s, shop));
      expect(r.code, r.err).toBe(0);
      // Both tokens (S1 step 12: the access token outlives its refresh token's revocation).
      const form = "application/x-www-form-urlencoded";
      expect(shop.revocations).toEqual([
        { token: shop.refreshToken, tokenTypeHint: "refresh_token", clientId: shop.clientId, contentType: form },
        { token: shop.accessToken, tokenTypeHint: "access_token", clientId: shop.clientId, contentType: form },
      ]);
      expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
      expect(r.out).toContain("Shop acknowledged the revocation of the gateway's refresh and access tokens (HTTP 200)");
      // Revocation does not remove the connection in the Shop app: the developer is told to.
      expect(r.out).toContain("To finish, remove the connection in the Shop app: Account › Connections");
      expect(r.err).toBe("");

      const chain = readChain(s.dir) as { kind: string; body: Record<string, unknown> }[];
      expect(chain.map((e) => e.kind)).toEqual(["session", "disclosure", "response", "disclosure", "response", "wallet"]);
      expect(chain[1]?.body).toMatchObject({ endpoint: "revoke", destination: "shop_accounts", fields: ["client_id", "token", "token_type_hint"] });
      expect(chain[3]?.body).toMatchObject({ endpoint: "revoke", destination: "shop_accounts" });
      expect(chain[5]?.body).toEqual({ rail: "shop", action: "unlinked", revoked: true });
      const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
      for (const secret of [shop.refreshToken, shop.accessToken, s.keyText]) {
        expect(audit).not.toContain(secret);
        expect(audit).not.toContain(Buffer.from(secret).toString("base64").slice(0, 16));
        expect(r.out + r.err).not.toContain(secret);
      }
      const verify = await s.run(["verify", "--skip-install-check"]);
      expect(verify.code, verify.out + verify.err).toBe(0);
      expect(verify.out).toContain("credential values sent, repeats counted (the log keeps only their sha256)");
    });

    it("revoke answers 500: the file is still deleted, stderr names the Shop setting, and the chain says revoked:false", async () => {
      shop = await startFakeShop({ faults: { revokeStatus: 500 } });
      const s = setup();
      await linked(s, shop);
      const r = await s.run(["wallet", "unlink", "shop"], env(s, shop));
      expect(r.code).toBe(0);
      expect(shop.revocations).toHaveLength(2);
      expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
      expect(r.err).toContain("Shop answered the revocation with an error");
      expect(r.out).toContain("Account › Connections");
      const chain = readChain(s.dir) as { kind: string; body: unknown }[];
      expect(chain.at(-1)?.body).toEqual({ rail: "shop", action: "unlinked", revoked: false });
      expect(chain.map((e) => e.kind)).toEqual(["session", "disclosure", "response", "disclosure", "response", "wallet"]);
      expect(readFileSync(join(s.dir, "audit.jsonl"), "utf8")).not.toContain(shop.refreshToken);
    });

    it("Shop unreachable: logged as not sent, the file is deleted, revoked:false", async () => {
      shop = await startFakeShop();
      const s = setup();
      await linked(s, shop);
      const authUrl = shop.authUrl;
      await shop.close();
      const r = await s.run(["wallet", "unlink", "shop"], { ...env(s, shop), INTENT_SHOP_AUTH_URL: authUrl });
      expect(r.code).toBe(0);
      expect(r.err).toContain("could not revoke the Shop token");
      expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
      const chain = readChain(s.dir) as { kind: string; body: Record<string, unknown> }[];
      expect(chain.map((e) => e.kind)).toEqual(["session", "disclosure", "unacknowledged", "disclosure", "unacknowledged", "wallet"]);
      expect(String(chain[2]?.body.reason)).toMatch(/^CloudNetworkError: not sent \(no connection/);
      expect(chain.at(-1)?.body).toEqual({ rail: "shop", action: "unlinked", revoked: false });
    });
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
    expect(bare.err).toContain("wallet needs one of: status, link, unlink");
  });
});
