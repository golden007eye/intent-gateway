// Pause end to end (ADR-0023): the gateway against the fake Intent Cloud over real HTTP, with the real store and
// disclosure log. A local pause refuses create_cart before anything is sent; the pause reaches Intent Cloud logged
// before it is sent, with a verified receipt; Intent Cloud's `paused` answer is recorded as a refusal and pauses here;
// a resume is confirmed only by the next submit's answer; `intent verify` accepts the chain.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeCloud, startFakeCloud } from "../cloud-fake/index.ts";
import { connectCloud } from "../disclosure/index.ts";
import { type AccountKey, pauseLocally, pausedIn, pauseState, resumeLocally, sendPause } from "../pause/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { createSession, openCompleterKeys } from "../signing/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { runVerify } from "../verify/index.ts";
import { createGateway, type Gateway } from "./index.ts";

vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.parse("2026-10-18T12:00:00Z");
const SHOES = { category: "running-shoes", budget_usd: 200, zip: "94103" };

/** A local account key stub for tests only: `intent init` makes the real one. */
function testKey(): AccountKey & { x: string } {
  const seed = Buffer.alloc(32, 7);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const x = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  const thumbprint = createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
  return { x, thumbprint, sign: (m) => edSign(null, m, privateKey) };
}

interface H {
  fake: FakeCloud;
  store: Store;
  dir: string;
  gateway: Gateway;
  now: () => number;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup(): Promise<H> {
  const now = (): number => T0;
  const fake = await startFakeCloud({ now });
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "pause-gw-")), "data");
  const store = await openStore(dir, { clock: now });
  cleanup.push(() => fake.close(), () => store.close());
  const session = createSession();
  const gateway = createGateway({
    cloud: (keySet) => connectCloud({ baseUrl: fake.url, session, now }, store, { keySet, now }),
    store,
    completerKeys: openCompleterKeys(dir, { now }),
    policy: loadPolicy("version: 1\napproval: passkey\n"),
    pinnedRootKeys: [fake.keys.rootPin],
    now,
    logger: { warn: () => undefined },
  });
  await gateway.start();
  return { fake, store, dir, gateway, now };
}

async function offer(h: H): Promise<string> {
  const found = await h.gateway.findOffers(SHOES);
  if (found.status !== "offers" || found.offers[0] === undefined) throw new Error(found.message);
  return found.offers[0].offer_handle;
}

const ofKind = (h: H, kind: string) => h.store.entries().filter((e) => e.kind === kind).map((e) => e.body as Record<string, unknown>);
const cartSends = (h: H) => ofKind(h, "disclosure").filter((d) => d.endpoint === "createCart").length;
const verify = (h: H) => runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(h.now()), skipSupplyChain: true });

