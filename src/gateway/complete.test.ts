// One-tap completion (plan G7b) end to end: the gateway against the fake Intent Cloud and the fake Shop over real
// HTTP, with the real store, disclosure log, completer keys and encrypted checkout vault. A "process" is a gateway
// with its own store handle, session key, disclosure core and wallet adapter on one data dir; a restart is a new one.
// Invariant 4 (one approval, one purchase) and refinements 1, 3 and 7: never two complete_checkout sends, never one
// without a chained attempt, a possibly-sent purchase is only reconciled, and cap room comes back only on local
// evidence. Invariant 3: the fake answers with the buyer's identity everywhere; none of it reaches the chain.
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CatalogItem, type FakeCloud, SoftPasskey, startFakeCloud } from "../cloud-fake/index.ts";
import { buildActivity } from "../activity/index.ts";
import { connectCloud, connectShop, connectStorefront, type DisclosedCloud, DisclosureBlockedError } from "../disclosure/index.ts";
import { createFakeStorefront, type FakeStorefront } from "../storefront-fake/index.ts";
import { buildModel } from "../panel/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { createSession, openCompleterKeys } from "../signing/index.ts";
import { type Entry, openStore, type Store } from "../store/index.ts";
import { buildEvidence, packText } from "../evidence/index.ts";
import { runVerify, runVerifyEvidence } from "../verify/index.ts";
import { openCheckoutVault, WalletKey } from "../wallet/index.ts";
import { FAKE_BUYER, FAKE_OTHER_VARIANT, FAKE_STORE, FAKE_STOREFRONT, FAKE_VARIANT, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { ATTEMPT_WINDOW_MS, passedRecently } from "./complete.ts";
import { type ApprovalStatusResult, type CompletionStep, createGateway, type Gateway } from "./index.ts";
import { spendHistory } from "./history.ts";
import { pauseLocally, resumeLocally } from "../pause/index.ts";

vi.setConfig({ testTimeout: 60_000 });

const T0 = Date.parse("2026-10-15T12:00:00Z");
const BASE_POLICY = "version: 1\napproval: passkey\n";
const SEARCH = { category: "stickers", budget: 100, country: "US", postcode: FAKE_BUYER.zip };
const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" as const });
const STOREFRONT_HOST = new URL(FAKE_STOREFRONT).host;
const sticker = (priceMinor = 500, myshopify: string | null = FAKE_STORE): CatalogItem => ({
  category: "stickers",
  stock: 10,
  merchant: { name: "Sticker Store", domain: new URL(FAKE_STOREFRONT).host },
  title: "Holographic sticker",
  variant: "Default",
  price: usd(priceMinor),
  shipping: usd(399),
  total_kind: "exact",
  availability: "in_stock",
  variant_ref: FAKE_VARIANT,
  completion: ["shop_agent", "handoff"],
  ...(myshopify === null ? {} : { myshopify_domain: myshopify }),
});
const REPORT_ID = /^or_[A-Za-z0-9_-]{22,32}$/;

interface Base {
  fake: FakeCloud;
  shop: FakeShop;
  /** The merchant storefront the store pair check reaches: stickers.example names FAKE_STORE. */
  storefront: FakeStorefront;
  dir: string;
  clock: { at: number };
  now: () => number;
  walletKey: WalletKey;
  passkey: SoftPasskey;
  policy: string;
}

interface Proc {
  gateway: Gateway;
  store: Store;
  real: DisclosedCloud;
}

interface ProcOptions {
  hook?: (step: CompletionStep) => void | Promise<void>;
  /** The process's policy, in place of the base's. */
  policy?: string;
  /** Wraps the disclosed cloud the gateway calls (the wallet still logs through the real one's core). */
  wrapCloud?: (real: DisclosedCloud) => DisclosedCloud;
  /** Wraps the store the gateway writes through (a crash or a failing disk). */
  wrap?: (store: Store) => Store;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.reverse()) await run();
  cleanup = [];
});

async function setup(options: { faults?: FakeShopFaults; policy?: string; priceMinor?: number; myshopify?: string | null } = {}): Promise<Base> {
  const clock = { at: T0 };
  const now = (): number => clock.at;
  const fake = await startFakeCloud({ now, oneTap: true, catalog: [sticker(options.priceMinor, options.myshopify === undefined ? FAKE_STORE : options.myshopify)] });
  const shop = await startFakeShop({ ...(options.faults === undefined ? {} : { faults: options.faults }) });
  cleanup.push(() => fake.close(), () => shop.close());
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "one-tap-")), "data");
  return { fake, shop, storefront: createFakeStorefront({ [STOREFRONT_HOST]: FAKE_STORE }), dir, clock, now, walletKey: new WalletKey(randomBytes(32), "test"), passkey: new SoftPasskey(), policy: options.policy ?? BASE_POLICY };
}

/** One gateway process on the base's data dir, started. */
async function proc(base: Base, options: ProcOptions = {}): Promise<Proc> {
  const fileStore = await openStore(base.dir, { clock: base.now });
  cleanup.push(() => fileStore.close());
  const store = options.wrap?.(fileStore) ?? fileStore;
  const session = createSession();
  const holder: { real: DisclosedCloud | null } = { real: null };
  const checkoutIds = await openCheckoutVault(base.dir, "shop", base.walletKey, base.now);
  const vaultText = JSON.stringify({ v: 1, client_id: base.shop.clientId, access_token: base.shop.accessToken, refresh_token: base.shop.refreshToken });
  const gateway = createGateway({
    cloud: (keySet) => {
      holder.real = connectCloud({ baseUrl: base.fake.url, session, now: base.now }, store, { keySet, now: base.now });
      return options.wrapCloud?.(holder.real) ?? holder.real;
    },
    store,
    completerKeys: openCompleterKeys(base.dir, { now: base.now }),
    oneTap: {
      connect: (cloud) => connectShop(holder.real ?? cloud, { mcpUrl: base.shop.mcpUrl, authUrl: base.shop.authUrl, vaultText, checkoutIds }),
      storefront: (cloud) => connectStorefront(holder.real ?? cloud, base.storefront.transport),
      ...(options.hook === undefined ? {} : { hook: options.hook }),
    },
    policy: loadPolicy(options.policy ?? base.policy),
    pinnedRootKeys: [base.fake.keys.rootPin],
    now: base.now,
    logger: { warn: () => undefined },
  });
  await gateway.start();
  if (holder.real === null) throw new Error("no cloud");
  return { gateway, store, real: holder.real };
}

/** A hook that throws once at `step`, as a crash right after that entry is chained. */
function crashAt(step: CompletionStep): (s: CompletionStep) => void {
  let done = false;
  return (s) => {
    if (s === step && !done) {
      done = true;
      throw new Error(`crash after ${step}`);
    }
  };
}

/** Search, cart and passkey approval; returns the approval handle (not yet read back). */
async function approvedCart(base: Base, p: Proc): Promise<string> {
  const found = await p.gateway.findOffers(SEARCH);
  if (found.status !== "offers" || found.offers[0] === undefined) throw new Error(`no offers: ${found.message}`);
  const cart = await p.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
  if (cart.status !== "approval_needed") throw new Error(`no approval: ${cart.message}`);
  expect(cart.cart?.completion_mode).toBe("shop_agent");
  expect(base.fake.approveWithPasskey(cart.approval_handle, base.passkey).status).toBe(200);
  return cart.approval_handle;
}

const status = (p: Proc, handle: string): Promise<ApprovalStatusResult> => p.gateway.getApprovalStatus({ approval_handle: handle });

function completionOf(result: ApprovalStatusResult) {
  if (result.status !== "approved") throw new Error(`expected approved, got ${result.status}: ${result.message}`);
  if (result.completion === undefined) throw new Error(`no completion: ${result.message}`);
  return result.completion;
}

// The chain as written, read through a fresh handle each time (any process may have appended).
const chainOf = async (base: Base): Promise<Entry[]> => {
  const s = await openStore(base.dir, { clock: base.now });
  try {
    return s.entries();
  } finally {
    await s.close();
  }
};
const body = (e: Entry): Record<string, unknown> => e.body as Record<string, unknown>;
const ofKind = (chain: Entry[], kind: string): Record<string, unknown>[] => chain.filter((e) => e.kind === kind).map(body);
const completeSends = (chain: Entry[]) => ofKind(chain, "disclosure").filter((d) => d.endpoint === "complete_checkout");
const localOutcomes = (chain: Entry[]) => ofKind(chain, "outcome").filter((o) => o.basis === "local");
const counted = (base: Base, chain: Entry[]): number => spendHistory(chain, base.now()).length;
const reportsAt = (base: Base, handle: string) => base.fake.inspect(handle)?.reports ?? [];
const verify = (base: Base) => runVerify({ dataDir: base.dir, pinnedRootKeys: [base.fake.keys.rootPin], now: new Date(base.now()), skipSupplyChain: true });
/** The panel's chip for the chain's only purchase (plan G5: it reads state_shown and the local outcome). */
const panelState = async (base: Base) => {
  const model = buildModel({ items: await chainOf(base), now: base.now(), mode: "real", intent: "intent", policy: null, verify: null, timeZone: "UTC" });
  const p = model.purchases.at(-1);
  return [p?.state, p?.tone];
};
const keyFiles = async (base: Base): Promise<string[]> => (await fsp.readdir(join(base.dir, "completer")).catch(() => [] as string[])).filter((f) => f.endsWith(".key"));

/**
 * Re-writes the chain into a fresh data dir (new hashes), letting `extra` append after any entry, and runs verify
 * over the copy: a hand-written chain, as an attacker or a bug would leave it.
 */
