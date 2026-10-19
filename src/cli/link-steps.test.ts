// `intent wallet link shop --start` / `--finish` (the two-step link for an agent's shell) and `intent wallet status
// --wait-budget`, against the fake Shop with a temporary INTENT_DATA_DIR. The pending grant is a credential: sealed
// in the wallet vault (0600), claimed by one --finish at a time, deleted after every terminal answer, and its device
// code is in no output, error or log line. Attack (invariant 2): when the log cannot be written, --finish sends no
// token request.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readChain } from "../store/index.ts";
import { loadSecret, pendingGrantPath, savePendingGrant, vaultPath, WalletKey } from "../wallet/index.ts";
import { SHOP_PUBLIC_CLIENT_ID } from "../disclosure/index.ts";
import { FAKE_BUYER, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { type Io, main } from "./index.ts";

interface Result {
  code: number;
  out: string;
  err: string;
}

interface RunOptions {
  env?: Record<string, string>;
  /** Called at each sleep with its length; the clock moves on by that much, once it resolves. */
  onSleep?: (ms: number) => void | Promise<void>;
}

interface Setup {
  dir: string;
  keyBytes: Buffer;
  shop: FakeShop;
  env: Record<string, string>;
  clock: { now: number };
  sleeps: number[];
  run(argv: string[], options?: RunOptions): Promise<Result>;
}

let shop: FakeShop | undefined;
afterEach(async () => {
  await shop?.close();
  shop = undefined;
});

async function setup(faults: FakeShopFaults = {}, clientId?: string): Promise<Setup> {
  const fake = await startFakeShop({ faults, ...(clientId === undefined ? {} : { clientId }) });
  shop = fake;
  const root = mkdtempSync(join(tmpdir(), "wallet-link-steps-"));
  const dir = join(root, "data");
  const keyBytes = randomBytes(32);
  const keyFile = join(root, "wallet.key");
  writeFileSync(keyFile, `${keyBytes.toString("base64")}\n`, { mode: 0o600 });
  const env = { INTENT_DATA_DIR: dir, INTENT_WALLET_KEY_FILE: keyFile, INTENT_SHOP_CLIENT_ID: fake.clientId, INTENT_SHOP_AUTH_URL: fake.authUrl, INTENT_SHOP_MCP_URL: fake.mcpUrl };
  const clock = { now: Date.UTC(2026, 9, 18, 12, 0, 0) };
  const sleeps: number[] = [];
  return {
    dir,
    keyBytes,
    shop: fake,
    env,
    clock,
    sleeps,
    async run(argv, options = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const io: Io = {
        env: options.env ?? env,
        stdin: new PassThrough(),
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        isTTY: { stdin: false, stdout: false },
        now: () => clock.now,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          clock.now += ms;
          await options.onSleep?.(ms);
        },
      };
      const { code } = await main(argv, io);
      return { code, out: out.join(""), err: err.join("") };
    },
  };
}

const audit = (s: Setup): string => (existsSync(join(s.dir, "audit.jsonl")) ? readFileSync(join(s.dir, "audit.jsonl"), "utf8") : "");
const pendingFiles = (s: Setup): string[] => (existsSync(join(s.dir, "wallet")) ? readdirSync(join(s.dir, "wallet")).filter((n) => n.startsWith("shop-pending")) : []);
const chain = (s: Setup) => readChain(s.dir) as { kind: string; body: Record<string, unknown> }[];
const disclosures = (s: Setup) => chain(s).filter((e) => e.kind === "disclosure");
/** The device flow's requests only: the device authorization and the device-code polls (not a later refresh). */
const oauthPaths = (s: Setup) => s.shop.oauthRequests.filter((q) => q.path === "/oauth/device" || q.form.grant_type !== "refresh_token").map((q) => q.path);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The device code, the tokens and the buyer's email are in no output and no log line. */
function expectNoSecrets(s: Setup, ...results: Result[]): void {
  const log = audit(s);
  for (const secret of [s.shop.deviceCode, s.shop.accessToken, s.shop.refreshToken, FAKE_BUYER.email]) {
    for (const r of results) expect(r.out + r.err).not.toContain(secret);
    expect(log).not.toContain(secret);
  }
}

