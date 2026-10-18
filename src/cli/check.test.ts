// `intent wallet check shop` (plan G12, refinement 6) against the fake Shop. Acceptance: 3 orders in the period, 1 of
// them named by a chained outcome → 2 listed as unmatched, the `wallet checked` entry counts 2, and findIdentity over
// the chain is []. Attack: Shop's orders are full of the buyer's identity, and none of it reaches stdout, stderr or
// audit.jsonl. With no Shop client or no linked wallet, nothing is sent and nothing chained. `intent verify` holds the
// entry to its exact keys, and `intent log` words it as what Shop reported.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { findIdentity } from "../privacy/index.ts";
import { openStore, readChain } from "../store/index.ts";
import { saveSecret, WalletKey } from "../wallet/index.ts";
import { FAKE_BUYER, type FakeShop, startFakeShop } from "../wallet-shop-fake/index.ts";
import { type Io, main } from "./index.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const ORDERS = [
  { id: "gid://shopify/Order/7001", totalMinor: 1250, createdAt: "2026-10-15T09:00:00.000Z" },
  { id: "gid://shopify/Order/7002", totalMinor: 4000, createdAt: "2026-10-14T09:00:00.000Z" },
  { id: "gid://shopify/Order/7003", totalMinor: 899, createdAt: "2026-10-16T09:00:00.000Z" },
  // Before the 7-day period: not counted.
  { id: "gid://shopify/Order/6999", totalMinor: 99_999, createdAt: "2026-10-01T09:00:00.000Z" },
];

interface Entry {
  kind: string;
  body: Record<string, unknown>;
}

let shop: FakeShop | undefined;
afterEach(async () => {
  await shop?.close();
  shop = undefined;
});

async function setup(options: { link?: boolean } = {}) {
  const fake = await startFakeShop({ faults: { identityEverywhere: true } });
  shop = fake;
  fake.orders = [...ORDERS];
  const root = mkdtempSync(join(tmpdir(), "wallet-check-"));
  const dir = join(root, "data");
  const keyBytes = randomBytes(32);
  const keyFile = join(root, "wallet.key");
  writeFileSync(keyFile, `${keyBytes.toString("base64")}\n`, { mode: 0o600 });
  if (options.link !== false) {
    const vault = JSON.stringify({ v: 1, client_id: fake.clientId, access_token: fake.accessToken, refresh_token: fake.refreshToken });
    await saveSecret(dir, "shop", new WalletKey(keyBytes, "test"), vault);
  }
  const env: Record<string, string> = {
    INTENT_DATA_DIR: dir,
    INTENT_WALLET_KEY_FILE: keyFile,
    INTENT_SHOP_CLIENT_ID: fake.clientId,
    INTENT_SHOP_AUTH_URL: fake.authUrl,
    INTENT_SHOP_MCP_URL: fake.mcpUrl,
  };
  const run = async (argv: string[], runEnv: Record<string, string> = env) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      env: runEnv,
      stdin: new PassThrough(),
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => err.push(t) },
      isTTY: { stdin: false, stdout: false },
      now: () => NOW,
    };
    const { code } = await main(argv, io);
    return { code, out: out.join(""), err: err.join("") };
  };
  const audit = () => (existsSync(join(dir, "audit.jsonl")) ? readFileSync(join(dir, "audit.jsonl"), "utf8") : "");
  const entries = () => (existsSync(join(dir, "audit.jsonl")) ? (readChain(dir) as Entry[]) : []);
  return { dir, env, fake, keyBytes, run, audit, entries };
}

/** A hand-written `outcome` stub naming an order: the wallet check reads only `order_ref` (not a valid ADR-0015 entry). */
async function chainOutcome(dir: string, orderRef: string): Promise<void> {
  const store = await openStore(dir);
  await store.append("outcome", { handle: "ap_TEST0001", basis: "wallet", order_ref: orderRef });
  await store.close();
}

const buyerStrings = Object.values(FAKE_BUYER).filter((v) => v !== FAKE_BUYER.zip);

