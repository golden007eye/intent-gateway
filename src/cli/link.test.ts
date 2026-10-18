// `intent wallet link shop` and `intent init` (plan G8, AC-G11), against the fake Shop. With no Shop client set,
// nothing is sent. A link puts the tokens in the vault and chains `wallet {rail, action: "linked", revoked: false}`.
// Attack: the device code and the tokens are in none of stdout, stderr and audit.jsonl; the user code and the page
// to approve on are on stdout only. init's Shop step never blocks setup: no terminal, --yes, "no" and no client each
// skip it with a line saying so.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readChain } from "../store/index.ts";
import { loadSecret, vaultPath, WalletKey } from "../wallet/index.ts";
import { FAKE_BUYER, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { hostConnect } from "./connect.ts";
import { type Io, main } from "./index.ts";

interface Result {
  code: number;
  out: string;
  err: string;
}

interface Setup {
  dir: string;
  keyBytes: Buffer;
  shop: FakeShop;
  env: Record<string, string>;
  run(argv: string[], options?: { env?: Record<string, string>; tty?: boolean; input?: string }): Promise<Result>;
}

let shop: FakeShop | undefined;
afterEach(async () => {
  await shop?.close();
  shop = undefined;
});

async function setup(faults: FakeShopFaults = {}): Promise<Setup> {
  const fake = await startFakeShop({ faults });
  shop = fake;
  const root = mkdtempSync(join(tmpdir(), "wallet-link-"));
  const dir = join(root, "data");
  const keyBytes = randomBytes(32);
  const keyFile = join(root, "wallet.key");
  writeFileSync(keyFile, `${keyBytes.toString("base64")}\n`, { mode: 0o600 });
  const env = {
    INTENT_DATA_DIR: dir,
    INTENT_WALLET_KEY_FILE: keyFile,
    INTENT_SHOP_CLIENT_ID: fake.clientId,
    INTENT_SHOP_AUTH_URL: fake.authUrl,
    INTENT_SHOP_MCP_URL: fake.mcpUrl,
  };
  return {
    dir,
    keyBytes,
    shop: fake,
    env,
    async run(argv, options = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const stdin = new PassThrough();
      if (options.input !== undefined) stdin.end(options.input);
      const tty = options.tty === true;
      const io: Io = {
        env: options.env ?? env,
        stdin,
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        isTTY: { stdin: tty, stdout: tty },
        sleep: () => Promise.resolve(),
      };
      const { code } = await main(argv, io);
      return { code, out: out.join(""), err: err.join("") };
    },
  };
}

/** The device code, the tokens and the buyer's email (in Shop's id token) are nowhere in the output or the log. */
function expectNoSecrets(s: Setup, r: Result): void {
  const audit = existsSync(join(s.dir, "audit.jsonl")) ? readFileSync(join(s.dir, "audit.jsonl"), "utf8") : "";
  for (const secret of [s.shop.deviceCode, s.shop.accessToken, s.shop.refreshToken, FAKE_BUYER.email]) {
    expect(r.out + r.err).not.toContain(secret);
    expect(audit).not.toContain(secret);
  }
  expect(audit).not.toContain(s.shop.userCode);
}

const without = (env: Record<string, string>, unset: string) => Object.fromEntries(Object.entries(env).filter(([name]) => name !== unset));
const kinds = (dir: string) => (readChain(dir) as { kind: string }[]).map((e) => e.kind);
const bodies = (dir: string) => (readChain(dir) as { kind: string; body: Record<string, unknown> }[]).map((e) => e.body);

describe("intent wallet link shop", () => {
  it("links: shows the page and code, keeps the tokens in the vault, chains the link, prints the budget; no secret anywhere", async () => {
    const s = await setup();
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain(`check that it shows the code ${s.shop.userCode}:\n  ${s.shop.authUrl}activate\n`);
    expect(r.out).toContain("Shop wallet linked: tokens kept in the encrypted vault");
    expect(r.out).toContain("Shop budget left for the gateway: 50.00 USD");
    expect(r.out).toContain("Purchases are still handed off to the merchant's checkout for now: one-tap with Shop is not yet wired to purchases");
    expect(r.out).not.toContain("refresh token");

    const vault = await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"));
    // S1: Shop issues a refresh token and an access token for 3600 s; the vault keeps when it expires, for the refresh.
    expect(JSON.parse(vault ?? "{}")).toEqual({
      v: 1,
      client_id: s.shop.clientId,
      access_token: s.shop.accessToken,
      refresh_token: s.shop.refreshToken,
      expires_at: expect.any(Number) as unknown,
    });
    expect(kinds(s.dir)).toEqual(["session", "disclosure", "response", "disclosure", "response", "wallet", "disclosure", "response"]);
    expect(bodies(s.dir)[5]).toEqual({ rail: "shop", action: "linked", revoked: false });
    expect(bodies(s.dir)[6]).toMatchObject({ endpoint: "get_account", destination: "shop" });
    expectNoSecrets(s, r);

    const status = await s.run(["wallet", "status"]);
    expect(status.out).toContain("Shop wallet: linked (encrypted vault");
    const log = await s.run(["log", "-v"]);
    expect(log.out).toContain("Shop wallet linked");
    expect(log.out).not.toContain("token not revoked");
    expectNoSecrets(s, log);
    const verify = await s.run(["verify", "--skip-install-check"]);
    expect(verify.code, verify.out + verify.err).toBe(0);
    expect(verify.out).toContain("credentials digested in the log");
  });

  it("linking again: the new sign-in first, then the earlier token revoked (logged), the unlink chained, then the link", async () => {
    const s = await setup();
    expect((await s.run(["wallet", "link", "shop"])).code).toBe(0);
    const old = { access: s.shop.accessToken, refresh: s.shop.refreshToken };
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("Shop wallet already linked: it stays as it is unless this new link succeeds");
    expect(r.out).toContain("Shop acknowledged the revocation of the earlier tokens (HTTP 200)");
    const form = "application/x-www-form-urlencoded";
    expect(s.shop.revocations).toEqual([
      { token: old.refresh, tokenTypeHint: "refresh_token", clientId: s.shop.clientId, contentType: form },
      { token: old.access, tokenTypeHint: "access_token", clientId: s.shop.clientId, contentType: form },
    ]);
    expect(s.shop.refreshToken).not.toBe(old.refresh);
    const chain = readChain(s.dir) as { kind: string; body: Record<string, unknown> }[];
    const second = chain.slice(8);
    expect(second.map((e) => e.kind)).toEqual([
      "session",
      "disclosure",
      "response",
      "disclosure",
      "response",
      "disclosure",
      "response",
      "disclosure",
      "response",
      "wallet",
      "wallet",
      "disclosure",
      "response",
    ]);
    expect(second.filter((e) => e.kind === "disclosure").map((e) => e.body.endpoint)).toEqual(["device_authorization", "token", "revoke", "revoke", "get_account"]);
    expect(second[9]?.body).toEqual({ rail: "shop", action: "unlinked", revoked: true });
    expect(second[10]?.body).toEqual({ rail: "shop", action: "linked", revoked: false });
    // The new grant survives the revocation of the old one.
    expect(r.out).toContain("Shop budget left for the gateway");
    const vault = await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"));
    expect(JSON.parse(vault ?? "{}")).toMatchObject({ access_token: s.shop.accessToken, refresh_token: s.shop.refreshToken });
    expectNoSecrets(s, r);
    const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
    for (const secret of [old.access, old.refresh]) expect(audit + r.out + r.err).not.toContain(secret);
    const verify = await s.run(["verify", "--skip-install-check"]);
    expect(verify.code, verify.out + verify.err).toBe(0);
  });

  it("linking again when the revocation fails: warns, chains revoked:false, and the new link stands", async () => {
    const s = await setup({ revokeStatus: 500 });
    expect((await s.run(["wallet", "link", "shop"])).code).toBe(0);
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("Shop answered the revocation with an error");
    expect(r.err).toContain("intent: warning: the earlier Shop tokens were not both revoked; remove the earlier connection in the Shop app: Account › Connections");
    const bodies = (readChain(s.dir) as { kind: string; body: unknown }[]).filter((e) => e.kind === "wallet").map((e) => e.body);
    expect(bodies).toEqual([
      { rail: "shop", action: "linked", revoked: false },
      { rail: "shop", action: "unlinked", revoked: false },
      { rail: "shop", action: "linked", revoked: false },
    ]);
    const vault = await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"));
    expect(JSON.parse(vault ?? "{}")).toMatchObject({ access_token: s.shop.accessToken });
    expectNoSecrets(s, r);
  });

  it("linking again when the new sign-in fails: the earlier link is untouched, nothing revoked, nothing chained as unlinked", async () => {
    const s = await setup();
    expect((await s.run(["wallet", "link", "shop"])).code).toBe(0);
    const before = await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"));
    s.shop.faults.deviceAnswers = ["expired_token"];
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the sign-in code expired before it was approved; the earlier link is kept unchanged; run");
    expect(s.shop.revocations).toEqual([]);
    expect(await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"))).toBe(before);
    const bodies = (readChain(s.dir) as { kind: string; body: unknown }[]).filter((e) => e.kind === "wallet").map((e) => e.body);
    expect(bodies).toEqual([{ rail: "shop", action: "linked", revoked: false }]);
    expect((await s.run(["wallet", "status"])).out).toContain("Shop wallet: linked");
  });

  it("no Shop client set: unavailable, exit 1, nothing sent to Shop and nothing chained", async () => {
    const s = await setup();
    const env = without(s.env, "INTENT_SHOP_CLIENT_ID");
    const r = await s.run(["wallet", "link", "shop"], { env });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "intent: Shop one-tap is unavailable until a registered Shop client is set (INTENT_SHOP_CLIENT_ID); nothing was sent to Shop, and purchases are handed off to the merchant's checkout\n",
    );
    expect(s.shop.oauthRequests).toEqual([]);
    expect(s.shop.calls).toEqual([]);
    expect(existsSync(join(s.dir, "audit.jsonl"))).toBe(false);
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
  });

  it.runIf(process.platform === "linux")("no safe place for the wallet key (as in the Docker image without a key secret): exit 1 before anything is sent", async () => {
    const s = await setup();
    const rest = without(s.env, "INTENT_WALLET_KEY_FILE");
    // The default key file would sit inside the data dir, so there is no key source, as in the image without a secret.
    const r = await s.run(["wallet", "link", "shop"], { env: { ...rest, XDG_CONFIG_HOME: join(s.dir, "config") } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("set INTENT_WALLET_KEY_FILE");
    expect(s.shop.oauthRequests).toEqual([]);
    expect(existsSync(join(s.dir, "audit.jsonl"))).toBe(false);
  });

  it("expired_token: exit 1 naming the command to run again; no vault file, no wallet entry, no secret", async () => {
    const s = await setup({ deviceAnswers: ["authorization_pending", "slow_down", "expired_token"] });
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^intent: Shop wallet not linked: the sign-in code expired before it was approved; run .* wallet link shop to try again\n$/);
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
    expect(kinds(s.dir)).not.toContain("wallet");
    expectNoSecrets(s, r);
  });

  it("access_denied: exit 1, nothing kept", async () => {
    const s = await setup({ deviceAnswers: ["access_denied"] });
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the link was declined in Shop");
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
  });

  it("no refresh token from Shop: linked, and says to link again when the access token expires", async () => {
    const s = await setup({ noRefreshToken: true });
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Shop issued no refresh token: when its access token expires \(in about 1 h\), run .* wallet link shop again/);
    expectNoSecrets(s, r);
  });

  it("refuses an unknown wallet with exit 2", async () => {
    const s = await setup();
    expect((await s.run(["wallet", "link", "paypal"])).code).toBe(2);
    expect((await s.run(["wallet", "link"])).code).toBe(2);
    expect(s.shop.oauthRequests).toEqual([]);
  });
});

describe("intent init", () => {
  it("no terminal (Docker, a pipe): checks, names the policy, skips Shop without asking, prints the connect line; exit 0", async () => {
    const s = await setup();
    const r = await s.run(["init"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain(`intent init: data dir ${s.dir}`);
    expect(r.out).toContain("policy: the bundled zip-only");
    expect(r.out).toContain("chain: empty");
    expect(r.out).toContain("Shop one-tap: skipped (no terminal to ask at); purchases are handed off to the merchant's checkout; link it later with");
    expect(r.out).not.toContain("[y/N]");
    expect(r.out).toContain("Connect an agent (Claude Code):\n  claude mcp add intent -e INTENT_DATA_DIR=");
    expect(r.out).toContain(`-e INTENT_SHOP_CLIENT_ID=${s.shop.clientId}`);
    expect(s.shop.oauthRequests).toEqual([]);
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
  });

  it("a wallet key from INTENT_WALLET_KEY: says the connect line leaves it out, and never prints the key", async () => {
    const s = await setup();
    const key = randomBytes(32).toString("base64");
    const r = await s.run(["init"], { env: { ...without(s.env, "INTENT_WALLET_KEY_FILE"), INTENT_WALLET_KEY: key } });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("The wallet key comes from INTENT_WALLET_KEY, which this line leaves out: set INTENT_WALLET_KEY_FILE");
    expect(r.out + r.err).not.toContain(key);
    const withFile = await s.run(["init"]);
    expect(withFile.out).not.toContain("comes from INTENT_WALLET_KEY");
  });

  it("--yes at a terminal skips the Shop step too", async () => {
    const s = await setup();
    const r = await s.run(["init", "--yes"], { tty: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Shop one-tap: skipped (--yes)");
    expect(r.out).not.toContain("[y/N]");
    expect(s.shop.oauthRequests).toEqual([]);
  });

  it("N at the prompt: no vault file, nothing sent, hand-off", async () => {
    const s = await setup();
    const r = await s.run(["init"], { tty: true, input: "n\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Pay in one tap with Shop? [y/N] ");
    expect(r.out).toContain("Shop one-tap: not linked; purchases are handed off to the merchant's checkout");
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
    expect(s.shop.oauthRequests).toEqual([]);
  });

  it("y at the prompt: links with the fake (vault file, wallet entry), then prints the connect line; a second init does not ask again", async () => {
    const s = await setup();
    const r = await s.run(["init"], { tty: true, input: "y\n" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`check that it shows the code ${s.shop.userCode}`);
    expect(r.out).toContain("Shop wallet linked");
    expect(r.out).toContain("claude mcp add intent");
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(true);
    expect(bodies(s.dir)).toContainEqual({ rail: "shop", action: "linked", revoked: false });
    expectNoSecrets(s, r);

    const again = await s.run(["init"], { tty: true, input: "y\n" });
    expect(again.out).toContain("Shop one-tap: a Shop wallet is already linked");
    expect(again.out).not.toContain("[y/N]");
  });

  it("y, but the code expires: setup still finishes with the connect line; exit 1 with the command to retry", async () => {
    const s = await setup({ deviceAnswers: ["expired_token"] });
    const r = await s.run(["init"], { tty: true, input: "y\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("wallet link shop to try again");
    expect(r.out).toContain("claude mcp add intent");
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
  });

  it("no Shop client set: no prompt even at a terminal, and nothing sent", async () => {
    const s = await setup();
    const env = without(s.env, "INTENT_SHOP_CLIENT_ID");
    const r = await s.run(["init"], { env, tty: true, input: "y\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Shop one-tap: unavailable until a registered Shop client is set (INTENT_SHOP_CLIENT_ID)");
    expect(r.out).not.toContain("[y/N]");
    expect(s.shop.oauthRequests).toEqual([]);
  });

  it("demo mode: Shop is not offered, and the connect line runs the demo", async () => {
    const s = await setup();
    const r = await s.run(["init", "--demo"], { tty: true, input: "y\n" });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("Shop one-tap: not offered in demo mode");
    expect(r.out).toMatch(/claude mcp add intent .*-- .* demo\n/);
    expect(s.shop.oauthRequests).toEqual([]);
  });
});

describe("hostConnect", () => {
  it("passes the shared settings with -e, quotes what the shell would split, and leaves the wallet key out", () => {
    expect(hostConnect("intent", {})).toBe("claude mcp add intent -- intent");
    expect(hostConnect("npx -y intent-gateway@next", { INTENT_DATA_DIR: "/home/me/my data", INTENT_WALLET_KEY: "secret", INTENT_POLICY: "" }, ["--trust-keys", "k.json"])).toBe(
      "claude mcp add intent -e INTENT_DATA_DIR='/home/me/my data' -- npx -y intent-gateway@next --trust-keys k.json",
    );
  });
});
