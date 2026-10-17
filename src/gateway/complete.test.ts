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
import { connectCloud, connectShop, type DisclosedCloud } from "../disclosure/index.ts";
import { buildModel } from "../panel/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { createSession, openCompleterKeys } from "../signing/index.ts";
import { type Entry, openStore, type Store } from "../store/index.ts";
import { buildEvidence, packText } from "../evidence/index.ts";
import { runVerify, runVerifyEvidence } from "../verify/index.ts";
import { openCheckoutVault, WalletKey } from "../wallet/index.ts";
import { FAKE_BUYER, FAKE_OTHER_VARIANT, FAKE_STORE, FAKE_STOREFRONT, FAKE_VARIANT, type FakeShop, type FakeShopFaults, startFakeShop } from "../wallet-shop-fake/index.ts";
import { ATTEMPT_WINDOW_MS } from "./complete.ts";
import { type ApprovalStatusResult, type CompletionStep, createGateway, type Gateway } from "./index.ts";
import { spendHistory } from "./history.ts";

vi.setConfig({ testTimeout: 60_000 });

const T0 = Date.parse("2026-10-15T12:00:00Z");
const BASE_POLICY = "version: 1\napproval: passkey\n";
const SEARCH = { category: "stickers", budget_usd: 100, zip: FAKE_BUYER.zip };
const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" as const });
const sticker = (priceMinor = 500): CatalogItem => ({
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
});
const REPORT_ID = /^or_[A-Za-z0-9_-]{22,32}$/;

interface Base {
  fake: FakeCloud;
  shop: FakeShop;
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
  /** The wallet's store for a storefront origin (default: the fake storefront's store). */
  storeFor?: (origin: string) => string | null;
  /** Wraps the store the gateway writes through (a crash or a failing disk). */
  wrap?: (store: Store) => Store;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.reverse()) await run();
  cleanup = [];
});

async function setup(options: { faults?: FakeShopFaults; policy?: string; priceMinor?: number } = {}): Promise<Base> {
  const clock = { at: T0 };
  const now = (): number => clock.at;
  const fake = await startFakeCloud({ now, oneTap: true, catalog: [sticker(options.priceMinor)] });
  const shop = await startFakeShop({ ...(options.faults === undefined ? {} : { faults: options.faults }) });
  cleanup.push(() => fake.close(), () => shop.close());
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "one-tap-")), "data");
  return { fake, shop, dir, clock, now, walletKey: new WalletKey(randomBytes(32), "test"), passkey: new SoftPasskey(), policy: options.policy ?? BASE_POLICY };
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
      storeFor: options.storeFor ?? ((origin) => (origin === FAKE_STOREFRONT ? FAKE_STORE : null)),
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
  expect(cart.cart.completion_mode).toBe("shop_agent");
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

  it("L4: a merchant whose Shop store cannot be named is offered hand-off only, so the cart is handed off", async () => {
    const base = await setup();
    const p = await proc(base, { storeFor: () => null });
    const found = await p.gateway.findOffers(SEARCH);
    if (found.status !== "offers" || found.offers[0] === undefined) throw new Error("no offers");
    const cart = await p.gateway.createCart({ offer_handle: found.offers[0].offer_handle });
    if (cart.status !== "approval_needed") throw new Error(cart.message);
    expect(cart.cart.completion_mode).toBe("handoff");
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
    expect(wallet.length).toBeGreaterThanOrEqual(4); // get_account, create_checkout, get_checkout, complete_checkout
    expect(wallet.every((seq) => packed.some((e) => e.seq === seq))).toBe(true);
    const report = runVerifyEvidence({ text: packText(pack), pinnedRootKeys: [base.fake.keys.rootPin] });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
  });
});