const START = ["wallet", "link", "shop", "--start"];
const FINISH = ["wallet", "link", "shop", "--finish"];

describe("intent wallet link shop --start, then --finish", () => {
  it("start: one line with the page, the code and the expiry, the grant sealed 0600, exit at once; finish: tokens kept, grant gone", async () => {
    const s = await setup();
    const start = await s.run(START);
    expect(start.code, start.err).toBe(0);
    expect(start.err).toBe("");
    expect(start.out).toBe(
      `Open ${s.shop.authUrl}activate?user_code=${s.shop.userCode} and approve the code ${s.shop.userCode} in Shop before 2026-10-18T12:10:00Z, then run intent wallet link shop --finish\n`,
    );
    // Only the device authorization was sent, and it was logged first; no wait.
    expect(oauthPaths(s)).toEqual(["/oauth/device"]);
    expect(s.sleeps).toEqual([]);
    expect(chain(s).map((e) => e.kind)).toEqual(["session", "disclosure", "response"]);
    expect(disclosures(s)[0]?.body).toMatchObject({ endpoint: "device_authorization", destination: "shop_accounts" });
    const file = pendingGrantPath(s.dir, "shop");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Sealed like the tokens: neither the device code nor the client is readable in the file.
    const sealed = readFileSync(file);
    expect(sealed.subarray(0, 4).toString("latin1")).toBe("IGWV");
    expect(sealed.toString("latin1")).not.toContain(s.shop.deviceCode);

    const finish = await s.run(FINISH);
    expect(finish.code, finish.err).toBe(0);
    expect(finish.err).toBe("");
    expect(finish.out).toContain("Waiting for you to approve the code in Shop (until 2026-10-18T12:10:00Z; if this stops early, run --finish again)…\n");
    expect(finish.out).toContain("Shop wallet linked: tokens kept in the encrypted vault");
    expect(finish.out).toContain("Shop budget left for the gateway: 50.00 USD\n");
    // Agent payments are already on in this account: the --wait-budget line, and no next step.
    expect(finish.out).toContain("Shop budget left for the gateway: 50.00 USD\nAgent payments on: $150.00 per month, $50.00 left\n");
    expect(finish.out).not.toContain("Tap ");
    expect(oauthPaths(s)).toEqual(["/oauth/device", "/oauth/token"]);
    expect(s.sleeps).toEqual([5000]);
    const vault = JSON.parse((await loadSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"))) ?? "{}") as Record<string, unknown>;
    expect(vault).toMatchObject({ v: 1, client_id: s.shop.clientId, access_token: s.shop.accessToken, refresh_token: s.shop.refreshToken });
    expect(pendingFiles(s)).toEqual([]);
    expect(chain(s).filter((e) => e.kind === "wallet").map((e) => e.body)).toEqual([{ rail: "shop", action: "linked", revoked: false }]);

    // The token poll was logged with the device code digested, before it left.
    const token = disclosures(s).find((e) => e.body.endpoint === "token");
    const logged = new URLSearchParams(Buffer.from(String(token?.body.body_b64), "base64").toString("utf8"));
    expect(logged.get("device_code")).toBe(`[redacted sha256:${sha(s.shop.deviceCode)}]`);
    expect(logged.get("client_id")).toBe(s.shop.clientId);
    expectNoSecrets(s, start, finish);
    const verify = await s.run(["verify", "--skip-install-check"]);
    expect(verify.code, verify.out + verify.err).toBe(0);
  });

  it("finish after the code expired: one line naming --start, no token request, the grant deleted", async () => {
    const s = await setup();
    expect((await s.run(START)).code).toBe(0);
    s.clock.now += 10 * 60_000;
    const r = await s.run(FINISH);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toBe("intent: Shop wallet not linked: the pending sign-in code expired at 2026-10-18T12:10:00Z; nothing was sent to Shop. run intent wallet link shop --start for a new one\n");
    expect(oauthPaths(s)).toEqual(["/oauth/device"]);
    expect(pendingFiles(s)).toEqual([]);
    expectNoSecrets(s, r);
  });

  it("finish without start: one line naming --start, nothing sent, nothing logged", async () => {
    const s = await setup();
    const r = await s.run(FINISH);
    expect(r.code).toBe(1);
    expect(r.err).toBe("intent: Shop wallet not linked: no Shop sign-in is pending; run intent wallet link shop --start first\n");
    expect(s.shop.oauthRequests).toEqual([]);
    expect(audit(s)).toBe("");
  });

  it("denied in Shop: exit 1 naming --start, nothing kept, the grant deleted", async () => {
    const s = await setup({ deviceAnswers: ["authorization_pending", "access_denied"] });
    const start = await s.run(START);
    const r = await s.run(FINISH);
    expect(r.code).toBe(1);
    expect(r.err).toBe("intent: Shop wallet not linked: the link was declined in Shop; run intent wallet link shop --start to try again\n");
    expect(existsSync(vaultPath(s.dir, "shop"))).toBe(false);
    expect(pendingFiles(s)).toEqual([]);
    expect(chain(s).map((e) => e.kind)).not.toContain("wallet");
    expectNoSecrets(s, start, r);
  });

  it("expired at Shop while polling: the grant deleted", async () => {
    const s = await setup({ deviceAnswers: ["expired_token"] });
    await s.run(START);
    const r = await s.run(FINISH);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the sign-in code expired before it was approved; run intent wallet link shop --start to try again");
    expect(pendingFiles(s)).toEqual([]);
  });

  it("slow_down: the same rules as a one-step link (interval + 5 s), then the tokens", async () => {
    const s = await setup({ deviceAnswers: ["authorization_pending", "slow_down", "ok"] });
    await s.run(START);
    const r = await s.run(FINISH);
    expect(r.code, r.err).toBe(0);
    expect(s.sleeps).toEqual([5000, 5000, 10_000]);
    expect(oauthPaths(s)).toEqual(["/oauth/device", "/oauth/token", "/oauth/token", "/oauth/token"]);
    expect(pendingFiles(s)).toEqual([]);
  });

  it("a busy Shop (HTTP 503, no error code) while polling: waits longer and asks again; the grant is not lost", async () => {
    const s = await setup({ deviceAnswers: ["unavailable", "ok"] });
    await s.run(START);
    const r = await s.run(FINISH);
    expect(r.code, r.err).toBe(0);
    expect(s.sleeps).toEqual([5000, 10_000]);
    expect(pendingFiles(s)).toEqual([]);
  });

  it("a pending file that is not a grant: deleted, with one line naming --start", async () => {
    const s = await setup();
    await s.run(START);
    await savePendingGrant(s.dir, "shop", new WalletKey(s.keyBytes, "test"), "not a grant");
    const r = await s.run(FINISH);
    expect(r.code).toBe(1);
    expect(r.err).toBe("intent: Shop wallet not linked: the pending Shop sign-in cannot be read, so it was deleted; nothing was sent to Shop. run intent wallet link shop --start for a new one\n");
    expect(pendingFiles(s)).toEqual([]);
  });

  it("a finish in a new process that got the pid of a killed one (pid 1 in every container run): takes the grant over", async () => {
    const s = await setup();
    await s.run(START);
    renameSync(pendingGrantPath(s.dir, "shop"), join(s.dir, "wallet", `shop-pending.${String(process.pid)}.0123456789abcdef.claim`));
    const r = await s.run(FINISH);
    expect(r.code, r.err).toBe(0);
    expect(pendingFiles(s)).toEqual([]);
  });

  it("start again while a grant is pending: replaces it and says so", async () => {
    const s = await setup();
    await s.run(START);
    const again = await s.run(START);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/^Replaced the Shop sign-in that was pending: its code no longer works with this gateway\nOpen /);
    expect(pendingFiles(s)).toEqual(["shop-pending.enc"]);
  });

  it("two finishes at once: one claims the grant and links, the other is refused and sends nothing", async () => {
    const s = await setup({ deviceAnswers: ["authorization_pending", "ok"] });
    await s.run(START);
    // The first finish is held in its first wait; the second runs meanwhile.
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let waiting = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const first = s.run(FINISH, {
      onSleep: () => {
        waiting();
        return gate;
      },
    });
    await held;
    const second = await s.run(FINISH);
    open();
    expect((await first).code).toBe(0);
    expect(second.code).toBe(1);
    expect(second.err).toMatch(/^intent: Shop wallet not linked: another intent wallet link shop --finish \(pid \d+\) is already waiting for this sign-in\n$/);
    expect(chain(s).filter((e) => e.kind === "wallet")).toHaveLength(1);
    expect(oauthPaths(s).filter((p) => p === "/oauth/token")).toHaveLength(2);
    expect(pendingFiles(s)).toEqual([]);
  });

  it("a finish that was killed while waiting: the next one takes its grant over and links", async () => {
    const s = await setup();
    await s.run(START);
    // Above the largest pid Linux can give (2^22), so no process has it.
    const gone = 4_194_305;
    const file = pendingGrantPath(s.dir, "shop");
    renameSync(file, join(s.dir, "wallet", `shop-pending.${String(gone)}.0123456789abcdef.claim`));
    const r = await s.run(FINISH);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Shop wallet linked");
    expect(pendingFiles(s)).toEqual([]);
  });

  it("a grant started as another client is not polled as this one; it stays for the client it was made for", async () => {
    const s = await setup();
    await s.run(START);
    const r = await s.run(FINISH, { env: { ...s.env, INTENT_SHOP_CLIENT_ID: "another-client" } });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      `intent: Shop wallet not linked: the pending Shop sign-in was started as the client ${s.shop.clientId}, but the client in effect now is another-client; nothing was sent to Shop. Restore that setting and run --finish again, or run intent wallet link shop --start to replace it\n`,
    );
    expect(oauthPaths(s)).toEqual(["/oauth/device"]);
    expect(pendingFiles(s)).toEqual(["shop-pending.enc"]);
    expect((await s.run(FINISH)).code).toBe(0);
  });

  it("attack: a grant started for another Shop account server is never sent to this one", async () => {
    const s = await setup();
    await s.run(START);
    const other = await startFakeShop();
    try {
      const r = await s.run(FINISH, { env: { ...s.env, INTENT_SHOP_AUTH_URL: other.authUrl } });
      expect(r.code).toBe(1);
      expect(r.err).toContain("was started with another INTENT_SHOP_AUTH_URL or INTENT_SHOP_MCP_URL than the ones in effect now; nothing was sent to Shop");
      expect(other.oauthRequests).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("attack (invariant 2): the log cannot be written, so --finish sends no token request and keeps the grant", async () => {
    const s = await setup();
    await s.run(START);
    chmodSync(join(s.dir, "audit.jsonl"), 0o400);
    const r = await s.run(FINISH);
    chmodSync(join(s.dir, "audit.jsonl"), 0o600);
    expect(r.err).toMatch(/^intent: EACCES: permission denied, open '.*audit\.jsonl'; check the permissions, or set INTENT_DATA_DIR to a folder you own\n$/);
    expect(r.code).toBe(1);
    expect(oauthPaths(s)).toEqual(["/oauth/device"]);
    expect(pendingFiles(s)).toEqual(["shop-pending.enc"]);
    expect(r.out + r.err).not.toContain(s.shop.deviceCode);
  });

  it("--start and --finish together are refused", async () => {
    const s = await setup();
    const r = await s.run([...START, "--finish"]);
    expect(r.code).toBe(2);
    expect(s.shop.oauthRequests).toEqual([]);
  });
});

describe("the next step after --finish: turn on agent payments", () => {
  /** What --finish prints after the budget line, for an account with agent payments off. */
  async function finished(faults: FakeShopFaults = {}, clientId?: string, policy?: string): Promise<Result> {
    const s = await setup({ budgetMinor: null, ...faults }, clientId);
    if (policy !== undefined) {
      mkdirSync(s.dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(s.dir, "policy.yaml"), policy);
    }
    expect((await s.run(START)).code).toBe(0);
    const r = await s.run(FINISH);
    expect(r.code, r.err).toBe(0);
    return r;
  }
  const tail = (r: Result): string => r.out.slice(r.out.indexOf("Shop budget: Shop shows none"));
  const NONE = 'Shop budget: Shop shows none for this connection, so one-tap is unavailable; turn on "Allow agent to pay" with a budget in the Shop app\n';

  it("the gateway's own (or any other) client: the page Shop names, then Tap intent and 4 × the weekly ceiling with no weekly cap", async () => {
    expect(tail(await finished())).toBe(`${NONE}https://shop.app/account/connections\nTap intent, turn on Allow agent to pay for me, enter $400.\n`);
  });

  it("Shop's public client, recorded in the vault: Tap Personal Agent; weekly-40 suggests $160", async () => {
    const r = await finished({}, SHOP_PUBLIC_CLIENT_ID, "version: 1\napproval: passkey\nspend:\n  per_order_usd: 20\n  per_week_usd: 40\n");
    expect(tail(r)).toBe(`${NONE}https://shop.app/account/connections\nTap Personal Agent, turn on Allow agent to pay for me, enter $160.\n`);
  });

  it("no manage_connection link in Shop's answer: S1's connections page", async () => {
    expect(tail(await finished({ manageConnectionUrl: null }))).toBe(`${NONE}https://shop.app/account/connections\nTap intent, turn on Allow agent to pay for me, enter $400.\n`);
  });

  it("attack: a connections link off shop.app is never printed; only what to tap", async () => {
    for (const url of ["https://evil.example/account/connections", "http://shop.app/account/connections"]) {
      const r = await finished({ manageConnectionUrl: url });
      expect(tail(r)).toBe(`${NONE}Tap intent, turn on Allow agent to pay for me, enter $400.\n`);
      expect(r.out).not.toContain("evil.example");
      await shop?.close();
      shop = undefined;
    }
  });
});

describe("intent wallet status --wait-budget", () => {
  const WAIT = ["wallet", "status", "--wait-budget"];
  const getAccounts = (s: Setup) => s.shop.calls.filter((c) => c.tool === "get_account").length;
  const loggedAccounts = (s: Setup) => disclosures(s).filter((e) => e.body.endpoint === "get_account").length;

  async function linked(faults: FakeShopFaults = {}): Promise<Setup> {
    const s = await setup(faults);
    expect((await s.run(["wallet", "link", "shop"])).code).toBe(0);
    s.sleeps.length = 0;
    return s;
  }

  it("the budget appears on the 3rd read: one line with Shop's limit, period and amount left; every read logged before it was sent", async () => {
    const s = await linked({ budgetMinor: null });
    const before = getAccounts(s);
    const r = await s.run(WAIT, {
      onSleep: () => {
        // Two reads have seen no budget: the developer turns it on before the third.
        if (getAccounts(s) - before === 2) s.shop.faults.budgetMinor = 5000;
      },
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("Agent payments on: $150.00 per month, $50.00 left\n");
    expect(r.err).toBe("");
    expect(getAccounts(s) - before).toBe(3);
    expect(s.sleeps).toEqual([5000, 5000]);
    // Each read Shop received has its disclosure, and its response, in the chain.
    expect(loggedAccounts(s)).toBe(getAccounts(s));
    const kinds = chain(s).map((e) => e.kind);
    expect(kinds.filter((k) => k === "response")).toHaveLength(kinds.filter((k) => k === "disclosure").length);
  });

  it("another period is named as Shop names it, never assumed monthly", async () => {
    const s = await linked({ budgetRenewal: "weekly", budgetLimitMinor: 4000 });
    const r = await s.run(WAIT);
    expect(r.out).toBe("Agent payments on: $40.00 per week, $50.00 left\n");
    s.shop.faults.budgetRenewal = "fortnightly";
    expect((await s.run(WAIT)).out).toBe("Agent payments on: $40.00 limit, $50.00 left\n");
  });

  it("timeout: one line naming what to do, exit 1", async () => {
    const s = await linked({ budgetMinor: null });
    const before = getAccounts(s);
    const r = await s.run([...WAIT, "--timeout", "30"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toBe(
      "intent: no Shop agent payments seen after 30 s (Shop shows no agent payments for this connection): open https://shop.app/account/connections, tap intent, turn on Allow agent to pay for me, then run intent wallet status --wait-budget again\n",
    );
    // Reads at 0, 5, … 25 s; the wait ends at 30 s.
    expect(getAccounts(s) - before).toBe(6);
    expect(loggedAccounts(s)).toBe(getAccounts(s));
  });

  it("a limit above 4 × the weekly ceiling (no weekly cap in the policy): one warning line", async () => {
    const s = await linked({ budgetLimitMinor: 50_000 });
    const r = await s.run(WAIT);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Agent payments on: $500.00 per month, $50.00 left\n");
    expect(r.err).toBe(
      "intent: warning: this limit is above $400.00, 4 × the weekly ceiling Intent Cloud enforces ($100); the Shop budget is the only hard stop, so lower it in the Shop app: Account › Connections\n",
    );
  });

  it("the policy's weekly cap sets the maximum: weekly-40 allows $160", async () => {
    const s = await linked({ budgetLimitMinor: 15_000 });
    writeFileSync(join(s.dir, "policy.yaml"), "version: 1\napproval: passkey\nspend:\n  per_week_usd: 40\n");
    expect((await s.run(WAIT)).err).toBe("");
    s.shop.faults.budgetLimitMinor = 16_001;
    expect((await s.run(WAIT)).err).toBe(
      "intent: warning: this limit is above $160.00, 4 × your policy's weekly cap ($40); the Shop budget is the only hard stop, so lower it in the Shop app: Account › Connections\n",
    );
  });

  it("the link revoked during the wait: stops at once, exit 1", async () => {
    const s = await linked({ budgetMinor: null });
    const before = getAccounts(s);
    const r = await s.run(WAIT, {
      onSleep: () => {
        s.shop.expireAccessTokens();
        s.shop.faults.refuseRefresh = true;
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe("intent: Shop refused this gateway's token (the link was revoked or removed); run intent wallet unlink shop, then intent wallet link shop --start\n");
    expect(s.sleeps).toEqual([5000]);
    expect(getAccounts(s) - before).toBe(2);
  });

  it("the connection removed in the Shop app during the wait: stops at once", async () => {
    const s = await linked({ budgetMinor: null });
    const r = await s.run(WAIT, {
      onSleep: () => {
        s.shop.faults.connectionRemoved = true;
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Shop answered that this connection can no longer read the account");
    expect(s.sleeps).toEqual([5000]);
  });

  it("no wallet linked: exit 1, nothing sent; a bad --timeout is refused", async () => {
    const s = await setup();
    const r = await s.run(WAIT);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no Shop wallet is linked, so there is no budget to wait for; nothing was sent to Shop");
    expect(s.shop.calls).toEqual([]);
    for (const bad of ["0", "601", "5s", "-1"]) expect((await s.run([...WAIT, "--timeout", bad])).code).toBe(2);
    expect((await s.run(["wallet", "status", "--timeout", "5"])).code).toBe(2);
  });
});
