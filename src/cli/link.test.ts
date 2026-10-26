// `intent wallet link shop` and `intent init` (plan G8, AC-G11), against the fake Shop. Without INTENT_SHOP_CLIENT_ID
// the gateway signs in as its own client file; with it, as that client; a refused client is never swapped for another. A link puts the tokens in the vault and chains `wallet {rail, action: "linked", revoked: false}`.
// Attack: the device code and the tokens are in none of stdout, stderr and audit.jsonl; the user code and the page
// to approve on are on stdout only. init's Shop step never blocks setup: no terminal, --yes, "no" and no client each
// skip it with a line saying so.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/index.ts";
import { DEFAULT_SHOP_CLIENT_ID, type DisclosedCloud, openWalletSession } from "../disclosure/index.ts";
import { openStore, readChain } from "../store/index.ts";
import { loadSecret, saveSecret, vaultPath, WalletKey } from "../wallet/index.ts";
import { FAKE_BUYER, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { type FakeCloud, LIVE_CURRENCIES, startFakeCloud } from "../cloud-fake/index.ts";
import { hostConnect } from "./connect.ts";
import { type Io, main } from "./index.ts";
import { oneTapFor } from "./wallet.ts";

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
// Intent Cloud's meta, for the ceilings `intent wallet` reads when Shop shows a budget: never the real host.
let cloud: FakeCloud | undefined;
afterEach(async () => {
  await shop?.close();
  await cloud?.close();
  shop = undefined;
  cloud = undefined;
});

async function setup(faults: FakeShopFaults = {}, clientId?: string): Promise<Setup> {
  const fake = await startFakeShop({ faults, ...(clientId === undefined ? {} : { clientId }) });
  shop = fake;
  await cloud?.close();
  cloud = await startFakeCloud({ currencies: LIVE_CURRENCIES });
  const meta = cloud;
  const root = mkdtempSync(join(tmpdir(), "wallet-link-"));
  const trustKeys = join(root, "keys.json");
  writeFileSync(trustKeys, JSON.stringify({ rootKeys: [meta.keys.rootPin] }));
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
      // `intent wallet` commands reach the fake Intent Cloud for its ceilings, and `intent verify` checks what they
      // chained against its key; the others keep the env as given.
      const wallet = argv[0] === "wallet" || argv[0] === "verify";
      const io: Io = {
        env: wallet ? { ...(options.env ?? env), INTENT_CLOUD_URL: meta.url } : (options.env ?? env),
        stdin,
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        isTTY: { stdin: tty, stdout: tty },
        sleep: () => Promise.resolve(),
      };
      const { code } = await main(wallet ? [...argv, "--trust-keys", trustKeys] : argv, io);
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
    // No terminal (an agent's shell): the wait blocks it, so the line names the two-part link.
    expect(r.out).toContain("Running this from an agent's shell? Stop it and use intent wallet link shop --start, then --finish, so the link shows before the wait.\n");
    expect(r.out).toContain("Shop wallet linked: tokens kept in the encrypted vault");
    expect(r.out).toContain("Shop agent payments left for the gateway: 50.00 USD");
    expect(r.out).toContain("One-tap with Shop pays through agent payments only while they are on in the Shop app and your policy allows one tap; otherwise purchases are handed off to Shop's checkout page");
    expect(r.out).not.toContain("not yet wired");
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
    expect(verify.out).toContain("credential values sent, repeats counted (the log keeps only their sha256)");
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
    expect(r.out).toContain("Shop agent payments left for the gateway");
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

  it("without INTENT_SHOP_CLIENT_ID: signs in as the gateway's own client file, logged before it is sent", async () => {
    const s = await setup({}, DEFAULT_SHOP_CLIENT_ID);
    expect(DEFAULT_SHOP_CLIENT_ID).toBe("https://gateway.intentai.shop/shop-client.json");
    const r = await s.run(["wallet", "link", "shop"], { env: without(s.env, "INTENT_SHOP_CLIENT_ID") });
    expect(r.code, r.err).toBe(0);
    expect(s.shop.oauthRequests.length).toBeGreaterThan(1);
    for (const request of s.shop.oauthRequests) expect(request.form.client_id).toBe(DEFAULT_SHOP_CLIENT_ID);
    expect(s.shop.oauthRequests[0]?.form.scope).toBe("openid personal_agent");
    // The chain logged the client id before the device request left (invariant 2).
    const device = bodies(s.dir).find((b) => b.endpoint === "device_authorization");
    expect(new URLSearchParams(Buffer.from(String(device?.body_b64), "base64").toString("utf8")).get("client_id")).toBe(DEFAULT_SHOP_CLIENT_ID);
    const vault = await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"));
    expect(JSON.parse(vault ?? "{}")).toMatchObject({ client_id: DEFAULT_SHOP_CLIENT_ID });
    expectNoSecrets(s, r);
  });

  it("an explicit INTENT_SHOP_CLIENT_ID replaces the gateway's own client in every request", async () => {
    const s = await setup();
    expect(s.env.INTENT_SHOP_CLIENT_ID).not.toBe(DEFAULT_SHOP_CLIENT_ID);
    const r = await s.run(["wallet", "link", "shop"]);
    expect(r.code, r.err).toBe(0);
    for (const request of s.shop.oauthRequests) expect(request.form.client_id).toBe(s.shop.clientId);
    expect(readFileSync(join(s.dir, "audit.jsonl"), "utf8")).not.toContain(DEFAULT_SHOP_CLIENT_ID);
  });

  it("Shop refuses the gateway's own client (invalid_client): one line naming the opt-in, no other client tried", async () => {
    const s = await setup();
    const r = await s.run(["wallet", "link", "shop"], { env: without(s.env, "INTENT_SHOP_CLIENT_ID") });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      `intent: Shop wallet not linked: Shop does not accept the gateway's own client ${DEFAULT_SHOP_CLIENT_ID} (invalid_client), and no other client was tried; to sign in as another client (such as Shop's public client, for your own agent), set INTENT_SHOP_CLIENT_ID explicitly\n`,
    );
    // One device request, as the gateway's own client; no second client, no token poll.
    expect(s.shop.oauthRequests.map((q) => [q.path, q.form.client_id])).toEqual([["/oauth/device", DEFAULT_SHOP_CLIENT_ID]]);
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
    expect(kinds(s.dir)).not.toContain("wallet");
  });

  it("Shop refuses an explicit INTENT_SHOP_CLIENT_ID (invalid_client): says to check it, and tries no other client", async () => {
    const s = await setup();
    const r = await s.run(["wallet", "link", "shop"], { env: { ...s.env, INTENT_SHOP_CLIENT_ID: "someone-elses-client" } });
    expect(r.code).toBe(1);
    expect(r.err).toBe("intent: Shop wallet not linked: Shop does not accept the client INTENT_SHOP_CLIENT_ID names (invalid_client); check its value\n");
    expect(s.shop.oauthRequests.map((q) => q.form.client_id)).toEqual(["someone-elses-client"]);
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

describe("a linked wallet keeps the client it was linked with", () => {
  /** The token requests sent after `from`, as [grant_type, client_id]. */
  const grants = (shop: FakeShop, from: number) => shop.oauthRequests.slice(from).map((q) => [q.form.grant_type, q.form.client_id]);

  it("linked with INTENT_SHOP_CLIENT_ID, then run without it: status refreshes and unlink revokes as the linked client", async () => {
    const s = await setup();
    expect((await s.run(["wallet", "link", "shop"])).code).toBe(0);
    s.shop.expireAccessTokens();
    const before = s.shop.oauthRequests.length;
    const env = without(s.env, "INTENT_SHOP_CLIENT_ID");
    const status = await s.run(["wallet", "status"], { env });
    expect(status.err).toBe("");
    expect(status.out).toContain("Shop agent payments left for the gateway: 50.00 USD");
    expect(grants(s.shop, before)).toEqual([["refresh_token", s.shop.clientId]]);
    expect(s.shop.oauthRequests.slice(before).map((q) => q.form.client_id)).not.toContain(DEFAULT_SHOP_CLIENT_ID);
    const unlink = await s.run(["wallet", "unlink", "shop"], { env });
    expect(unlink.code).toBe(0);
    expect(s.shop.revocations.map((r) => r.clientId)).toEqual([s.shop.clientId, s.shop.clientId]);
  });

  it("serve's one tap, started without INTENT_SHOP_CLIENT_ID (as claude mcp add does), refreshes as the linked client", async () => {
    const s = await setup();
    expect((await s.run(["wallet", "link", "shop"])).code).toBe(0);
    s.shop.expireAccessTokens();
    const before = s.shop.oauthRequests.length;
    const env = without(s.env, "INTENT_SHOP_CLIENT_ID");
    const err: string[] = [];
    const io: Io = { env, stdin: new PassThrough(), stdout: { write: () => true }, stderr: { write: (t: string) => err.push(t) }, isTTY: { stdin: false, stdout: false } };
    const oneTap = await oneTapFor(io, loadConfig(env, [], { requireTrust: false }), s.dir);
    expect(oneTap).not.toBeNull();
    const store = await openStore(s.dir);
    try {
      const wallet = oneTap?.connect(openWalletSession(store) as unknown as DisclosedCloud);
      expect((await wallet?.account())?.connected).toBe(true);
    } finally {
      await store.close();
    }
    expect(grants(s.shop, before)).toEqual([["refresh_token", s.shop.clientId]]);
    expect(err.join("")).toBe("");
  });

  it("INTENT_SHOP_CLIENT_ID set later to another client: one warning line, and the linked client is still used", async () => {
    const s = await setup();
    expect((await s.run(["wallet", "link", "shop"])).code).toBe(0);
    s.shop.expireAccessTokens();
    const before = s.shop.oauthRequests.length;
    const status = await s.run(["wallet", "status"], { env: { ...s.env, INTENT_SHOP_CLIENT_ID: "another-client" } });
    expect(status.err).toBe(
      `intent: warning: this Shop wallet was linked as the client ${s.shop.clientId}, so INTENT_SHOP_CLIENT_ID (another-client) is not used for it; run intent wallet link shop to link it as that client\n`,
    );
    expect(status.out).toContain("Shop agent payments left for the gateway: 50.00 USD");
    expect(grants(s.shop, before)).toEqual([["refresh_token", s.shop.clientId]]);
  });

  it("an older vault with no client_id: the env client when set, else the gateway's own; the next refresh records it", async () => {
    const older = async (clientId: string | undefined, env: (s: Setup) => Record<string, string>) => {
      const s = await setup({}, clientId);
      await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), JSON.stringify({ v: 1, access_token: s.shop.accessToken, refresh_token: s.shop.refreshToken }));
      s.shop.expireAccessTokens();
      const status = await s.run(["wallet", "status"], { env: env(s) });
      expect(status.err).toBe("");
      expect(status.out).toContain("Shop agent payments left for the gateway: 50.00 USD");
      expect(grants(s.shop, 0)).toEqual([["refresh_token", s.shop.clientId]]);
      const vault = JSON.parse((await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"))) ?? "{}") as { client_id?: string };
      expect(vault.client_id).toBe(s.shop.clientId);
      return s;
    };
    expect((await older(undefined, (s) => s.env)).shop.clientId).toBe("fake-shop-client");
    await shop?.close();
    expect((await older(DEFAULT_SHOP_CLIENT_ID, (s) => without(s.env, "INTENT_SHOP_CLIENT_ID"))).shop.clientId).toBe(DEFAULT_SHOP_CLIENT_ID);
  });
});

describe("intent init", () => {
  it("makes the account key once (mode 0600), keeps it on every later run, and prints only its path and thumbprint", async () => {
    const s = await setup();
    const file = join(s.dir, "account-key.json");
    const first = await s.run(["init"]);
    expect(first.code, first.out + first.err).toBe(0);
    expect(first.out).toMatch(new RegExp(`^ok +account key: made ${file.replaceAll(".", "\\.")} \\(thumbprint [A-Za-z0-9_-]{43}\\)$`, "m"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(file, "utf8");
    const { d, x } = JSON.parse(bytes) as { d: string; x: string };
    const second = await s.run(["init"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain(`account key: kept ${file} (thumbprint `);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    // The private half is never printed or chained; the public half is not printed either (only its thumbprint).
    const audit = existsSync(join(s.dir, "audit.jsonl")) ? readFileSync(join(s.dir, "audit.jsonl"), "utf8") : "";
    for (const text of [first.out, first.err, second.out, second.err, audit]) expect(text).not.toContain(d);
    expect(first.out + second.out).not.toContain(x);
  });

  it("attack: an account key file that is not one fails init and is never replaced", async () => {
    const s = await setup();
    await s.run(["init"]);
    const file = join(s.dir, "account-key.json");
    writeFileSync(file, "{}");
    const r = await s.run(["init"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL +account key: .+account-key\.json is not an account key .+; it was left as it is/m);
    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it("no terminal (Docker, a pipe): checks, names the policy, skips Shop without asking, prints the connect line; exit 0", async () => {
    const s = await setup();
    const r = await s.run(["init"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain(`intent init: data dir ${s.dir}`);
    expect(r.out).toContain("policy: the bundled zip-only");
    expect(r.out).toContain("log: empty");
    expect(r.out).toContain("Shop one-tap: skipped (no terminal to ask at); purchases are handed off to the merchant's checkout; link it later with");
    // From an agent's shell the link that works is the two-part one.
    expect(r.out).toMatch(/link it later with .* wallet link shop --start\n/);
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
    expect(r.out).not.toContain("from an agent's shell?");
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

  it("without INTENT_SHOP_CLIENT_ID: offers Shop at a terminal and links as the gateway's own client", async () => {
    const s = await setup({}, DEFAULT_SHOP_CLIENT_ID);
    const r = await s.run(["init"], { env: without(s.env, "INTENT_SHOP_CLIENT_ID"), tty: true, input: "y\n" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("[y/N]");
    expect(r.out).toContain("Shop wallet linked");
    expect(s.shop.oauthRequests[0]?.form.client_id).toBe(DEFAULT_SHOP_CLIENT_ID);
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