describe("intent wallet check shop", () => {
  it("3 orders in the period, 1 chained: lists the 2 unmatched, chains counts only, no identity anywhere (plan G12 acceptance)", async () => {
    const s = await setup();
    await chainOutcome(s.dir, "gid://shopify/Order/7002");
    const r = await s.run(["wallet", "check", "shop"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Shop reported 3 orders since 2026-10-10T12:00:00.000Z");
    expect(r.out).toContain("Matched to a purchase in this gateway's chain: 1");
    expect(r.out).toContain("Not matched: 2, totalling 21.49 USD");
    expect(r.out).toContain("  2026-10-15T09:00:00.000Z  gid://shopify/Order/7001  12.50 USD  https://stickers.example");
    expect(r.out).toContain("  2026-10-16T09:00:00.000Z  gid://shopify/Order/7003  8.99 USD  https://stickers.example");
    expect(r.out).not.toContain("Order/7002");
    expect(r.out).not.toContain("Order/6999");

    const checked = s.entries().filter((e) => e.kind === "wallet");
    expect(checked.map((e) => e.body)).toEqual([
      { rail: "shop", action: "checked", since: "2026-10-10T12:00:00.000Z", order_count: 3, unmatched_count: 2, unmatched_total_minor: 2149, complete: true },
    ]);
    // Logged before it was sent: one search_orders disclosure and its response, then the check.
    expect(s.entries().map((e) => e.kind)).toEqual(["outcome", "session", "disclosure", "response", "wallet"]);
    expect(s.fake.calls.map((c) => c.tool)).toEqual(["search_orders"]);

    expect(s.entries().flatMap((e) => findIdentity(e.body))).toEqual([]);
    for (const value of [...buyerStrings, "Engraved"]) {
      expect(r.out + r.err).not.toContain(value);
      expect(s.audit()).not.toContain(value);
    }
    // The unmatched orders' references are printed, never chained.
    expect(s.audit()).not.toContain("Order/7001");
  });

  it("--since narrows the period; Shop's 'more orders' is said, and chained as complete:false", async () => {
    const s = await setup();
    s.fake.faults.moreOrders = true;
    const r = await s.run(["wallet", "check", "shop", "--since", "2026-10-15T00:00:00Z"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Shop reported 2 orders since 2026-10-15T00:00:00.000Z");
    expect(r.out).toContain("Shop said more orders exist, or returned a full page of 50: these counts cover only the orders it returned");
    expect(r.out).toContain("Not matched among the orders returned: 2,");
    expect(s.entries().at(-1)?.body).toMatchObject({ order_count: 2, unmatched_count: 2, complete: false });
  });

  it("Shop returns exactly a full page of 50 and says nothing of more: the counts carry the caveat, complete:false", async () => {
    const s = await setup();
    s.fake.orders = Array.from({ length: 50 }, (_, i) => ({ id: `gid://shopify/Order/${String(8000 + i)}`, totalMinor: 100, createdAt: "2026-10-16T09:00:00.000Z" }));
    const r = await s.run(["wallet", "check", "shop"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Shop reported 50 orders since");
    expect(r.out).toContain("Shop said more orders exist, or returned a full page of 50: these counts cover only the orders it returned");
    expect(r.out).toContain("Not matched among the orders returned: 50, totalling 50.00 USD");
    expect(r.out).toContain("this check cannot say how it was placed");
    expect(s.entries().at(-1)?.body).toMatchObject({ order_count: 50, unmatched_count: 50, unmatched_total_minor: 5000, complete: false });
    const log = await s.run(["log", "--no-color"]);
    expect(log.out).toContain("Shop said more orders exist, or returned a full page of 50: counts cover only the orders it returned");
  });

  it("intent verify passes the checked entry, and intent log words it as what Shop reported", async () => {
    const s = await setup();
    await chainOutcome(s.dir, "gid://shopify/Order/7002");
    expect((await s.run(["wallet", "check", "shop"])).code).toBe(0);
    const verify = await s.run(["verify", "--skip-install-check"]);
    // The wallet entry passes. The hand-written outcome stub names no verified approval, and verify fails it (ADR-0015):
    // that is its only failure.
    expect(verify.out).toContain("disclosures: ok");
    expect(verify.out.match(/FAILED/g)).toEqual(["FAILED", "FAILED"]);
    expect(verify.out).toContain("outcomes: FAILED");
    expect(verify.out).toContain("seq 0: the outcome for ap_TEST0001 is not an outcome entry");
    const log = await s.run(["log", "--no-color"]);
    expect(log.code, log.err).toBe(0);
    expect(log.out).toContain("Shop wallet checked · Shop reported 3 orders since 2026-10-10 · 2 not matched to a purchase in this log (21.49 USD)");
    expect(log.out).toContain("Shop search_orders");
  });

  it("no wallet linked: a clear message naming the link command, exit 1, nothing sent and nothing chained", async () => {
    const s = await setup({ link: false });
    const r = await s.run(["wallet", "check", "shop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no Shop wallet is linked, so there is nothing to check; nothing was sent to Shop");
    expect(r.err).toContain("wallet link shop");
    expect(s.fake.calls).toEqual([]);
    expect(s.entries()).toEqual([]);
  });

  it("Shop refuses the token: the gateway's own words, no check chained, no identity printed", async () => {
    const s = await setup();
    // A token Shop does not know: the fake answers 401 with the buyer's identity in its error message.
    const vault = JSON.stringify({ v: 1, client_id: s.fake.clientId, access_token: "revoked-or-wrong", refresh_token: null });
    await saveSecret(s.dir, "shop", new WalletKey(s.keyBytes, "test"), vault);
    const r = await s.run(["wallet", "check", "shop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Shop refused the token and it could not be refreshed: link the wallet again");
    for (const value of buyerStrings) expect(r.out + r.err + s.audit()).not.toContain(value);
    expect(s.entries().map((e) => e.kind)).toEqual(["session", "disclosure", "response"]);
  });

  it("refuses an unknown wallet and a bad --since with exit 2, before anything is sent", async () => {
    const s = await setup();
    expect((await s.run(["wallet", "check", "paypal"])).code).toBe(2);
    expect((await s.run(["wallet", "check", "shop", "--since", "soon"])).code).toBe(2);
    expect((await s.run(["wallet", "check"])).code).toBe(2);
    expect(s.fake.calls).toEqual([]);
  });
});
