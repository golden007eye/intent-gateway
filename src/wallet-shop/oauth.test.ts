// Linking Shop with the OAuth device flow (plan G8), against the fake Shop's account server, through the disclosure
// core. Attack cases: the device code and the tokens never reach audit.jsonl (only `[redacted sha256:…]` for what
// was sent; answers only as a digest and a size), and a failed log append means no request reaches Shop.
import * as fsp from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED } from "../../test/support/trust-kit.ts";
import { type DeviceGrantPrompt, linkShop, openWalletSession, ShopLinkError } from "../disclosure/index.ts";
import { openStore, type Store, type StoreFs } from "../store/index.ts";
import { runVerify } from "../verify/index.ts";
import { FAKE_BUYER, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { DEVICE_GRANT, parseShopCredentials, SHOP_SCOPE } from "./index.ts";

type Json = Record<string, unknown>;

let store: Store | undefined;
let shop: FakeShop | undefined;
let dir: string;
afterEach(async () => {
  await store?.close().catch(() => undefined);
  await shop?.close();
  store = undefined;
  shop = undefined;
});

interface Run {
  shop: FakeShop;
  prompts: DeviceGrantPrompt[];
  sleeps: number[];
  link: () => ReturnType<typeof linkShop>;
}

/** A fake Shop and a store; the clock moves only when the flow sleeps. */
async function setup(faults: FakeShopFaults = {}, options: { clientId?: string; fs?: StoreFs } = {}): Promise<Run> {
  const fake = await startFakeShop({ faults });
  shop = fake;
  dir = join(await fsp.mkdtemp(join(tmpdir(), "shop-link-")), "data");
  store = await openStore(dir, options.fs === undefined ? {} : { fs: options.fs });
  const session = openWalletSession(store);
  const prompts: DeviceGrantPrompt[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  return {
    shop: fake,
    prompts,
    sleeps,
    link: () =>
      linkShop(session, {
        mcpUrl: fake.mcpUrl,
        authUrl: fake.authUrl,
        clientId: options.clientId ?? fake.clientId,
        show: (p) => prompts.push(p),
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms;
          return Promise.resolve();
        },
        now: () => clock,
      }),
  };
}

const audit = () => readFileSync(join(dir, "audit.jsonl"), "utf8");
const entries = () => (store as Store).entries();

/** No credential of the flow, nor the buyer's email in Shop's id token, is anywhere in the log file. */
function expectNoSecrets(s: FakeShop): void {
  const text = audit();
  for (const secret of [s.deviceCode, s.accessToken, s.refreshToken, s.userCode, FAKE_BUYER.email]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(Buffer.from(secret).toString("base64").slice(0, 12));
  }
}

describe("linkShop: the device flow through the disclosure core", () => {
  it("happy path: tokens in the vault text; device code digested, tokens and user code nowhere in the log; verify passes", async () => {
    const run = await setup();
    const linked = await run.link();
    expect(parseShopCredentials(linked.vaultText)).toEqual({ clientId: run.shop.clientId, accessToken: run.shop.accessToken, refreshToken: run.shop.refreshToken });
    expect(linked).toMatchObject({ refreshIssued: true, expiresInS: 3600 });
    expect(linked.vaultText).not.toContain(FAKE_BUYER.email);

    expect(run.prompts).toEqual([
      {
        userCode: run.shop.userCode,
        verificationUri: `${run.shop.authUrl}activate`,
        verificationUriComplete: `${run.shop.authUrl}activate?user_code=${run.shop.userCode}`,
        expiresInS: 600,
      },
    ]);
    expect(run.sleeps).toEqual([5000]);
    const resource = new URL(run.shop.mcpUrl).origin;
    expect(run.shop.oauthRequests).toEqual([
      { path: "/oauth/device", form: { client_id: run.shop.clientId, scope: SHOP_SCOPE, resource }, contentType: "application/x-www-form-urlencoded" },
      { path: "/oauth/token", form: { grant_type: DEVICE_GRANT, device_code: run.shop.deviceCode, client_id: run.shop.clientId }, contentType: "application/x-www-form-urlencoded" },
    ]);
    expect(SHOP_SCOPE).not.toContain("email");

    expect(entries().map((e) => e.kind)).toEqual(["session", "disclosure", "response", "disclosure", "response"]);
    const [device, token] = entries().filter((e) => e.kind === "disclosure").map((e) => e.body as Json);
    expect(device).toMatchObject({ endpoint: "device_authorization", destination: "shop_accounts", fields: ["client_id", "resource", "scope"] });
    expect(device).not.toHaveProperty("redacted");
    expect(token).toMatchObject({ endpoint: "token", destination: "shop_accounts", fields: ["client_id", "device_code", "grant_type"], path: "/oauth/token" });
    expect((token?.redacted as Json[]).map((r) => r.at)).toEqual(["body.device_code"]);
    expectNoSecrets(run.shop);

    await store?.close();
    const report = await runVerify({ dataDir: dir, pinnedRootKeys: PINNED, now: new Date(), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.counts).toMatchObject({ disclosures: 2, responses: 2, redactions: 1 });
  });

  it("authorization_pending waits; slow_down adds 5 s to the interval; then the tokens", async () => {
    const run = await setup({ deviceAnswers: ["authorization_pending", "slow_down", "authorization_pending", "ok"], deviceInterval: 2 });
    const linked = await run.link();
    expect(parseShopCredentials(linked.vaultText)?.accessToken).toBe(run.shop.accessToken);
    expect(run.sleeps).toEqual([2000, 2000, 7000, 7000]);
    expect(run.shop.oauthRequests.map((r) => r.path)).toEqual(["/oauth/device", "/oauth/token", "/oauth/token", "/oauth/token", "/oauth/token"]);
    expectNoSecrets(run.shop);
  });

  it("no refresh token from Shop (a public client): linked, with refreshIssued false", async () => {
    const run = await setup({ noRefreshToken: true });
    const linked = await run.link();
    expect(linked.refreshIssued).toBe(false);
    expect(parseShopCredentials(linked.vaultText)?.refreshToken).toBeNull();
  });

  it.each([
    ["expired_token", "expired", "the sign-in code expired before it was approved"],
    ["access_denied", "denied", "the link was declined in Shop"],
  ] as const)("%s ends the flow: ShopLinkError(%s), no further poll, nothing secret in the error or the log", async (answer, failure, message) => {
    const run = await setup({ deviceAnswers: ["authorization_pending", answer] });
    const error = await run.link().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopLinkError);
    expect(error).toMatchObject({ failure, message });
    expect((error as Error).message).not.toContain(FAKE_BUYER.email);
    expect(run.shop.oauthRequests.filter((r) => r.path === "/oauth/token")).toHaveLength(2);
    expectNoSecrets(run.shop);
  });

  it("stops polling at the code's expiry, without a token request after it", async () => {
    const run = await setup({ deviceAnswers: ["authorization_pending"], deviceExpiresIn: 12, deviceInterval: 5 });
    await expect(run.link()).rejects.toMatchObject({ name: "ShopLinkError", failure: "expired" });
    // Polls at 5 s and 10 s; at 15 s the code has expired, so no third request is sent.
    expect(run.shop.oauthRequests.filter((r) => r.path === "/oauth/token")).toHaveLength(2);
  });

  it("an unknown client (invalid_client): refused at the device authorization, nothing polled, Shop's text not echoed", async () => {
    const run = await setup({ identityEverywhere: true }, { clientId: "not-registered-client" });
    const error = await run.link().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ShopLinkError", failure: "refused" });
    expect((error as Error).message).toContain("invalid_client");
    expect((error as Error).message).not.toContain(FAKE_BUYER.email);
    expect(run.shop.oauthRequests.map((r) => r.path)).toEqual(["/oauth/device"]);
    expect(run.prompts).toEqual([]);
  });

  it("attack: a failed log append means no request of the flow reaches Shop", async () => {
    const fs: StoreFs = {
      ...fsp,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fsp.open(...args);
        if (String(args[0]).endsWith("audit.jsonl") && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0) {
          return Object.assign(handle, { write: () => Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })) });
        }
        return handle;
      }),
    };
    const run = await setup({}, { fs });
    await expect(run.link()).rejects.toThrow("ENOSPC");
    expect(run.shop.oauthRequests).toEqual([]);
    expect(run.prompts).toEqual([]);
  });
});