async function verifyCopy(base: Base, extra: (e: Entry, out: Store) => Promise<unknown> | null) {
  const copy = join(await fsp.mkdtemp(join(tmpdir(), "one-tap-copy-")), "data");
  const out = await openStore(copy, { clock: base.now });
  for (const e of await chainOf(base)) {
    await out.append(e.kind, e.body);
    await extra(e, out);
  }
  await out.close();
  return runVerify({ dataDir: copy, pinnedRootKeys: [base.fake.keys.rootPin], now: new Date(base.now()), skipSupplyChain: true });
}

/** Approves, then makes the first read back chain the approval with get_account failing, so nothing is redeemed. */
async function chainedApproval(base: Base, p: Proc): Promise<string> {
  const handle = await approvedCart(base, p);
  base.shop.faults.toolHttpStatus = { get_account: 500 };
  expect(completionOf(await status(p, handle)).state).toBe("completing");
  delete base.shop.faults.toolHttpStatus;
  expect(ofKind(await chainOf(base), "completion")).toHaveLength(0);
  return handle;
}

// ---- happy path, replay, identity -----------------------------------------------------------------------------------

describe("one-tap happy path", () => {
  it("one approval → ordered from Shop with binding ok; Intent Cloud got completing then ordered; one complete; verify exits 0", async () => {
    const base = await setup({ faults: { identityEverywhere: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const result = await status(p, handle);
    const done = completionOf(result);
    expect(done).toMatchObject({ state: "ordered", source: "shop_api" });
    expect(done.order_ref).toMatch(/^gid:\/\/shopify\/Order\/\d+$/);
    expect(result.message).toContain("read from Shop by the gateway");
    expect(base.shop.completeCount).toBe(1);

    const chain = await chainOf(base);
    const local = localOutcomes(chain);
    expect(local.at(-1)).toMatchObject({ state: "ordered", source: "shop_api", local_binding: { result: "ok" } });
    const completion = ofKind(chain, "completion");
    expect(completion).toHaveLength(1);
    expect(completion[0]?.checkout_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(completion[0]?.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ofKind(chain, "complete_attempt")).toHaveLength(1);
    // Every complete_checkout disclosure carries the local, never-sent purchase field (G4's cap rule reads it).
    const sends = completeSends(chain);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.purchase).toBe(handle);
    expect(Buffer.from(String(sends[0]?.body_b64), "base64").toString("utf8")).not.toContain(handle);

    // Reports (R2, R4): completing first, every later one names it; ids from the CSPRNG pattern; signed by the completer key.
    const reports = reportsAt(base, handle);
    expect(reports.map((r) => r.state)).toEqual(["completing", "ordered"]);
    expect(reports.every((r) => REPORT_ID.test(r.report_id))).toBe(true);
    expect(reports[1]?.completing_report_id).toBe(reports[0]?.report_id);
    expect(reports[0]?.checkout_ref_hash).toBe(completion[0]?.checkout_ref);
    const keyid = ofKind(chain, "approval_pending")[0]?.completer_keyid;
    expect(ofKind(chain, "disclosure").filter((d) => d.endpoint === "reportOutcome").every((d) => d.keyid === keyid)).toBe(true);

    // Invariant 3: the buyer's identity, in every Shop answer, is nowhere in the chain or the log file.
    // (Entries of the completion only: an approval's snapshot names the merchant under `name`, which is not the buyer.)
    const completionKinds = new Set(["completion", "complete_attempt", "outcome", "response"]);
    expect(chain.flatMap((e) => (completionKinds.has(e.kind) ? findIdentity(e.body) : []))).toEqual([]);
    const audit = await fsp.readFile(join(base.dir, "audit.jsonl"), "utf8");
    for (const value of [FAKE_BUYER.email, FAKE_BUYER.phone, FAKE_BUYER.address1, FAKE_BUYER.last_name, "?key=", "gid://shopify/Checkout/"]) expect(audit).not.toContain(value);

    // The terminal report got its 201, so the completer key is gone (retention), and the checkout id with it.
    expect(await keyFiles(base)).toEqual([]);
    expect(await fsp.readdir(join(base.dir, "wallet", "shop-checkouts"))).toEqual([]);
    expect(await panelState(base)).toEqual(["Ordered", "ok"]);
    const report = await verify(base);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it("attack (replay): a call after ordered sends nothing more to Shop", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const shopCalls = base.shop.calls.length;
    const result = await status(p, handle);
    expect(completionOf(result).state).toBe("ordered");
    expect(base.shop.calls.length).toBe(shopCalls);
    expect(base.shop.completeCount).toBe(1);
  });

  it("attack (double charge): the complete answer is dropped → indeterminate, reported, then reconciled to ordered; one complete", async () => {
    const base = await setup({ faults: { dropCompleteAnswer: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const first = completionOf(await status(p, handle));
    expect(first.state).toBe("indeterminate");
    expect(counted(base, await chainOf(base))).toBe(1);
    base.shop.faults.dropCompleteAnswer = false;
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    expect(base.shop.completeCount).toBe(1);
    expect(completeSends(await chainOf(base))).toHaveLength(1);
    expect(reportsAt(base, handle).map((r) => r.state)).toEqual(["completing", "indeterminate", "ordered"]);
  });
});

// ---- restarts ------------------------------------------------------------------------------------------------------

describe.each([true, false])("restart matrix (Shop idempotency %s)", (idempotency) => {
  it.each(["completion", "completing_reported", "complete_answered"] as const)(
    "a restart after %s ends in ordered, one complete, reports delivered with the completer key, verify exits 0",
    async (step) => {
      const base = await setup({ faults: { idempotency } });
      const p1 = await proc(base, { hook: crashAt(step) });
      const handle = await approvedCart(base, p1);
      await expect(status(p1, handle)).rejects.toThrow(`crash after ${step}`);
      await p1.store.close();
      const p2 = await proc(base);
      expect(completionOf(await status(p2, handle))).toMatchObject({ state: "ordered", source: "shop_api" });
      const chain = await chainOf(base);
      expect(base.shop.completeCount).toBe(1);
      expect(completeSends(chain)).toHaveLength(1);
      expect(ofKind(chain, "completion")).toHaveLength(1);
      expect(reportsAt(base, handle).map((r) => r.state)).toEqual(["completing", "ordered"]);
      const keyid = ofKind(chain, "approval_pending")[0]?.completer_keyid;
      expect(ofKind(chain, "disclosure").filter((d) => d.endpoint === "reportOutcome").every((d) => d.keyid === keyid)).toBe(true);
      expect((await verify(base)).exitCode).toBe(0);
    },
  );

  it("a restart after the attempt is chained but before the send: failed (gateway_precheck, not_sent), no Shop read, complete count 0, reservation released", async () => {
    const base = await setup({ faults: { idempotency } });
    const p1 = await proc(base, { hook: crashAt("attempt") });
    const handle = await approvedCart(base, p1);
    await expect(status(p1, handle)).rejects.toThrow("crash after attempt");
    await p1.store.close();
    const shopCalls = base.shop.calls.length;
    const p2 = await proc(base);
    // Within the attempt window a live owner may still send: a wait, never a verdict (M1).
    expect(completionOf(await status(p2, handle)).state).toBe("completing");
    base.clock.at += ATTEMPT_WINDOW_MS;
    expect(completionOf(await status(p2, handle))).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "not_sent" });
    expect(base.shop.calls.length).toBe(shopCalls);
    expect(base.shop.completeCount).toBe(0);
    const chain = await chainOf(base);
    expect(completeSends(chain)).toHaveLength(0);
    expect(counted(base, chain)).toBe(0);
    // After an accepted completing, the refusal is reported (Appendix G precheck step 3).
    expect(reportsAt(base, handle).map((r) => [r.state, r.source])).toEqual([["completing", "shop_api"], ["failed", "gateway_precheck"]]);
    expect((await verify(base)).exitCode).toBe(0);
  });

  it("verify on not_sent uses the shared rule: a send naming this purchase or none refutes it, another purchase's does not", async () => {
    const base = await setup({ faults: { idempotency } });
    const p1 = await proc(base, { hook: crashAt("attempt") });
    const handle = await approvedCart(base, p1);
    await expect(status(p1, handle)).rejects.toThrow();
    await p1.store.close();
    base.clock.at += ATTEMPT_WINDOW_MS;
    expect(completionOf(await status(await proc(base), handle)).reason).toBe("not_sent");
    const refutes = "says nothing was sent, but a complete_checkout disclosure for it (or naming no purchase) is logged after its approval";
    const withSend = async (extra: Record<string, unknown>): Promise<string> => {
      const report = await verifyCopy(base, (e, out) => (e.kind === "approval" ? out.append("disclosure", { endpoint: "complete_checkout", destination: "shop", ...extra }) : null));
      return report.checks.find((c) => c.name === "outcomes")?.details.join("\n") ?? "";
    };
    expect(await withSend({})).toContain(refutes);
    expect(await withSend({ purchase: handle })).toContain(refutes);
    expect(await withSend({ purchase: "ap_another000" })).not.toContain(refutes);
  });

  it("an open checkout after a possible send: indeterminate, reservation held past expires_at, never re-sent on three later calls", async () => {
    const base = await setup({ faults: { idempotency, dropCompleteUnapplied: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const first = await status(p, handle);
    expect(completionOf(first).state).toBe("indeterminate");
    expect(first.message).toContain("Check the order in the Shop app");
    base.clock.at += 3_600_000;
    for (let i = 0; i < 3; i++) expect(completionOf(await status(p, handle)).state).toBe("indeterminate");
    const chain = await chainOf(base);
    expect(base.shop.completeCount).toBe(1);
    expect(completeSends(chain)).toHaveLength(1);
    expect(counted(base, chain)).toBe(1);
    expect(localOutcomes(chain).filter((o) => o.state === "indeterminate")).toHaveLength(1);
    expect(await panelState(base)).toEqual(["Sent to Shop, result unknown: check Shop orders", "warn"]);
  });

  it.each([
    ["not found", { forgetCheckouts: true }],
    ["HTTP 500", { toolHttpStatus: { get_checkout: 500 } }],
  ] as const)("get_checkout %s after a possible send: indeterminate, never failed", async (_name, fault) => {
    const base = await setup({ faults: { idempotency, dropCompleteUnapplied: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("indeterminate");
    Object.assign(base.shop.faults, fault);
    await p.store.close();
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle)).state).toBe("indeterminate");
    expect(localOutcomes(await chainOf(base)).some((o) => o.state === "failed")).toBe(false);
    expect(base.shop.completeCount).toBe(1);
  });
});

describe("races between processes", () => {
  it("attack (parallel processes at step 4): exactly one completion, one complete; the loser is not fenced", async () => {
    const base = await setup();
    const p1 = await proc(base);
    const p2 = await proc(base);
    const handle = await chainedApproval(base, p1);
    const results = await Promise.all([status(p1, handle), status(p2, handle)]);
    expect(results.every((r) => r.status === "approved")).toBe(true);
    expect(completionOf(await status(p2, handle)).state).toBe("ordered");
    const chain = await chainOf(base);
    expect(ofKind(chain, "completion")).toHaveLength(1);
    expect(base.shop.completeCount).toBe(1);
    expect((await p1.gateway.findOffers(SEARCH)).status).toBe("offers");
    expect((await p2.gateway.findOffers(SEARCH)).status).toBe("offers");
  });

  it("race at step 4: a second process polls after the winner's create was answered, before its completion entry → it waits; the winner orders", async () => {
    const base = await setup();
    let other: Proc | null = null;
    let handle = "";
    let seenMidRace: string | null = null;
    // Holds the winner's completion append until the other process has polled once (the CI interleaving, made fixed).
    const gate = (real: Store): Store => ({
      append: (k, b) => real.append(k, b),
      appendUnless: async (k, b, c) => {
        if (k === "completion" && seenMidRace === null && other !== null) seenMidRace = completionOf(await status(other, handle)).state;
        return real.appendUnless(k, b, c);
      },
      entries: () => real.entries(),
      close: () => real.close(),
    });
    const winner = await proc(base, { wrap: gate });
    other = await proc(base);
    handle = await chainedApproval(base, winner);
    expect(completionOf(await status(winner, handle)).state).toBe("ordered");
    expect(seenMidRace).toBe("completing");
    expect(base.shop.createCount).toBe(1);
    expect(base.shop.completeCount).toBe(1);
    expect(localOutcomes(await chainOf(base)).map((o) => o.state)).not.toContain("failed");
  });

  it("race at step 7: B's read, taken while A's send was in flight, reaches the chain after A's ordered → never chained over it; B sees ordered", async () => {
    const base = await setup();
    let release: () => void = () => undefined;
    const aDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    // B's outcome from its in-flight read is held until A has chained its verdict (the CI interleaving, made fixed).
    const late = (real: Store): Store => ({
      append: async (k, b) => {
        if (k === "outcome" && (b as { state?: unknown }).state === "indeterminate") await aDone;
        return real.append(k, b);
      },
      appendUnless: async (k, b, c) => {
        if (k === "outcome" && (b as { state?: unknown }).state === "indeterminate") await aDone;
        return real.appendUnless(k, b, c);
      },
      entries: () => real.entries(),
      close: () => real.close(),
    });
    const a = await proc(base);
    const b = await proc(base, { wrap: late });
    const handle = await chainedApproval(base, a);
    base.shop.faults.completeDelayMs = 800;
    const inFlight = status(a, handle);
    for (let i = 0; i < 400 && completeSends(await chainOf(base)).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(completeSends(await chainOf(base))).toHaveLength(1);
    const seenByB = status(b, handle);
    expect(completionOf(await inFlight).state).toBe("ordered");
    release();
    expect(completionOf(await seenByB).state).toBe("ordered");
    expect(completionOf(await status(b, handle)).state).toBe("ordered");
    expect(localOutcomes(await chainOf(base)).map((o) => o.state)).toEqual(["ordered"]);
    expect(base.shop.completeCount).toBe(1);
  });

  it("attack 4a (race at step 6, Shop idempotency off): B only reads the checkout while A's send is in flight; one attempt, one send", async () => {
    const base = await setup({ faults: { idempotency: false } });
    const a = await proc(base);
    const b = await proc(base);
    const handle = await chainedApproval(base, a);
    base.shop.faults.completeDelayMs = 1500;
    const inFlight = status(a, handle);
    for (let i = 0; i < 400 && completeSends(await chainOf(base)).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(completeSends(await chainOf(base))).toHaveLength(1);
    const reads = base.shop.calls.filter((c) => c.tool === "get_checkout").length;
    const seenByB = completionOf(await status(b, handle));
    expect(seenByB.state).toBe("indeterminate");
    expect(base.shop.calls.filter((c) => c.tool === "get_checkout").length).toBe(reads + 1);
    expect(completionOf(await inFlight).state).toBe("ordered");
    expect(completionOf(await status(b, handle)).state).toBe("ordered");
    const chain = await chainOf(base);
    expect(ofKind(chain, "complete_attempt")).toHaveLength(1);
    expect(completeSends(chain)).toHaveLength(1);
    expect(base.shop.completeCount).toBe(1);
  });

  it("attack 4b (crash after the send, before its answer is chained; idempotency off): the restart only reads, one send, unanswered 1, verify exits 0", async () => {
    const base = await setup({ faults: { idempotency: false } });
    let dead = false;
    let armed = false;
    const killer = (real: Store): Store => ({
      append: (kind, b) => {
        if (dead || (armed && kind === "response")) {
          dead = true;
          return Promise.reject(new Error("killed"));
        }
        const done = real.append(kind, b);
        if (kind === "disclosure" && (b as { endpoint?: unknown }).endpoint === "complete_checkout") armed = true;
        return done;
      },
      appendUnless: (kind, b, conflict) => {
        if (dead) return Promise.reject(new Error("killed"));
        const done = real.appendUnless(kind, b, conflict);
        if (kind === "disclosure" && (b as { endpoint?: unknown }).endpoint === "complete_checkout") armed = true;
        return done;
      },
      entries: () => real.entries(),
      close: () => real.close(),
    });
    const p1 = await proc(base, { wrap: killer });
    const handle = await approvedCart(base, p1);
    await expect(status(p1, handle)).rejects.toThrow();
    expect(base.shop.completeCount).toBe(1);
    await p1.store.close();
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle)).state).toBe("ordered");
    const chain = await chainOf(base);
    const sends = chain.filter((e) => e.kind === "disclosure" && body(e).endpoint === "complete_checkout");
    expect(sends).toHaveLength(1);
    expect(chain.some((e) => ["response", "unacknowledged"].includes(e.kind) && body(e).disclosure_seq === sends[0]?.seq)).toBe(false);
    expect(base.shop.completeCount).toBe(1);
    const report = await verify(base);
    expect(report.exitCode).toBe(0);
    expect(report.counts.unanswered).toBe(1);
  });

  it("attack 4c (stale resume): an attempt another owner chained is never completed here", async () => {
    const base = await setup();
    const p1 = await proc(base, { hook: crashAt("completing_reported") });
    const handle = await approvedCart(base, p1);
    await expect(status(p1, handle)).rejects.toThrow();
    const completion = ofKind(await chainOf(base), "completion")[0];
    await p1.store.append("complete_attempt", { handle, owner: "an-owner-from-another-process", idempotency_key: completion?.idempotency_key });
    await p1.store.close();
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle)).state).toBe("completing");
    base.clock.at += ATTEMPT_WINDOW_MS;
    const seen = completionOf(await status(p2, handle));
    expect(completeSends(await chainOf(base))).toHaveLength(0);
    expect(base.shop.completeCount).toBe(0);
    expect(seen).toMatchObject({ state: "failed", reason: "not_sent" });
  });

  it("attack (6b compare-and-append): an outcome chained by another process between the attempt and the send stops the send", async () => {
    const base = await setup();
    let other: Store | null = null;
    const p = await proc(base, {
      hook: async (s) => {
        if (s !== "attempt" || other === null) return;
        const handle = String(other.entries().find((e) => e.kind === "completion")?.body && body(other.entries().find((e) => e.kind === "completion") as Entry).handle);
        // Another process's reconcile saw the attempt without a disclosure and chained its verdict first.
        await other.append("outcome", { handle, basis: "local", state: "failed", source: "gateway_precheck", reason: "not_sent", state_shown: "failed" });
      },
    });
    const opened = await openStore(base.dir, { clock: base.now });
    other = opened;
    cleanup.push(() => opened.close());
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", reason: "not_sent" });
    expect(completeSends(await chainOf(base))).toHaveLength(0);
    expect(base.shop.completeCount).toBe(0);
    expect((await verify(base)).exitCode).toBe(0);
  });

  it("4d: an approval already chained before a restart is advanced through the chained path", async () => {
    const base = await setup();
    const p1 = await proc(base);
    const handle = await chainedApproval(base, p1);
    await p1.store.close();
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle)).state).toBe("ordered");
    expect(base.shop.completeCount).toBe(1);
  });
});

// ---- refusals and Shop outcomes ------------------------------------------------------------------------------------

describe("refusals before any complete_checkout", () => {
  it("attack (redeem refused): Intent Cloud answers 409 to completing → failed, local only, no complete, cap room freed", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    base.fake.tamper.reportStatus(409);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "redeem_refused" });
    base.fake.tamper.reportStatus(null);
    const chain = await chainOf(base);
    expect(completeSends(chain)).toHaveLength(0);
    expect(base.shop.completeCount).toBe(0);
    expect(reportsAt(base, handle)).toEqual([]);
    expect(counted(base, chain)).toBe(0);
    expect(await panelState(base)).toEqual(["Not completed", "plain"]);
  });

  it("no accepted completing (Intent Cloud 500): nothing completed; at expiry a local failure, never reported", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    base.fake.tamper.reportStatus(500);
    expect(completionOf(await status(p, handle)).state).toBe("completing");
    base.clock.at += 16 * 60_000;
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", reason: "expired" });
    expect(base.shop.completeCount).toBe(0);
    expect(reportsAt(base, handle)).toEqual([]);
  });

  it.each([
    ["total above A (quote)", { totalAboveMinor: 1 }, "precheck:total"],
    ["another variant (quote)", { otherVariant: true }, "precheck:line"],
  ] as const)("attack (%s): failed before redemption, no completion entry, nothing reported", async (_name, faults, reason) => {
    const base = await setup({ faults });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", source: "gateway_precheck", reason });
    const chain = await chainOf(base);
    expect(ofKind(chain, "completion")).toHaveLength(0);
    expect(completeSends(chain)).toHaveLength(0);
    expect(reportsAt(base, handle)).toEqual([]);
    expect(counted(base, chain)).toBe(0);
    // Nothing is left to read or report: the completer key (L5) and the quote's checkout id (L6) are gone.
    expect(await keyFiles(base)).toEqual([]);
    expect(await fsp.readdir(join(base.dir, "wallet", "shop-checkouts")).catch(() => [])).toEqual([]);
    expect((await verify(base)).exitCode).toBe(0);
  });

  it.each([
    ["the total rose above A", { totalAboveMinor: 1 }, "precheck:total"],
    ["the variant changed", { viewVariant: FAKE_OTHER_VARIANT }, "precheck:line"],
    ["the storefront differs", { merchantUrl: "https://evil.example" }, "precheck:merchant_origin"],
    ["the ZIP differs", { shipToZip: "10001" }, "precheck:ship_to"],
  ] as const)("the completer precheck on the fresh read refuses when %s: failed reported, no complete sent", async (_name, faults, reason) => {
    const base = await setup();
    const p1 = await proc(base, { hook: crashAt("completing_reported") });
    const handle = await approvedCart(base, p1);
    await expect(status(p1, handle)).rejects.toThrow();
    Object.assign(base.shop.faults, faults);
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle))).toMatchObject({ state: "failed", source: "gateway_precheck", reason });
    const chain = await chainOf(base);
    expect(completeSends(chain)).toHaveLength(0);
    expect(base.shop.completeCount).toBe(0);
    expect(reportsAt(base, handle).map((r) => [r.state, r.source])).toEqual([["completing", "shop_api"], ["failed", "gateway_precheck"]]);
    expect(counted(base, chain)).toBe(0);
  });

  it("the snapshot expired before step 6: failed (gateway_precheck, expired), reported, no complete", async () => {
    const base = await setup();
    const p1 = await proc(base, { hook: crashAt("completing_reported") });
    const handle = await approvedCart(base, p1);
    await expect(status(p1, handle)).rejects.toThrow();
    base.clock.at += 16 * 60_000;
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle))).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "expired" });
    expect(base.shop.completeCount).toBe(0);
    expect(reportsAt(base, handle).at(-1)).toMatchObject({ state: "failed", source: "gateway_precheck" });
  });

  it("budget $50, policy $100, A $60 → failed (budget), no Shop checkout, spend history frees the $60", async () => {
    const base = await setup({ policy: `${BASE_POLICY}spend:\n  per_order_usd: 100\n`, priceMinor: 5601 });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", reason: "budget" });
    expect(base.shop.calls.some((c) => c.tool === "create_checkout")).toBe(false);
    expect(counted(base, await chainOf(base))).toBe(0);
  });

  it("ineligible merchant → failed (shop_api) with a hand-off suggestion", async () => {
    const base = await setup({ faults: { ineligible: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const result = await status(p, handle);
    expect(completionOf(result)).toMatchObject({ state: "failed", source: "shop_api", reason: "ineligible" });
    expect(result.message).toContain("hand the purchase off");
  });

  it("attack (append failure): the store refuses the completion entry → no report, no complete", async () => {
    const base = await setup();
    const failing = (real: Store): Store => ({
      append: (k, b) => real.append(k, b),
      appendUnless: (k, b, c) => (k === "completion" ? Promise.reject(new Error("disk full")) : real.appendUnless(k, b, c)),
      entries: () => real.entries(),
      close: () => real.close(),
    });
    const p = await proc(base, { wrap: failing });
    const handle = await approvedCart(base, p);
    await expect(status(p, handle)).rejects.toThrow("disk full");
    expect(reportsAt(base, handle)).toEqual([]);
    expect(base.shop.completeCount).toBe(0);
  });

  it("buyer review: completing until expires_at, then indeterminate", async () => {
    const base = await setup({ faults: { buyerReview: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("completing");
    expect(await panelState(base)).toEqual(["Completing with Shop", "warn"]);
    base.clock.at += 16 * 60_000;
    expect(completionOf(await status(p, handle)).state).toBe("indeterminate");
    expect(base.shop.completeCount).toBe(1);
  });
});

describe("Shop as the S1 spike saw it (2026-10-18)", () => {
  it("no budget shown for the connection, or not in USD → failed (budget_unknown) before any checkout; never assumed", async () => {
    for (const faults of [{ budgetMinor: null }, { accountCurrency: "CAD" }] as FakeShopFaults[]) {
      const base = await setup({ faults });
      const p = await proc(base);
      const handle = await approvedCart(base, p);
      const result = await status(p, handle);
      expect(completionOf(result)).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "budget_unknown" });
      expect(result.message).toContain('turn on "Allow agent to pay" with a budget in the Shop app');
      expect(base.shop.createCount).toBe(0);
      expect(counted(base, await chainOf(base))).toBe(0);
    }
  });

  it("the connection removed in the Shop app (warnings, token still answers) → failed (wallet_disconnected), no checkout", async () => {
    const base = await setup({ faults: { connectionRemoved: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const result = await status(p, handle);
    expect(completionOf(result)).toMatchObject({ state: "failed", reason: "wallet_disconnected" });
    // A relink that works today: Shop does not accept the gateway's own client yet, so the command names Shop's public one.
    expect(result.message).toContain("the developer runs `intent wallet unlink shop`, then `INTENT_SHOP_CLIENT_ID=5c733ab2-1903-400a-891e-7ba20c09e2a3 intent wallet link shop`, in a terminal.");
    expect(base.shop.createCount).toBe(0);
  });

  it("attack (card fallback): a checkout that offers only the Shop Pay card → failed (no_budget_instrument), never paid with the card", async () => {
    const base = await setup({ faults: { noBudgetInstrument: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const result = await status(p, handle);
    expect(completionOf(result)).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "no_budget_instrument" });
    expect(result.message).toContain("never pays with the card");
    expect(base.shop.completeCount).toBe(0);
    expect(base.shop.paidWith).toEqual([]);
    // Nothing was redeemed: no completion entry, no report, the cap room is free.
    const chain = await chainOf(base);
    expect(ofKind(chain, "completion")).toHaveLength(0);
    expect(reportsAt(base, handle)).toEqual([]);
    expect(counted(base, chain)).toBe(0);
  });

  it("the happy path pays with the delegated budget; the merchant check binds the store the checkout lives at (Shop names no merchant)", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "ordered" });
    expect(base.shop.paidWith).toEqual(["delegated_budget"]);
    const ordered = localOutcomes(await chainOf(base)).at(-1);
    // Shop reports the store, not the storefront: binding-v1 matches it only as the myshopify domain the passkey signed (D7).
    expect(ordered?.binding_inputs).toMatchObject({ observed: { merchant_origin: `https://${FAKE_STORE}` } });
    expect(ordered?.local_binding).toMatchObject({ result: "ok", checks: { merchant_origin: "match" } });
  });

  it("attack (store swap): the completed order's permalink is on another myshopify store → mismatch, never ordered", async () => {
    const base = await setup({ faults: { permalinkHost: "other-store.myshopify.com" } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "mismatch" });
    expect(localOutcomes(await chainOf(base)).at(-1)?.local_binding).toMatchObject({ checks: { merchant_origin: "differs" } });
  });

  it("attack (idempotency, S1 --replay): create_checkout's answer is lost → failed (create_unconfirmed); later calls never create again", async () => {
    const base = await setup({ faults: { dropCreateAnswer: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", reason: "create_unconfirmed" });
    delete base.shop.faults.dropCreateAnswer;
    for (let i = 0; i < 3; i++) await status(p, handle);
    // A fresh process (a restart) does not create again either.
    const p2 = await proc(base);
    await status(p2, handle);
    expect(base.shop.createCount).toBe(1);
    expect(base.shop.completeCount).toBe(0);
    // No complete_checkout could follow, so the reservation is freed on local evidence.
    expect(counted(base, await chainOf(base))).toBe(0);
  });

  it("attack (crash after create_checkout left): the restarted gateway waits out the window, then fails it (create_unconfirmed), never creating again", async () => {
    const base = await setup({ faults: { dropCreateAnswer: true } });
    // The process dies right after the create_checkout disclosure is on disk: no follow-up, no outcome.
    let dead = false;
    const killer = (real: Store): Store => ({
      append: (kind, b) => {
        if (dead) return Promise.reject(new Error("killed"));
        const done = real.append(kind, b);
        if (kind === "disclosure" && (b as { endpoint?: unknown }).endpoint === "create_checkout") dead = true;
        return done;
      },
      appendUnless: (kind, b, conflict) => {
        if (dead) return Promise.reject(new Error("killed"));
        const done = real.appendUnless(kind, b, conflict);
        if (kind === "disclosure" && (b as { endpoint?: unknown }).endpoint === "create_checkout") dead = true;
        return done;
      },
      entries: () => real.entries(),
      close: () => real.close(),
    });
    const p1 = await proc(base, { wrap: killer });
    const handle = await approvedCart(base, p1);
    await status(p1, handle).catch(() => undefined);
    await p1.store.close();
    expect(base.shop.createCount).toBe(1);
    delete base.shop.faults.dropCreateAnswer;
    const p2 = await proc(base);
    // Within the attempt window the first process may still be waiting for Shop's answer: a wait, no send.
    expect(completionOf(await status(p2, handle)).state).toBe("completing");
    base.clock.at += ATTEMPT_WINDOW_MS;
    expect(completionOf(await status(p2, handle))).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "create_unconfirmed" });
    expect(base.shop.createCount).toBe(1);
    expect(base.shop.completeCount).toBe(0);
    expect(counted(base, await chainOf(base))).toBe(0);
  });

  it("a create_checkout Shop refused for the token (401) made no checkout: the next call creates", async () => {
    const base = await setup({ faults: { toolHttpStatus: { create_checkout: 401 } } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("completing");
    expect(base.shop.createCount).toBe(0);
    delete base.shop.faults.toolHttpStatus;
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle)).state).toBe("ordered");
    expect(base.shop.createCount).toBe(1);
    expect(base.shop.completeCount).toBe(1);
  });

  it("attack (store swap, merchant reported): the order is on another store while Shop reports the approved origin → mismatch", async () => {
    const base = await setup({ faults: { merchantUrl: FAKE_STOREFRONT, permalinkHost: "other-store.myshopify.com" } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "mismatch" });
    expect(localOutcomes(await chainOf(base)).at(-1)?.local_binding).toMatchObject({ checks: { merchant_origin: "differs" } });
  });

  it("a store agents cannot complete at (S1 step 11: requires_escalation, checkout_completion_ineligible) → failed (ineligible), no complete", async () => {
    const base = await setup({ faults: { ineligible: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", source: "shop_api", reason: "ineligible" });
    expect(base.shop.createCount).toBe(1);
    expect(base.shop.completeCount).toBe(0);
  });

  it("complete_checkout answered with a tool error (checkout_completion_ineligible) → indeterminate under Shop's code, never ordered, never re-sent", async () => {
    const base = await setup({ faults: { completeIneligible: true } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const result = await status(p, handle);
    expect(completionOf(result)).toMatchObject({ state: "indeterminate", reason: "checkout_completion_ineligible" });
    expect(result.message).toContain("Shop answered with the error checkout_completion_ineligible");
    for (let i = 0; i < 2; i++) expect(completionOf(await status(p, handle)).state).not.toBe("ordered");
    expect(base.shop.completeCount).toBe(1);
    // A send happened: the reservation is held.
    expect(counted(base, await chainOf(base))).toBe(1);
  });

  it("an expired access token mid-purchase: refreshed through the log, and the purchase is ordered with one complete", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    base.shop.expireAccessTokens();
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    expect(base.shop.oauthRequests.filter((r) => r.form.grant_type === "refresh_token")).toHaveLength(1);
    expect(base.shop.completeCount).toBe(1);
    const verdict = await verify(base);
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
  });
});

describe("terminal report retry across a restart (G3 acceptance test 14)", () => {
  it("the ordered report fails with 500, the restarted gateway resends it byte for byte, gets 201, and then deletes the key", async () => {
    const base = await setup();
    const p1 = await proc(base, {
      hook: (s) => {
        if (s === "complete_answered") base.fake.tamper.reportStatus(500);
      },
    });
    const handle = await approvedCart(base, p1);
    expect(completionOf(await status(p1, handle)).state).toBe("ordered");
    expect(reportsAt(base, handle).map((r) => r.state)).toEqual(["completing"]);
    expect(await keyFiles(base)).toHaveLength(1);
    await p1.store.close();
    base.fake.tamper.reportStatus(null);
    const p2 = await proc(base);
    expect(completionOf(await status(p2, handle)).state).toBe("ordered");
    expect(reportsAt(base, handle).map((r) => r.state)).toEqual(["completing", "ordered"]);
    const sent = ofKind(await chainOf(base), "disclosure").filter((d) => d.endpoint === "reportOutcome");
    const ordered = sent.filter((d) => (JSON.parse(Buffer.from(String(d.body_b64), "base64").toString("utf8")) as { state: string }).state === "ordered");
    expect(ordered).toHaveLength(2);
    expect(ordered[1]?.body_b64).toBe(ordered[0]?.body_b64);
    expect(await keyFiles(base)).toEqual([]);
  });
});

describe("security review fixes", () => {
  it("M1: while A is between 6a and 6b, B's call is a wait, not not_sent; A then sends once → ordered", async () => {
    const base = await setup();
    let b: Proc | null = null;
    let seenByB: ApprovalStatusResult | null = null;
    let handle = "";
    const a = await proc(base, {
      hook: async (s) => {
        if (s === "attempt" && b !== null) seenByB = await status(b, handle);
      },
    });
    b = await proc(base);
    handle = await approvedCart(base, a);
    expect(completionOf(await status(a, handle)).state).toBe("ordered");
    expect(completionOf(seenByB as unknown as ApprovalStatusResult).state).toBe("completing");
    expect(localOutcomes(await chainOf(base)).some((o) => o.reason === "not_sent")).toBe(false);
    expect(base.shop.completeCount).toBe(1);
  });

  it("M1: the owner refuses to send once the attempt window has passed", async () => {
    const base = await setup();
    const a = await proc(base, {
      hook: (s) => {
        if (s === "attempt") base.clock.at += ATTEMPT_WINDOW_MS;
      },
    });
    const handle = await approvedCart(base, a);
    expect(completionOf(await status(a, handle))).toMatchObject({ state: "failed", reason: "not_sent" });
    expect(base.shop.completeCount).toBe(0);
    expect(completeSends(await chainOf(base))).toHaveLength(0);
  });

  it("M2: H1 crashed after 6a, then H2 sent: H1 is still provably unsent (not stranded indeterminate)", async () => {
    const base = await setup();
    const p1 = await proc(base, { hook: crashAt("attempt") });
    const h1 = await approvedCart(base, p1);
    await expect(status(p1, h1)).rejects.toThrow();
    await p1.store.close();
    const p2 = await proc(base);
    const h2 = await approvedCart(base, p2);
    expect(completionOf(await status(p2, h2)).state).toBe("ordered");
    base.clock.at += ATTEMPT_WINDOW_MS;
    expect(completionOf(await status(p2, h1))).toMatchObject({ state: "failed", reason: "not_sent" });
    expect(base.shop.completeCount).toBe(1);
    expect(counted(base, await chainOf(base))).toBe(1);
    expect((await verify(base)).exitCode).toBe(0);
  });

  it("M2: an earlier precheck refusal is not re-counted after a later, unrelated send", async () => {
    const base = await setup({ faults: { totalAboveMinor: 1 } });
    const p = await proc(base);
    const h1 = await approvedCart(base, p);
    expect(completionOf(await status(p, h1)).reason).toBe("precheck:total");
    delete base.shop.faults.totalAboveMinor;
    const h2 = await approvedCart(base, p);
    expect(completionOf(await status(p, h2)).state).toBe("ordered");
    const chain = await chainOf(base);
    expect(counted(base, chain)).toBe(1);
    expect((await verify(base)).exitCode).toBe(0);
  });

  it("M2: a complete_checkout send without its purchase or its send condition is refused before anything is logged", async () => {
    const base = await setup();
    const p = await proc(base);
    const shop = connectShop(p.real, { mcpUrl: base.shop.mcpUrl, authUrl: base.shop.authUrl, vaultText: "{}" });
    const before = (await chainOf(base)).length;
    await expect(
      shop.completeCheckout({ storeDomain: FAKE_STORE, checkoutRef: `sha256:${"0".repeat(64)}` }, "ap_TEST0001", "6f1c4a1e-0000-4000-8000-000000000000", {
        sendUnless: undefined as unknown as () => boolean,
      }),
    ).rejects.toThrow();
    expect((await chainOf(base)).length).toBe(before);
  });

  it("M3 attack: a hand-written chain with two complete_checkout sends for one purchase → verify exits 1", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const twice = await verifyCopy(base, (e, out) => (e.kind === "disclosure" && body(e).endpoint === "complete_checkout" ? out.append("disclosure", e.body) : null));
    expect(twice.exitCode).toBe(1);
    expect(twice.checks.find((c) => c.name === "outcomes")?.details.join("\n")).toContain(`a second complete_checkout disclosure for ${handle}`);
    const unnamed = await verifyCopy(base, (e, out) =>
      e.kind === "complete_attempt" ? out.append("disclosure", { endpoint: "complete_checkout", destination: "shop" }) : null,
    );
    expect(unnamed.exitCode).toBe(1);
    expect(unnamed.checks.find((c) => c.name === "outcomes")?.details.join("\n")).toContain("names no purchase");
  });

  it("M4: two concurrent carts in two processes cannot both fit under the daily cap", async () => {
    const base = await setup({ policy: `${BASE_POLICY}spend:\n  per_day_usd: 15\n` });
    // Both approval requests are answered before either cart goes on, so both pass every check made before the
    // reserving entry: only the compare-and-append of approval_pending can stop the second.
    let arrived = 0;
    let both = (): void => undefined;
    const met = new Promise<void>((resolve) => {
      both = resolve;
    });
    const barrier = (real: DisclosedCloud): DisclosedCloud => ({
      ...real,
      createApproval: async (h) => {
        const answer = await real.createApproval(h);
        if (++arrived === 2) both();
        await met;
        return answer;
      },
    });
    const p1 = await proc(base, { wrapCloud: barrier });
    const p2 = await proc(base, { wrapCloud: barrier });
    const offer = async (p: Proc): Promise<string> => {
      const found = await p.gateway.findOffers(SEARCH);
      if (found.status !== "offers" || found.offers[0] === undefined) throw new Error("no offers");
      return found.offers[0].offer_handle;
    };
    const [o1, o2] = [await offer(p1), await offer(p2)];
    const results = await Promise.all([p1.gateway.createCart({ offer_handle: o1 }), p2.gateway.createCart({ offer_handle: o2 })]);
    expect(results.map((r) => r.status).sort()).toEqual(["approval_needed", "refused"]);
    expect(ofKind(await chainOf(base), "approval_pending")).toHaveLength(1);
  });

  it("M4: step 4 re-checks the caps with the redemption: over the cap now, failed (cap) and nothing redeemed", async () => {
    const base = await setup();
    const p1 = await proc(base);
    const handle = await chainedApproval(base, p1);
    await p1.store.close();
    const tight = await proc(base, { policy: `${BASE_POLICY}spend:\n  per_day_usd: 5\n` });
    expect(completionOf(await status(tight, handle))).toMatchObject({ state: "failed", reason: "cap" });
    expect(ofKind(await chainOf(base), "completion")).toHaveLength(0);
    expect(base.shop.completeCount).toBe(0);
  });

  it("L2: a 429 to completing leaves it open (retried), never a refusal", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    base.fake.tamper.reportStatus(429);
    expect(completionOf(await status(p, handle)).state).toBe("completing");
    base.fake.tamper.reportStatus(null);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    expect(base.shop.completeCount).toBe(1);
  });

  it("L4: a merchant Intent Cloud names no myshopify domain for is offered hand-off only, so the cart is handed off", async () => {
    const base = await setup({ myshopify: null });
    const p = await proc(base);
    const found = await p.gateway.findOffers(SEARCH);
    if (found.status !== "offers" || found.offers[0] === undefined) throw new Error("no offers");
    const cart = await p.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    if (cart.status !== "approval_needed") throw new Error(cart.message);
    expect(cart.cart?.completion_mode).toBe("handoff");
    const logged = ofKind(await chainOf(base), "disclosure").find((d) => d.endpoint === "createCart");
    expect((JSON.parse(Buffer.from(String(logged?.body_b64), "base64").toString("utf8")) as { completion_accepts: unknown }).completion_accepts).toEqual(["handoff"]);
  });

  it("L6: a quote lost in the step-4 race forgets its checkout id", async () => {
    const base = await setup();
    const p1 = await proc(base);
    const p2 = await proc(base);
    const handle = await chainedApproval(base, p1);
    await Promise.all([status(p1, handle), status(p2, handle)]);
    expect(completionOf(await status(p2, handle)).state).toBe("ordered");
    // The winner's id is released at the terminal outcome, the loser's at once: none is left.
    expect(await fsp.readdir(join(base.dir, "wallet", "shop-checkouts")).catch(() => [])).toEqual([]);
  });
});

describe("evidence pack of a one-tap purchase (G9)", () => {
  it("holds the completion, the attempt and every wallet request marked with the purchase, and verify --evidence passes", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const chain = await chainOf(base);
    const pack = buildEvidence(chain, handle, [base.fake.keys.rootPin]);
    const packed = pack.entries as readonly Entry[];
    const kinds = packed.map((e) => e.kind);
    expect(kinds).toContain("completion");
    expect(kinds).toContain("complete_attempt");
    const wallet = chain.filter((e) => e.kind === "disclosure" && body(e).purchase === handle).map((e) => e.seq);
    // create_checkout, get_checkout, complete_checkout (the budget's get_account names no purchase).
    expect(wallet.length).toBeGreaterThanOrEqual(3);
    expect(wallet.every((seq) => packed.some((e) => e.seq === seq))).toBe(true);
    const report = runVerifyEvidence({ text: packText(pack), pinnedRootKeys: [base.fake.keys.rootPin] });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
  });
});


describe("a checkout id that reads as a card by chance (the flaky M2 run's root cause)", () => {
  it("a Shop checkout token that is a Luhn-valid digit run is not refused as a card: the purchase is ordered", async () => {
    const base = await setup({ faults: { checkoutToken: "4111111111111111", checkoutKey: "5500000000000004" } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const chain = await chainOf(base);
    expect(ofKind(chain, "block")).toEqual([]);
    expect(base.shop.completeCount).toBe(1);
    // The id is still digested in the log: neither digit run is in the chain in clear.
    const audit = await fsp.readFile(join(base.dir, "audit.jsonl"), "utf8");
    expect(audit).not.toContain("4111111111111111");
    expect(audit).not.toContain("5500000000000004");
  });
});

describe("a Shopify order number that passes Luhn (ADR-0019: the order gid exemption)", () => {
  // Fixed, never random: 14 digits that pass Luhn (asserted below), so the card check alone reads the gid as a card.
  const ORDER_NUMBER = "12345678901237";
  const GID = `gid://shopify/Order/${ORDER_NUMBER}`;
  const reportBodies = (chain: Entry[]) =>
    ofKind(chain, "disclosure")
      .filter((d) => d.endpoint === "reportOutcome")
      .map((d) => JSON.parse(Buffer.from(String(d.body_b64), "base64").toString("utf8")) as Record<string, unknown>);

  it("flows end to end: projected, ordered, reported and logged, and both verify and verify --evidence pass", async () => {
    expect(findIdentity({ order_ref: GID }).map((f) => f.kind)).toEqual(["card"]);
    const base = await setup({ faults: { orderNumber: ORDER_NUMBER } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const done = completionOf(await status(p, handle));
    expect(done.state).toBe("ordered");
    expect(done.order_ref).toBe(GID);
    // A later read takes Intent Cloud's outcome: its statement is kept (not refused as identity), its observation whole.
    await status(p, handle);
    const chain = await chainOf(base);
    expect(ofKind(chain, "block")).toEqual([]);
    expect(localOutcomes(chain).at(-1)).toMatchObject({ state: "ordered", order_ref: GID });
    // The ordered report was logged with the gid before it left, and Intent Cloud received it.
    expect(reportBodies(chain).find((r) => r.state === "ordered")?.order_ref).toBe(GID);
    expect(JSON.stringify(reportsAt(base, handle))).toContain(GID);
    const cloudOutcomes = ofKind(chain, "outcome").filter((o) => o.basis === "cloud");
    expect(cloudOutcomes.length).toBeGreaterThan(0);
    expect(cloudOutcomes.filter((o) => o.refused_by === "identity")).toEqual([]);
    expect(cloudOutcomes.every((o) => o.statement_verified === true && typeof o.statement_jcs === "string" && o.statement_jcs.includes(GID))).toBe(true);
    expect(ofKind(chain, "observed").filter((o) => o.withheld !== undefined)).toEqual([]);
    expect(buildActivity(chain).summary.identity.findings).toEqual([]);
    const verified = await verify(base);
    expect(verified.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verified.exitCode).toBe(0);
    const pack = buildEvidence(chain, handle, [base.fake.keys.rootPin]);
    const evidence = runVerifyEvidence({ text: packText(pack), pinnedRootKeys: [base.fake.keys.rootPin] });
    expect(evidence.checks.filter((c) => !c.ok)).toEqual([]);
    expect(evidence.exitCode).toBe(0);
  });

  it("attack: verify --evidence still flags a card in the gid shape at another field, and the bare digits at order_ref", async () => {
    const base = await setup({ faults: { orderNumber: ORDER_NUMBER } });
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    // A hand-written chain (new hashes): the ordered report's logged body edited, as an attacker or a bug would.
    const edited = async (edit: (report: Record<string, unknown>) => Record<string, unknown>) => {
      const copy = join(await fsp.mkdtemp(join(tmpdir(), "one-tap-gid-")), "data");
      const out = await openStore(copy, { clock: base.now });
      for (const e of await chainOf(base)) {
        const b = body(e);
        if (e.kind === "disclosure" && b.endpoint === "reportOutcome") {
          const report = JSON.parse(Buffer.from(String(b.body_b64), "base64").toString("utf8")) as Record<string, unknown>;
          if (report.state === "ordered") {
            await out.append(e.kind, { ...b, body_b64: Buffer.from(JSON.stringify(edit(report)), "utf8").toString("base64") });
            continue;
          }
        }
        await out.append(e.kind, e.body);
      }
      const chain = out.entries();
      await out.close();
      const pack = buildEvidence(chain, handle, [base.fake.keys.rootPin]);
      return runVerifyEvidence({ text: packText(pack), pinnedRootKeys: [base.fake.keys.rootPin] }).checks.find((c) => c.name === "purchase")?.details.join("\n") ?? "";
    };
    expect(await edited((r) => r)).not.toMatch(/buyer identity/);
    expect(await edited((r) => ({ ...r, note: "gid://shopify/Order/4111111111111111" }))).toMatch(/buyer identity \(card at \$\.note\)/);
    expect(await edited((r) => ({ ...r, order_ref: ORDER_NUMBER }))).toMatch(/buyer identity \(card at \$\.order_ref\)/);
    expect(await edited((r) => ({ ...r, order_ref: `gid://shopify/Order/4111111111111111 x` }))).toMatch(/buyer identity \(card at \$\.order_ref\)/);
    expect(await edited((r) => ({ ...r, a: "4111", b: "1111", c: "1111", d: "1111" }))).toMatch(/buyer identity \(card at \$\)/);
  });

  it("attack: a card number at the report's order_ref without the gid prefix is blocked before it leaves", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const report = (order_ref: string) => ({
      report_id: `or_${randomBytes(16).toString("hex")}`,
      completing_report_id: `or_${"b".repeat(22)}`,
      state: "failed",
      source: "gateway_precheck",
      order_ref,
      observed_at: new Date(base.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    const sentBefore = reportsAt(base, handle).length;
    for (const ref of ["4111111111111111", ORDER_NUMBER]) {
      await expect(p.real.reportOutcome(handle, report(ref) as never)).rejects.toThrow(DisclosureBlockedError);
    }
    const blocks = ofKind(await chainOf(base), "block").filter((b) => b.endpoint === "reportOutcome");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => (b.blocked as string[]).includes("card at $.order_ref"))).toBe(true);
    expect(reportBodies(await chainOf(base)).filter((r) => r.completing_report_id === `or_${"b".repeat(22)}`)).toEqual([]);
    expect(reportsAt(base, handle)).toHaveLength(sentBefore);
  });
});

// ---- contract 1.6.1: the signed store pair and the store pair check (ADR-0020) --------------------------------------

describe("contract 1.6.1: the store pair check before the completing report", () => {
  const STORE_TTL_MS = 24 * 3_600_000;
  const pairEntries = (chain: Entry[]) => ofKind(chain, "store_pair");

  /** A purchase whose store pair check fails: refused locally, before any Shop checkout, with nothing reported. */
  async function refusedLocally(base: Base, reason: string): Promise<string> {
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    const done = completionOf(await status(p, handle));
    expect(done).toMatchObject({ state: "failed", source: "gateway_precheck", reason: `store_pair:${reason}` });
    // Local only (Appendix G): no Shop checkout was made, nothing was paid, and Intent Cloud got no report, so the
    // approval stays approved there and the buyer can still hand off.
    expect([base.shop.createCount, base.shop.completeCount]).toEqual([0, 0]);
    expect(reportsAt(base, handle)).toEqual([]);
    expect(base.fake.inspect(handle)?.state).toBe("approved");
    const chain = await chainOf(base);
    expect(ofKind(chain, "completion")).toEqual([]);
    expect(ofKind(chain, "disclosure").filter((d) => d.endpoint === "create_checkout")).toEqual([]);
    return handle;
  }

  it("the happy path: one logged GET of the storefront's /meta.json, URL and fixed headers only, answered as status, digest and size", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const chain = await chainOf(base);
    const gets = chain.filter((e) => e.kind === "disclosure" && body(e).destination === "storefront");
    expect(gets).toHaveLength(1);
    const get = gets[0] as Entry;
    expect(body(get)).toMatchObject({ endpoint: "meta_json", method: "GET", path: `${FAKE_STOREFRONT}/meta.json`, body_b64: "", purchase: handle });
    // No cookie, credential, Authorization or buyer data: exactly the fixed header set.
    expect((body(get).headers as string[][]).map(([name]) => name)).toEqual(["host", "accept", "user-agent", "connection"]);
    expect(body(get).redacted).toBeUndefined();
    // Invariant 2: logged before the GET left, and the answer kept as status, sha256 and size only.
    const answer = chain.find((e) => e.kind === "response" && body(e).disclosure_seq === get.seq) as Entry;
    expect(Object.keys(body(answer)).sort()).toEqual(["body_sha256", "bytes", "disclosure_seq", "status"]);
    expect(body(answer).status).toBe(200);
    expect(base.storefront.requests).toHaveLength(1);
    // The check ran before any Shop checkout was made, and before the completing report.
    const pass = chain.find((e) => e.kind === "store_pair" && body(e).disclosure_seq === get.seq) as Entry;
    expect(body(pass)).toMatchObject({ handle, merchant_origin: FAKE_STOREFRONT, myshopify_domain: FAKE_STORE, result: "pass" });
    const createSeq = chain.find((e) => e.kind === "disclosure" && body(e).endpoint === "create_checkout")?.seq ?? -1;
    expect(pass.seq).toBeLessThan(createSeq);
    expect((await verify(base)).exitCode).toBe(0);
  });

  it("attack (IC-paired evil store): Intent Cloud pairs the storefront with another store and the passkey signs it; meta.json disagrees → no checkout, no send", async () => {
    const base = await setup({ myshopify: "evil-store.myshopify.com" });
    await refusedLocally(base, "differs");
    expect(pairEntries(await chainOf(base))).toMatchObject([{ myshopify_domain: "evil-store.myshopify.com", result: "fail", reason: "differs" }]);
    expect((await verify(base)).exitCode).toBe(0);
  });

  it.each([
    ["a redirect (never followed)", { status: 301 }, "redirect"],
    ["an oversize body", { body: `{"myshopify_domain":"${FAKE_STORE}"}${" ".repeat(70_000)}` }, "too_large"],
    ["a wrong content type", { contentType: "text/html; charset=utf-8" }, "content_type"],
    ["two content types", { contentType: ["application/json", "text/html"] }, "content_type"],
    ["duplicate member names", { body: `{"myshopify_domain":"other-store.myshopify.com","myshopify_domain":"${FAKE_STORE}"}` }, "not_json"],
    ["a non-ASCII value (U+0131)", { body: `{"myshopify_domain":"st\\u0131cker-store.myshopify.com"}` }, "non_ascii"],
    ["a body that is not an object", { body: `["${FAKE_STORE}"]` }, "not_object"],
  ] as const)("attack: %s → failed (gateway_precheck), local only", async (_what, answer, reason) => {
    const base = await setup();
    base.storefront.answer(new URL(FAKE_STOREFRONT).host, answer);
    await refusedLocally(base, reason);
  });

  it("attack: a storefront name that resolves to a private address is never contacted (logged, not sent) → fetch_failed", async () => {
    const base = await setup();
    base.storefront.answer(new URL(FAKE_STOREFRONT).host, "refused");
    await refusedLocally(base, "fetch_failed");
    expect(base.storefront.requests).toEqual([]);
    const chain = await chainOf(base);
    const get = chain.find((e) => e.kind === "disclosure" && body(e).destination === "storefront") as Entry;
    expect(String(ofKind(chain, "unacknowledged").find((u) => u.disclosure_seq === get.seq)?.reason)).toContain("not sent");
  });

  it("attack (log before send): the storefront GET's disclosure cannot be appended → no GET leaves, and nothing is paid", async () => {
    const base = await setup();
    const failing = (real: Store): Store => ({
      append: (k, b) => (k === "disclosure" && (b as { destination?: unknown }).destination === "storefront" ? Promise.reject(new Error("disk full")) : real.append(k, b)),
      appendUnless: (k, b, c) => real.appendUnless(k, b, c),
      entries: () => real.entries(),
      close: () => real.close(),
    });
    const p = await proc(base, { wrap: failing });
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle))).toMatchObject({ state: "failed", reason: "store_pair:fetch_failed" });
    expect(base.storefront.requests).toEqual([]);
    expect([base.shop.createCount, base.shop.completeCount]).toEqual([0, 0]);
  });

  it("attack (cache poisoning by a failure): a failure is never reused; a pass is, from another process, for 24 h at most", async () => {
    const base = await setup();
    const host = new URL(FAKE_STOREFRONT).host;
    base.storefront.answer(host, { body: `{"myshopify_domain":"other-store.myshopify.com"}` });
    await refusedLocally(base, "differs");
    // The storefront now answers right: the next purchase fetches again (the failure was not kept) and passes.
    base.storefront.answer(host, null);
    const p2 = await proc(base);
    const second = await approvedCart(base, p2);
    expect(completionOf(await status(p2, second))).toMatchObject({ state: "ordered" });
    expect(base.storefront.requests).toHaveLength(2);
    // A third purchase in another process within 24 h reuses that pass (named by cached_from), with no new GET, even
    // though the storefront would now fail.
    base.storefront.answer(host, { status: 404 });
    base.clock.at += 60_000;
    const p3 = await proc(base);
    const third = await approvedCart(base, p3);
    expect(completionOf(await status(p3, third)).state).toBe("ordered");
    expect(base.storefront.requests).toHaveLength(2);
    const fetched = (await chainOf(base)).filter((e) => e.kind === "store_pair" && body(e).result === "pass" && typeof body(e).disclosure_seq === "number");
    expect(pairEntries(await chainOf(base)).filter((e) => e.handle === third).every((e) => e.cached_from === fetched.at(-1)?.seq)).toBe(true);
    expect((await verify(base)).exitCode).toBe(0);
    const pack = buildEvidence(await chainOf(base), third, [base.fake.keys.rootPin]);
    expect(runVerifyEvidence({ text: packText(pack), pinnedRootKeys: [base.fake.keys.rootPin] }).exitCode).toBe(0);
    // 24 h after that GET the pass is spent: the next check fetches again, and fails on the 404.
    base.clock.at += STORE_TTL_MS - passAge(await chainOf(base), base.now());
    const p4 = await proc(base);
    const fourth = await approvedCart(base, p4);
    expect(completionOf(await status(p4, fourth))).toMatchObject({ state: "failed", reason: "store_pair:status" });
    expect(base.storefront.requests).toHaveLength(3);
  });

  it("the safety net: the pair no longer passes at complete_checkout (no pass kept, meta.json now disagrees) → nothing sent, failed reported", async () => {
    const base = await setup();
    const hide = { on: false };
    // The kept pass is hidden from the completion step (as when it outlived its 24 h between the two checks).
    const hiding = (real: Store): Store => ({
      append: (k, b) => real.append(k, b),
      appendUnless: (k, b, c) => real.appendUnless(k, b, c),
      entries: () => (hide.on ? real.entries().filter((e) => e.kind !== "store_pair") : real.entries()),
      close: () => real.close(),
    });
    const p = await proc(base, {
      wrap: hiding,
      hook: (step) => {
        if (step === "attempt") {
          hide.on = true;
          base.storefront.answer(new URL(FAKE_STOREFRONT).host, { body: `{"myshopify_domain":"other-store.myshopify.com"}` });
        }
      },
    });
    const handle = await approvedCart(base, p);
    const done = completionOf(await status(p, handle));
    expect(done).toMatchObject({ state: "failed", source: "gateway_precheck", reason: "store_pair:differs" });
    expect(base.shop.completeCount).toBe(0);
    expect(completeSends(await chainOf(base))).toEqual([]);
    expect(reportsAt(base, handle).map((r) => [r.state, r.source])).toEqual([
      ["completing", "shop_api"],
      ["failed", "gateway_precheck"],
    ]);
  });

  it("attack (verify): a completion with no passing store pair check before it fails verify", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const copy = join(await fsp.mkdtemp(join(tmpdir(), "one-tap-nopair-")), "data");
    const out = await openStore(copy, { clock: base.now });
    for (const e of await chainOf(base)) if (e.kind !== "store_pair") await out.append(e.kind, e.body);
    await out.close();
    const report = await runVerify({ dataDir: copy, pinnedRootKeys: [base.fake.keys.rootPin], now: new Date(base.now()), skipSupplyChain: true });
    expect(report.exitCode).toBe(1);
    expect(report.checks.flatMap((c) => c.details).join("\n")).toContain("comes before any passing store pair check");
  });

  it("attack (verify): a pass that names no storefront GET, or a reuse of a failure, fails verify", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const forged = await verifyCopy(base, (e, out) =>
      e.kind === "approval" ? out.append("store_pair", { handle, merchant_origin: FAKE_STOREFRONT, myshopify_domain: FAKE_STORE, result: "pass", disclosure_seq: 0 }) : null,
    );
    expect(forged.checks.flatMap((c) => c.details).join("\n")).toContain("passes without naming the storefront GET");
  });

  it("attack (verify): a reuse of a failure, of another pair's pass, of a later entry or of a pass 24 h old fails verify", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    const chain = await chainOf(base);
    const pass = chain.find((e) => e.kind === "store_pair" && body(e).result === "pass") as Entry;
    const reuse = { handle, merchant_origin: FAKE_STOREFRONT, myshopify_domain: FAKE_STORE, result: "pass" };
    /** verify's words for a copy of the chain with `forge` appended after the fetched pass, `lateMs` later. */
    const forgedAfterPass = async (forge: (out: Store) => Promise<unknown>, lateMs = 0): Promise<string> => {
      const copy = join(await fsp.mkdtemp(join(tmpdir(), "one-tap-reuse-")), "data");
      const clock = { late: 0 };
      const out = await openStore(copy, { clock: () => base.now() + clock.late });
      for (const e of chain) {
        await out.append(e.kind, e.body);
        if (e.seq === pass.seq) {
          clock.late = lateMs;
          await forge(out);
          clock.late = 0;
        }
      }
      await out.close();
      const report = await runVerify({ dataDir: copy, pinnedRootKeys: [base.fake.keys.rootPin], now: new Date(base.now() + lateMs), skipSupplyChain: true });
      return report.checks.flatMap((c) => c.details).join("\n");
    };
    const failure = (out: Store) => out.append("store_pair", { ...reuse, result: "fail", reason: "differs" });
    // The forged entries land right after the pass, so its seq + 1 is the failure and + 2 the reuse.
    expect(await forgedAfterPass(async (out) => {
      await failure(out);
      await out.append("store_pair", { ...reuse, cached_from: pass.seq + 1 });
    })).toContain("reuses something other than an earlier fetched pass");
    expect(await forgedAfterPass((out) => out.append("store_pair", { ...reuse, myshopify_domain: "other-store.myshopify.com", cached_from: pass.seq }))).toContain(
      "reuses something other than an earlier fetched pass",
    );
    expect(await forgedAfterPass((out) => out.append("store_pair", { ...reuse, cached_from: pass.seq + 1 }))).toContain("reuses something other than an earlier fetched pass");
    expect(await forgedAfterPass((out) => out.append("store_pair", { ...reuse, cached_from: pass.seq }), STORE_TTL_MS)).toContain("reuses a pass 24 h old or more");
    expect(await forgedAfterPass((out) => out.append("store_pair", { ...reuse, cached_from: pass.seq }), STORE_TTL_MS - 60_000)).not.toContain("store_pair entry");
  });
});

describe("contract 1.6.1: which kept pass the store pair check may reuse (passedRecently)", () => {
  const O = FAKE_STOREFRONT;
  const D = FAKE_STORE;
  const NOW = Date.parse("2026-10-18T12:00:00Z");
  const H = 3_600_000;
  const pass = (seq: number, ts: number, extra: Record<string, unknown> = {}) =>
    ({ seq, kind: "store_pair", ts: new Date(ts).toISOString(), body: { handle: "ap_x", merchant_origin: O, myshopify_domain: D, result: "pass", disclosure_seq: 1, ...extra } }) as unknown as Entry;

  it("a fetched pass for the same pair under 24 h old, and nothing else", () => {
    expect(passedRecently([pass(5, NOW - H)], O, D, NOW)).toBe(5);
    expect(passedRecently([pass(5, NOW - 24 * H)], O, D, NOW)).toBeNull();
    expect(passedRecently([pass(5, NOW - H, { merchant_origin: "https://other.example" })], O, D, NOW)).toBeNull();
    expect(passedRecently([pass(5, NOW - H, { myshopify_domain: "other-store.myshopify.com" })], O, D, NOW)).toBeNull();
    expect(passedRecently([pass(5, NOW - H, { result: "fail", reason: "differs" })], O, D, NOW)).toBeNull();
    expect(passedRecently([pass(5, NOW - H, { disclosure_seq: undefined, cached_from: 2 })], O, D, NOW)).toBeNull();
    expect(passedRecently([{ ...pass(5, NOW - H), kind: "outcome" }], O, D, NOW)).toBeNull();
  });

  it("attack (clock skew): a pass chained after the current time is not trusted, and does not hide an older good one", () => {
    expect(passedRecently([pass(5, NOW + 1_000)], O, D, NOW)).toBeNull();
    expect(passedRecently([pass(5, NOW - H), pass(6, NOW + H)], O, D, NOW)).toBe(5);
  });
});

describe("contract 1.6.1: offer = cart = snapshot for the myshopify domain (Appendix E step 7)", () => {
  async function refusedCart(base: Base, words: string) {
    const p = await proc(base);
    const found = await p.gateway.findOffers(SEARCH);
    if (found.status !== "offers" || found.offers[0] === undefined) throw new Error("no offers");
    const cart = await p.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    expect(cart.status).toBe("refused");
    expect(cart.message).toContain(words);
    expect(ofKind(await chainOf(base), "approval_pending")).toEqual([]);
  }

  it("attack: the cart names another store's myshopify domain than the offer → refused, no approval requested", async () => {
    const base = await setup();
    base.fake.tamper.cart({ myshopify_domain: "other-store.myshopify.com" });
    await refusedCart(base, "myshopify_domain differs from the offer");
    expect(ofKind(await chainOf(base), "disclosure").filter((d) => d.endpoint === "createApproval")).toEqual([]);
  });

  it("attack: a Shopify store's cart without myshopify_domain → refused, no approval requested", async () => {
    const base = await setup();
    base.fake.tamper.cart({ myshopify_domain: undefined });
    await refusedCart(base, "myshopify_domain is missing");
  });

  it("attack: the snapshot signs another store than the offer and the cart → refused at step 7, nothing pending", async () => {
    const base = await setup();
    base.fake.tamper.snapshot({ myshopify_domain: "other-store.myshopify.com" });
    await refusedCart(base, "myshopify_domain is not the offer's and the cart's");
  });

  it("attack: a v2 snapshot from the 1.6.1 host → refused by the 1.6.1 schema, nothing pending (step 7 refuses it too: gateway.test)", async () => {
    const base = await setup();
    base.fake.tamper.snapshot({ v: 2, myshopify_domain: undefined } as never);
    const p = await proc(base);
    const found = await p.gateway.findOffers(SEARCH);
    if (found.status !== "offers" || found.offers[0] === undefined) throw new Error("no offers");
    const cart = await p.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    expect(cart.status).not.toBe("approval_needed");
    expect(ofKind(await chainOf(base), "approval_pending")).toEqual([]);
  });
});

/** How long ago the latest fetched store pair pass was chained. */
function passAge(chain: Entry[], nowMs: number): number {
  const pass = chain.findLast((e) => e.kind === "store_pair" && body(e).result === "pass" && typeof body(e).disclosure_seq === "number");
  return pass === undefined ? Number.POSITIVE_INFINITY : nowMs - Date.parse(pass.ts);
}

describe("pause (ADR-0023)", () => {
  it("a pause refuses the completion before any Shop call or complete_checkout; after the resume the purchase is ordered once", async () => {
    const base = await setup();
    const p = await proc(base);
    const handle = await approvedCart(base, p);
    await pauseLocally(p.store, "panel");
    const stopped = await status(p, handle);
    expect(completionOf(stopped)).toEqual({ state: "completing", reason: "paused" });
    expect(stopped.message).toContain("Purchases are paused");
    let chain = await chainOf(base);
    expect(completeSends(chain)).toHaveLength(0);
    expect(ofKind(chain, "disclosure").filter((d) => d.destination === "shop")).toHaveLength(0);
    expect(ofKind(chain, "refused")).toEqual([{ step: "complete_checkout", reason: "paused", source: "gateway", purchase: handle }]);
    expect(base.shop.completeCount).toBe(0);

    await resumeLocally(p.store, "cli");
    expect(completionOf(await status(p, handle)).state).toBe("ordered");
    chain = await chainOf(base);
    expect(completeSends(chain)).toHaveLength(1);
    expect(base.shop.completeCount).toBe(1);
    expect((await verify(base)).exitCode).toBe(0);
  });
});