describe("pause at the gateway", () => {
  it("attack: a pause chained while the cart is being made stops the approval request; nothing more is sent", async () => {
    const now = (): number => T0;
    const fake = await startFakeCloud({ now });
    const dir = join(await fsp.mkdtemp(join(tmpdir(), "pause-gw-")), "data");
    const store = await openStore(dir, { clock: now });
    cleanup.push(() => fake.close(), () => store.close());
    const session = createSession();
    const gateway = createGateway({
      cloud: (keySet) => {
        const cloud = connectCloud({ baseUrl: fake.url, session, now }, store, { keySet, now });
        const createCart = cloud.createCart.bind(cloud);
        // `intent pause` in another terminal, while Intent Cloud is answering the cart.
        cloud.createCart = async (request) => {
          const answer = await createCart(request);
          await pauseLocally(store, "cli");
          return answer;
        };
        return cloud;
      },
      store,
      completerKeys: openCompleterKeys(dir, { now }),
      policy: loadPolicy("version: 1\napproval: passkey\n"),
      pinnedRootKeys: [fake.keys.rootPin],
      now,
      logger: { warn: () => undefined },
    });
    await gateway.start();
    const h: H = { fake, store, dir, gateway, now };
    const result = await gateway.createCart({ offer_handle: await offer(h) });
    expect(result.status).toBe("refused");
    expect(ofKind(h, "disclosure").filter((d) => d.endpoint === "createApproval")).toHaveLength(0);
    expect(ofKind(h, "refused")).toEqual([{ step: "create_approval", reason: "paused", source: "gateway" }]);
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("a local pause refuses create_cart before anything is sent, logs `refused: paused`, and verify accepts the chain", async () => {
    const h = await setup();
    const handle = await offer(h);
    await pauseLocally(h.store, "cli");
    const result = await h.gateway.createCart({ offer_handle: handle });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("paused purchases");
    expect(cartSends(h)).toBe(0);
    expect(ofKind(h, "refused")).toEqual([{ step: "create_cart", reason: "paused", source: "gateway" }]);
    const report = await verify(h);
    expect(report.checks.find((c) => c.name === "pause")).toMatchObject({ ok: true });
    expect(report.exitCode).toBe(0);
  });

  it("the pause reaches Intent Cloud logged before the send with a verified receipt, and Intent Cloud then refuses carts", async () => {
    const h = await setup();
    const key = testKey();
    h.fake.accountPause.register(key.thumbprint, key.x);
    await pauseLocally(h.store, "cli");
    const outcome = await sendPause({ store: h.store, accountKey: () => Promise.resolve(key), connect: () => Promise.resolve((r) => h.gateway.sendPause(r)), now: h.now });
    expect(outcome).toEqual({ sent: true, result: "acknowledged", reason: "acknowledged" });
    expect(h.fake.accountPause.paused).toBe(true);
    expect(h.fake.accountPause.lastCounter(key.thumbprint)).toBe(1);
    const kinds = h.store.entries().map((e) => e.kind);
    const disclosed = kinds.lastIndexOf("disclosure");
    expect(kinds.slice(disclosed)).toEqual(["disclosure", "receipt", "pause_sent"]);
    expect(ofKind(h, "disclosure").at(-1)).toMatchObject({ endpoint: "pause", path: "/v1/pause" });
    expect(ofKind(h, "receipt").at(-1)).toMatchObject({ status: 200, verified: true, contract_version: "1.7.0" });

    // The developer resumes locally (after the passkey resume), but Intent Cloud was never resumed: the next submit
    // answers `paused`, which is chained as Intent Cloud's refusal and pauses here again.
    expect(await resumeLocally(h.store, "cli")).toBe(true);
    const refused = await h.gateway.createCart({ offer_handle: await offer(h) });
    expect(refused.status).toBe("refused");
    expect(ofKind(h, "refused").at(-1)).toMatchObject({ step: "create_cart", reason: "paused", source: "intent_cloud" });
    expect(ofKind(h, "resume_check").at(-1)).toMatchObject({ result: "repaused" });
    expect(pausedIn(h.store.entries())).toBe(true);

    // The passkey resume at Intent Cloud, then the local resume: the next submit confirms it.
    h.fake.accountPause.resume();
    await resumeLocally(h.store, "cli");
    const cart = await h.gateway.createCart({ offer_handle: await offer(h) });
    expect(cart.status).toBe("approval_needed");
    expect(ofKind(h, "resume_check").at(-1)).toMatchObject({ result: "confirmed" });
    expect(pauseState(h.store.entries())).toMatchObject({ paused: null, unconfirmedResume: null });
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("an unknown account key (404): the local pause holds and the retry is logged", async () => {
    const h = await setup();
    await pauseLocally(h.store, "panel");
    const outcome = await sendPause({ store: h.store, accountKey: () => Promise.resolve(testKey()), connect: () => Promise.resolve((r) => h.gateway.sendPause(r)), now: h.now });
    expect(outcome).toEqual({ sent: true, result: "retrying", reason: "not_found" });
    expect(pausedIn(h.store.entries())).toBe(true);
    expect((await h.gateway.createCart({ offer_handle: await offer(h) })).status).toBe("refused");
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("attack: a forged chain with a resume before its pause fails verify", async () => {
    const h = await setup();
    await h.store.append("resume", { from: "cli", confirmed: false, pending: "next submit" });
    await pauseLocally(h.store, "cli");
    const report = await verify(h);
    expect(report.exitCode).not.toBe(0);
    expect(report.checks.find((c) => c.name === "pause")?.details).toContain(`seq ${String(h.store.entries().at(-2)?.seq)}: a resume with no pause in effect before it`);
  });
});
