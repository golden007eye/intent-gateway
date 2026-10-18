// The gateway use cases against the fake Intent Cloud over real HTTP, with the real store, disclosure log and trust
// checks. Invariant 3: identity anywhere in a tool input → 0 sends. Invariant 4: "approved" only after the proof
// verified, was chained, and came from the pinned passkey. Invariant 1: the policy's blocks and caps (the weekly one
// computed from the chain) hold before anything is sent.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeCloud, type FakeCloudOptions, SoftPasskey, startFakeCloud } from "../cloud-fake/index.ts";
import type { ApprovalCreated, ApprovalStatus } from "../contract/index.ts";
import { INTENT } from "../config/index.ts";
import { CloudNetworkError, connectCloud, type DisclosedCloud, DisclosureRefusedError, DisclosureStoppedError } from "../disclosure/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { type CompleterKeys, createSession, openCompleterKeys } from "../signing/index.ts";
import { type Entry, openStore, type Store, verifyChain } from "../store/index.ts";
import { type PinnedRootKey, verifyApprovalProof, verifyStatement } from "../trust/index.ts";
import { runVerify } from "../verify/index.ts";
import {
  type ApprovalStatusResult,
  contractSums,
  createGateway,
  type CreateCartResult,
  type FindOffersResult,
  type Gateway,
  GatewayNotStartedError,
  GatewayStartError,
} from "./index.ts";
import { spendHistory } from "./history.ts";
import { signOutcomeStatement } from "../../test/support/trust-kit.ts";

vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.parse("2026-10-15T12:00:00Z");
const DAY_MS = 86_400_000;
const BASE_POLICY = "version: 1\napproval: passkey\n";
const SHOES = { category: "running-shoes", budget_usd: 200, zip: "94103" };
const OPS = ["search", "createCart", "createApproval", "getApproval"] as const;

interface Harness {
  gateway: Gateway;
  fake: FakeCloud;
  store: Store;
  dir: string;
  now: () => number;
  warnings: string[];
  /** Calls that reached the disclosed cloud, per operation, after start(). */
  sends: Record<(typeof OPS)[number], number>;
  /** Replaces one disclosed-cloud operation; the replacement may call the real one. */
  patch: Partial<DisclosedCloud>;
  real: DisclosedCloud;
  /** The completer keys in the data dir. */
  completerKeys: CompleterKeys;
  /** The keyid each approval read or report was signed with, in order. */
  signers: { op: "getApproval" | "reportOutcome"; keyid: string | null }[];
  advance(ms: number): void;
  kinds(): string[];
  totalSends(): number;
  /** A new gateway on the same data dir and fake, with a new session key, as after a process restart; started. */
  restart(): Promise<Harness>;
}

let open: { fake: FakeCloud; store: Store }[] = [];

afterEach(async () => {
  for (const { fake, store } of open) {
    await store.close();
    await fake.close();
  }
  open = [];
});

interface SetupOptions {
  policy?: string;
  pin?: PinnedRootKey[];
  start?: boolean;
  fake?: FakeCloudOptions;
  completerKeys?: CompleterKeys;
  walletModes?: () => readonly ("handoff" | "shop_agent")[];
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const clock = { at: T0 };
  const now = (): number => clock.at;
  const fake = await startFakeCloud({ now, ...options.fake });
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "gateway-")), "data");
  const store = await openStore(dir, { clock: now });
  open.push({ fake, store });
  return build({ fake, store, dir, clock, now }, options);
}

async function build(
  base: { fake: FakeCloud; store: Store; dir: string; clock: { at: number }; now: () => number },
  options: SetupOptions,
): Promise<Harness> {
  const { fake, store, dir, clock, now } = base;
  const session = createSession();
  const warnings: string[] = [];
  const sends = { search: 0, createCart: 0, createApproval: 0, getApproval: 0 };
  const signers: Harness["signers"] = [];
  const patch: Partial<DisclosedCloud> = {};
  const holder: { real: DisclosedCloud | null } = { real: null };
  const completerKeys = options.completerKeys ?? openCompleterKeys(dir, { now });
  const gateway = createGateway({
    cloud: (keySet) => {
      const real = connectCloud({ baseUrl: fake.url, session, now }, store, { keySet, now });
      holder.real = real;
      return {
        meta: () => (patch.meta ?? real.meta)(),
        signatureKeys: () => real.signatureKeys(),
        keyStatement: () => (patch.keyStatement ?? real.keyStatement)(),
        search: (r) => (sends.search++, (patch.search ?? real.search)(r)),
        createCart: (r) => (sends.createCart++, (patch.createCart ?? real.createCart)(r)),
        createApproval: (h) => (sends.createApproval++, (patch.createApproval ?? real.createApproval)(h)),
        getApproval: (h, s) => (
          sends.getApproval++, signers.push({ op: "getApproval", keyid: s?.keyid ?? null }), (patch.getApproval ?? real.getApproval)(h, s)
        ),
        reportOutcome: (h, r, s) => (signers.push({ op: "reportOutcome", keyid: s?.keyid ?? null }), (patch.reportOutcome ?? real.reportOutcome)(h, r, s)),
      };
    },
    store,
    completerKeys,
    ...(options.walletModes === undefined ? {} : { walletModes: options.walletModes }),
    policy: loadPolicy(options.policy ?? BASE_POLICY),
    pinnedRootKeys: options.pin ?? [fake.keys.rootPin],
    now,
    logger: { warn: (m) => warnings.push(m) },
  });
  if (options.start !== false) await gateway.start();
  if (holder.real === null) throw new Error("cloud not built");
  return {
    gateway,
    fake,
    store,
    dir,
    now,
    warnings,
    sends,
    patch,
    real: holder.real,
    completerKeys,
    signers,
    advance: (ms) => {
      clock.at += ms;
    },
    kinds: () => store.entries().map((e) => e.kind),
    totalSends: () => OPS.reduce((n, op) => n + sends[op], 0),
    restart: () => build(base, { ...options, start: true }),
  };
}

function offersOf(result: FindOffersResult) {
  if (result.status !== "offers") throw new Error(`expected offers, got ${result.status}: ${result.message}`);
  return result;
}

function approvalOf(result: CreateCartResult) {
  if (result.status !== "approval_needed") throw new Error(`expected approval_needed, got ${result.status}: ${result.message}`);
  return result;
}

async function offerHandle(h: Harness, title: string, search: object = SHOES): Promise<string> {
  const found = offersOf(await h.gateway.findOffers(search)).offers.find((o) => o.title === title);
  if (found === undefined) throw new Error(`no offer ${title}`);
  return found.offer_handle;
}

/** Search, cart and approval request for one offer; returns the approval handle. */
async function pendingPurchase(h: Harness, title: string, search: object = SHOES): Promise<string> {
  const handle = await offerHandle(h, title, search);
  return approvalOf(await h.gateway.createCart({ offer_handle: handle })).approval_handle;
}

async function approvedPurchase(h: Harness, title: string, passkey: SoftPasskey): Promise<ApprovalStatusResult> {
  const approval = await pendingPurchase(h, title);
  expect(h.fake.approveWithPasskey(approval, passkey).status).toBe(200);
  return h.gateway.getApprovalStatus({ approval_handle: approval });
}

/** `value` without `keys`. */
function omit<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !(keys as readonly PropertyKey[]).includes(k))) as Omit<T, K>;
}

const bodies = (h: Harness, kind: string): Record<string, unknown>[] =>
  h.store
    .entries()
    .filter((e: Entry) => e.kind === kind)
    .map((e) => e.body as Record<string, unknown>);

// ---- start --------------------------------------------------------------------------------------------------------

describe("start", () => {
  it("verifies the key statement against the pin and chains it in a keys entry", async () => {
    const h = await setup();
    const keys = bodies(h, "keys");
    expect(keys).toHaveLength(1);
    expect(keys[0]?.statement).toEqual(h.fake.statement);
    expect(h.kinds().slice(0, 5)).toEqual(["session", "disclosure", "receipt", "disclosure", "receipt"]);
    expect(verifyChain(h.store.entries()).ok).toBe(true);
  });

  it("the built-in contract sums are the ones SOURCE.md records", () => {
    const source = readFileSync(new URL("../../contract/SOURCE.md", import.meta.url), "utf8");
    expect(source).toContain(`\`${contractSums()}\``);
  });

  it("a contract_sums_sha256 mismatch fails start clearly, and no tool runs", async () => {
    const h = await setup({ start: false });
    h.patch.meta = async () => {
      const r = await h.real.meta();
      return r.ok ? { ...r, body: { ...r.body, contract_sums_sha256: "0".repeat(64) } } : r;
    };
    const failure = h.gateway.start();
    await expect(failure).rejects.toThrow(GatewayStartError);
    await expect(failure).rejects.toThrow(/contract mismatch: this gateway implements contract 1\.6\.0.*contract_sums_sha256 is 0{64}/);
    expect(bodies(h, "keys")).toHaveLength(0);
    await expect(h.gateway.findOffers(SHOES)).rejects.toThrow(GatewayNotStartedError);
    expect(h.totalSends()).toBe(0);
  });

  it("an Intent-Contract-Version mismatch fails start clearly", async () => {
    const h = await setup({ start: false });
    h.patch.meta = async () => ({ ...(await h.real.meta()), contractVersion: "1.5.0" });
    await expect(h.gateway.start()).rejects.toThrow(/Intent-Contract-Version is 1\.5\.0/);
  });

  it("a Meta.contract_version mismatch fails start clearly", async () => {
    const h = await setup({ start: false });
    h.patch.meta = async () => {
      const r = await h.real.meta();
      return r.ok ? { ...r, body: { ...r.body, contract_version: "2.0.0" } } : r;
    };
    await expect(h.gateway.start()).rejects.toThrow(/Meta\.contract_version is 2\.0\.0/);
  });

  it("a statement signed by a key other than the pinned root fails start, and no keys entry is chained", async () => {
    const other = await startFakeCloud();
    try {
      const h = await setup({ start: false, pin: [{ kid: other.keys.rootKid, jwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) } }] });
      await expect(h.gateway.start()).rejects.toThrow(/did not verify against the pinned root key \(Appendix F step 2/);
      expect(bodies(h, "keys")).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("a non-root-signed statement served by Cloud fails start", async () => {
    const h = await setup({ start: false });
    h.fake.tamper.statementNonRoot();
    await expect(h.gateway.start()).rejects.toThrow(/step 2: bad_signature/);
  });
});

// ---- readiness ----------------------------------------------------------------------------------------------------

describe("findOffers when Intent Cloud cannot be reached", () => {
  it("a refused connection: logged before the send, reported as not sent, and not listed as sent (invariant 5)", async () => {
    const h = await setup();
    await h.fake.close(); // the port now refuses connections
    const result = await h.gateway.findOffers(SHOES);
    const host = new URL(h.fake.url).host;
    expect(result).toEqual({
      status: "error",
      message: `Not sent: Intent Cloud at ${host} cannot be reached (connection refused), so the request never left this machine. Try again later.`,
      summary: "Sent: nothing / Blocked: nothing",
    });
    expect(h.kinds().slice(-2)).toEqual(["disclosure", "unacknowledged"]);
  });

  it("no answer in time: never reported as not sent, since the request may have reached it", async () => {
    const h = await setup();
    const timeout = "Intent Cloud at cloud.example cannot be reached (no complete response within 30 s)";
    h.patch.search = () => Promise.reject(new CloudNetworkError("timeout", {} as never, timeout));
    const result = await h.gateway.findOffers(SHOES);
    expect(result).toMatchObject({ status: "error", message: `${timeout}; the request may have reached it, and is logged as sent but not acknowledged.` });
    expect(result.message).not.toMatch(/not sent|never left/i);
  });

  it("a logging-rule refusal: a clean 'not sent' to the agent, naming the rule and never a value", async () => {
    const h = await setup();
    const reason = "a credential at headers.authorization: requests to Intent Cloud are logged byte for byte and never carry one";
    h.patch.search = () => Promise.reject(new DisclosureRefusedError("searchCatalog", [reason]));
    const result = await h.gateway.findOffers(SHOES);
    expect(result).toMatchObject({ status: "blocked", message: `Not sent: ${reason}.` });
  });

  it("a stopped disclosure log: refused plainly to the agent, and said once on the terminal", async () => {
    const h = await setup();
    const reason = "the gateway sends nothing more: the answer to disclosure #7 could not be logged: EMFILE";
    // The first call's disclosure was logged, then its answer could not be: the summary never lists it as sent.
    let first = true;
    h.patch.search = async () => {
      if (first) await h.store.append("disclosure", { endpoint: "searchCatalog", fields: ["ship_to", "ship_to.postal_code"] });
      first = false;
      throw new DisclosureStoppedError(reason);
    };
    const summaries: string[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await h.gateway.findOffers(SHOES);
      expect(result).toMatchObject({ status: "error", message: `Not sent: ${reason}. The developer must restart the gateway.` });
      summaries.push(result.summary);
    }
    expect(summaries).toEqual([
      "Sent: nothing / Logged, maybe sent; no answer recorded: searchCatalog (ship_to.postal_code) / Blocked: nothing",
      "Sent: nothing / Blocked: nothing",
    ]);
    expect(h.warnings.filter((w) => w.includes(reason))).toEqual([
      `intent-gateway: ${reason}. Restart the gateway, then run ${INTENT} verify.`,
    ]);
  });
});

describe("findOffers readiness", () => {
  it("lists every missing detail and calls nothing", async () => {
    const h = await setup();
    const result = await h.gateway.findOffers({});
    expect(result.status).toBe("needs_details");
    if (result.status !== "needs_details") return;
    expect(result.missing.map((m) => m.field)).toEqual(["product_or_category", "budget_usd", "zip"]);
    expect(result.summary).toBe("Sent: nothing / Blocked: nothing");
    expect(h.totalSends()).toBe(0);
  });

  it("asks only for what is missing: a ZIP and a budget are never guessed", async () => {
    const h = await setup();
    const noZip = await h.gateway.findOffers({ category: "running-shoes", budget_usd: 100 });
    expect(noZip.status === "needs_details" && noZip.missing.map((m) => m.field)).toEqual(["zip"]);
    const noBudget = await h.gateway.findOffers({ product: "Trail Runner 3", zip: "94103" });
    expect(noBudget.status === "needs_details" && noBudget.missing.map((m) => m.field)).toEqual(["budget_usd"]);
    const badZip = await h.gateway.findOffers({ category: "running-shoes", budget_usd: 100, zip: "SW1A 1AA" });
    expect(badZip.status === "needs_details" && badZip.missing.map((m) => m.field)).toEqual(["zip"]);
    const blanks = await h.gateway.findOffers({ category: " ", budget_usd: 0, zip: "9410" });
    expect(blanks.status === "needs_details" && blanks.missing.map((m) => m.field)).toEqual(["product_or_category", "budget_usd", "zip"]);
    expect(h.totalSends()).toBe(0);
  });

  it("an unknown input field is refused, not sent", async () => {
    const h = await setup();
    const result = await h.gateway.findOffers({ ...SHOES, colour: "blue" });
    expect(result.status).toBe("invalid");
    expect(h.totalSends()).toBe(0);
  });

  it("a ready search returns offers and a summary naming the fields sent, never their values", async () => {
    const h = await setup();
    const result = offersOf(await h.gateway.findOffers({ ...SHOES, must_haves: ["trail"] }));
    expect(result.offers.map((o) => o.title)).toEqual(["Trail Runner 3"]);
    expect(result.summary).toBe(
      "Sent: searchCatalog (budget_max.amount_minor, budget_max.currency, category, must_haves, ship_to.country, " +
        "ship_to.postal_code; receipt verified) / Blocked: nothing",
    );
    expect(result.summary).not.toContain("94103");
    expect(h.sends.search).toBe(1);
    const sent = bodies(h, "disclosure").at(-1);
    expect(JSON.parse(Buffer.from(String(sent?.body_b64), "base64").toString("utf8"))).toEqual({
      budget_max: { amount_minor: 20000, currency: "USD" },
      category: "running-shoes",
      must_haves: ["trail"],
      ship_to: { country: "US", postal_code: "94103" },
    });
  });
});

// ---- policy -------------------------------------------------------------------------------------------------------

describe("policy", () => {
  it("a blocked merchant's offers are hidden, and no cart can be made for them", async () => {
    const h = await setup({ policy: `${BASE_POLICY}merchants:\n  block: [dropship.example]\n` });
    const result = offersOf(await h.gateway.findOffers({ category: "home", budget_usd: 50, zip: "94103" }));
    expect(result.offers).toEqual([]);
    expect(result.hidden).toBe(1);
    expect(result.message).toContain("merchants.block");
    // The summary's Blocked part counts the hidden offer by rule, never naming the merchant that matched.
    expect(result.summary).toMatch(/ \/ Blocked: 1 offer \(merchants\.block\)$/);
    expect(result.summary).not.toContain("dropship");
    // Cloud still offers it; the gateway refuses to cart an offer it did not show.
    const direct = await h.real.search({ category: "home", budget_max: { amount_minor: 5000, currency: "USD" }, ship_to: { country: "US", postal_code: "94103" } });
    const hiddenHandle = direct.ok ? (direct.body.offers[0]?.offer_handle ?? "") : "";
    expect(hiddenHandle).toMatch(/^of_/);
    const cart = await h.gateway.createCart({ offer_handle: hiddenHandle });
    expect(cart.status).toBe("invalid");
    expect(h.sends.createCart).toBe(0);
  });

  it("a blocked category stops the search before it is sent, with a block entry", async () => {
    const h = await setup({ policy: `${BASE_POLICY}categories:\n  block: [electronics]\n` });
    const result = await h.gateway.findOffers({ category: "Electronics/Headphones", budget_usd: 300, zip: "94103" });
    expect(result.status).toBe("blocked");
    expect(result.summary).toBe("Sent: nothing / Blocked: categories.block at category");
    expect(h.sends.search).toBe(0);
    expect(bodies(h, "block").at(-1)).toMatchObject({ endpoint: "searchCatalog", blocked: ["categories.block at category"] });
  });

  describe("attack: a product-only search must not get around categories.block (the no-electronics seed)", () => {
    const NO_ELECTRONICS = readFileSync(new URL("../../policies/no-electronics/policy.yaml", import.meta.url), "utf8");
    const HEADPHONES = { product: "Studio Headphones", budget_usd: 200, zip: "94103" };

    it("a product-only search is not sent: the agent is asked for the category", async () => {
      const h = await setup({ policy: NO_ELECTRONICS });
      const result = await h.gateway.findOffers(HEADPHONES);
      expect(result.status).toBe("needs_details");
      if (result.status !== "needs_details") return;
      expect(result.missing.map((m) => m.field)).toEqual(["category"]);
      expect(result.message).toMatch(/What kind of product is it.*blocks some categories, so a search must name one/);
      expect(result.summary).toBe("Sent: nothing / Blocked: nothing");
      expect(h.sends.search).toBe(0);
      expect(bodies(h, "disclosure")).toHaveLength(2); // meta and key statement at start, nothing since
    });

    it("the same product under category electronics is blocked before it is sent", async () => {
      const h = await setup({ policy: NO_ELECTRONICS });
      const result = await h.gateway.findOffers({ ...HEADPHONES, category: "electronics" });
      expect(result.status).toBe("blocked");
      expect(result.summary).toBe("Sent: nothing / Blocked: categories.block at category");
      expect(h.sends.search).toBe(0);
    });

    it("a search naming an allowed category is sent, and its offer carts against that category", async () => {
      const h = await setup({ policy: NO_ELECTRONICS });
      const result = offersOf(await h.gateway.findOffers(SHOES));
      expect(result.offers.length).toBeGreaterThan(0);
      expect(h.sends.search).toBe(1);
      approvalOf(await h.gateway.createCart({ offer_handle: result.offers[0]?.offer_handle ?? "" }));
      // The headphones never come back under that category, so no electronics offer handle is ever remembered.
      const headphones = await h.gateway.findOffers({ ...HEADPHONES, category: "running-shoes" });
      expect(offersOf(headphones).offers).toEqual([]);
    });

    it("a policy without category blocks still accepts a product-only search", async () => {
      const h = await setup();
      expect(offersOf(await h.gateway.findOffers(HEADPHONES)).offers.map((o) => o.title)).toEqual(["Studio Headphones"]);
    });
  });

  it("the Cloud baseline holds under a policy that names nothing: an excluded category is never searched", async () => {
    const h = await setup();
    const result = await h.gateway.findOffers({ category: "health", budget_usd: 50, zip: "94103" });
    expect(result.status).toBe("blocked");
    expect(h.sends.search).toBe(0);
  });

  it("a ship_to: none policy refuses every search, since a search needs the ZIP", async () => {
    const h = await setup({ policy: `${BASE_POLICY}share:\n  ship_to: none\n` });
    const result = await h.gateway.findOffers(SHOES);
    expect(result.status).toBe("blocked");
    expect(h.sends.search).toBe(0);
  });

  it("the per-order cap hides offers over it and refuses a cart whose quantity takes it over", async () => {
    const h = await setup({ policy: `${BASE_POLICY}spend:\n  per_order_usd: 70\n` });
    const result = offersOf(await h.gateway.findOffers(SHOES));
    // Trail Runner 3 is $89.99 + $5 shipping: over. Road Runner 2 is $64.99, free shipping: under.
    expect(result.offers.map((o) => o.title)).toEqual(["Road Runner 2"]);
    expect(result.hidden).toBe(1);
    expect(result.summary).toMatch(/ \/ Blocked: 1 offer \(spend\.per_order_usd\)$/);
    expect(result.summary).not.toMatch(/89\.99|94\.99|Trail/);
    const handle = result.offers[0]?.offer_handle ?? "";
    const two = await h.gateway.createCart({ offer_handle: handle, quantity: 2 });
    expect(two.status).toBe("blocked");
    expect(two.summary).toContain("spend.per_order_usd at offer.price_usd");
    expect(h.sends.createCart).toBe(0);
    approvalOf(await h.gateway.createCart({ offer_handle: handle, quantity: 1 }));
  });

  it("the weekly cap counts approved purchases from the chain, and frees up after a week", async () => {
    const h = await setup({ policy: `${BASE_POLICY}spend:\n  per_week_usd: 150\n` });
    const passkey = new SoftPasskey();
    // Both offers are shown before anything is spent.
    const road = await offerHandle(h, "Road Runner 2");
    expect((await approvedPurchase(h, "Trail Runner 3", passkey)).status).toBe("approved");
    // $94.99 approved + $64.99 = $159.98 > $150.
    const over = await h.gateway.createCart({ offer_handle: road });
    expect(over.status).toBe("blocked");
    expect(over.summary).toContain("spend.per_week_usd");
    expect(h.sends.createCart).toBe(1);
    // A search now hides both offers, since either would go over.
    const both = offersOf(await h.gateway.findOffers(SHOES));
    expect(both.hidden).toBe(2);
    expect(both.summary).toMatch(/ \/ Blocked: 2 offers \(spend\.per_week_usd\)$/);

    h.advance(7 * DAY_MS + 60_000);
    approvalOf(await h.gateway.createCart({ offer_handle: await offerHandle(h, "Road Runner 2") }));
  });

  it("an open approval counts against the caps too, so parallel carts cannot add up past one", async () => {
    const h = await setup({ policy: `${BASE_POLICY}spend:\n  per_week_usd: 150\n` });
    const road = await offerHandle(h, "Road Runner 2");
    await pendingPurchase(h, "Trail Runner 3");
    expect((await h.gateway.createCart({ offer_handle: road })).status).toBe("blocked");
    // Once that approval has expired unapproved, it no longer counts.
    h.advance(16 * 60_000);
    approvalOf(await h.gateway.createCart({ offer_handle: await offerHandle(h, "Road Runner 2") }));
  });

  it("a malformed approval entry in the chain refuses carts instead of turning the caps off", async () => {
    const h = await setup({ policy: `${BASE_POLICY}spend:\n  per_week_usd: 150\n` });
    const road = await offerHandle(h, "Road Runner 2");
    await h.store.append("approval", { handle: "ap_broken0001", proof: null });
    const result = await h.gateway.createCart({ offer_handle: road });
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("history_invalid");
  });
});

// ---- snapshot checks ----------------------------------------------------------------------------------------------

describe("createCart snapshot checks", () => {
  /** Rewrites the approval Cloud created, keeping its hash and check code consistent unless told not to. */
  function rewriteApproval(h: Harness, change: (c: ApprovalCreated) => ApprovalCreated, rehash = true): void {
    h.patch.createApproval = async (cart) => {
      const r = await h.real.createApproval(cart);
      if (!r.ok) return r;
      const changed = change(r.body);
      const hash = sha256Hex(canonicalize(changed.snapshot));
      return { ...r, body: rehash ? { ...changed, snapshot_hash: hash, check_code: hash.slice(0, 8) } : changed };
    };
  }

  it("a pending approval is chained with its link, snapshot hash and total, and a QR of the link", async () => {
    const h = await setup();
    const result = approvalOf(await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3"), quantity: 2 }));
    const view = h.fake.inspect(result.approval_handle);
    expect(result.approval_url).toBe(view?.approval_link);
    expect(result.check_code).toBe(view?.snapshot_hash.slice(0, 8));
    expect(result.qr.text.length).toBeGreaterThan(100);
    expect(result.qr.data_url).toMatch(/^data:image\/gif;base64,/);
    expect(bodies(h, "approval_pending").at(-1)).toEqual({
      handle: result.approval_handle,
      approval_url: view?.approval_link,
      snapshot_hash: view?.snapshot_hash,
      total_minor: 2 * 8999 + 500,
      expires_at: view?.snapshot.expires_at,
      completion_mode: "handoff",
      completer_keyid: view?.snapshot.v === 2 ? view.snapshot.completer_keyid : "v1",
      sent: {
        cart_request: {
          offer_handle: bodies(h, "observed").find((o) => o.endpoint === "searchCatalog") === undefined ? "" : (JSON.parse(Buffer.from(String(bodies(h, "disclosure").find((d) => d.endpoint === "createCart")?.body_b64), "base64").toString("utf8")) as { offer_handle: string }).offer_handle,
          quantity: 2,
          ship_to: { country: "US", postal_code: SHOES.zip },
          completer_keyid: view?.snapshot.v === 2 ? view.snapshot.completer_keyid : "v1",
          completion_accepts: ["handoff"],
        },
        offer: { variant_ref: view?.snapshot.v === 2 ? view.snapshot.variant_ref : "v1", merchant: { name: "Trail Supply Co", domain: "shop.example" } },
        cart: {
          merchant_origin: "https://shop.example",
          variant_ref: view?.snapshot.v === 2 ? view.snapshot.variant_ref : "v1",
          total: { amount_minor: 2 * 8999 + 500, currency: "USD" },
          expires_at: result.cart.expires_at,
        },
      },
    });
    expect(result.summary).toBe(
      "Sent: createCart (completer_keyid, completion_accepts, offer_handle, quantity, ship_to.country, ship_to.postal_code; receipt verified); " +
        "createApproval (no body fields; receipt verified) / Blocked: nothing",
    );
  });

  it("a snapshot whose total differs from the cart is refused, and no approval is pending", async () => {
    const h = await setup();
    rewriteApproval(h, (c) => ({ ...c, snapshot: { ...c.snapshot, total: { amount_minor: 1, currency: "USD" } } }));
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("total differs from the cart");
    expect(bodies(h, "approval_pending")).toHaveLength(0);
    expect(bodies(h, "block").at(-1)).toMatchObject({ endpoint: "createApproval" });
  });

  it("a snapshot for another merchant or item is refused", async () => {
    const h = await setup();
    rewriteApproval(h, (c) => ({ ...c, snapshot: { ...c.snapshot, merchant: { name: "Other", domain: "other.example" } } }));
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("merchant differs from the cart");
  });

  it("a snapshot whose ZIP is not the ZIP sent is refused, even with the same 3-digit prefix", async () => {
    const h = await setup();
    rewriteApproval(h, (c) => ({ ...c, snapshot: { ...c.snapshot, ship_to: { country: "US", postal_code: "94199" } } }));
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("ship_to differs from the ZIP sent");
  });

  it("a v1 snapshot from a 1.6.0 host is refused", async () => {
    const h = await setup();
    rewriteApproval(h, (c) => {
      const v1 = omit(c.snapshot, ["merchant_origin", "variant_ref", "checkout_ref_hash", "completion_mode", "completer_keyid", "total_estimated"]);
      // The 1.6.0 schema refuses a v1 snapshot; this one arrives past it, as a faulty adapter would hand it on.
      return { ...c, snapshot: { ...v1, v: 1, ship_to: { country: "US", postal_prefix: "941" } } } as never;
    });
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("snapshot is v1");
    expect(bodies(h, "approval_pending")).toHaveLength(0);
  });

  it("a snapshot_hash that is not the snapshot's hash is refused", async () => {
    const h = await setup();
    rewriteApproval(h, (c) => ({ ...c, snapshot_hash: "f".repeat(64), check_code: "ffffffff" }), false);
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("snapshot_hash is not the snapshot's hash");
  });

  it("a cart whose total goes over the cap is refused before any approval is asked for", async () => {
    const h = await setup({ policy: `${BASE_POLICY}spend:\n  per_order_usd: 70\n` });
    const handle = await offerHandle(h, "Road Runner 2");
    h.patch.createCart = async (r) => {
      const res = await h.real.createCart(r);
      return res.ok ? { ...res, body: { ...res.body, total: { amount_minor: 9000, currency: "USD" } } } : res;
    };
    const result = await h.gateway.createCart({ offer_handle: handle });
    expect(result.status).toBe("refused");
    expect(h.sends.createApproval).toBe(0);
  });
});

// ---- invariant 3 --------------------------------------------------------------------------------------------------

describe("invariant 3: buyer identity in a tool input is never sent", () => {
  const ATTACKS: [string, Record<string, unknown>][] = [
    ["a card number in the product", { ...SHOES, product: "shoes, pay with 4111 1111 1111 1111" }],
    ["an email in the category", { ...SHOES, category: "jane.doe@mail.example" }],
    ["a street address in a must-have", { ...SHOES, must_haves: ["deliver to 1600 Pennsylvania Ave"] }],
    ["a phone number in the ZIP", { ...SHOES, zip: "(415) 555-2671" }],
    ["a name under an extra key", { ...SHOES, buyer_name: "Jane Doe" }],
    ["a shipping address object", { ...SHOES, shipping_address: { line1: "1 Infinite Loop" } }],
    ["a card split over a list", { ...SHOES, must_haves: ["4111", "1111", "1111", "1111"] }],
    ["an email as a field name", { ...SHOES, "jane.doe@mail.example": true }],
  ];

  it.each(ATTACKS)("find_offers with %s: 0 sends, a block entry without the value", async (_name, input) => {
    const h = await setup();
    const before = h.store.entries().length;
    const result = await h.gateway.findOffers(input);
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/^Sent: nothing \/ Blocked: /);
    expect(h.totalSends()).toBe(0);
    // What this call wrote, without the hashes and the start-up receipts, whose random hex can contain "4111".
    const chain = JSON.stringify(h.store.entries().slice(before).map((e) => [e.kind, e.body]));
    for (const secret of ["4111", "jane", "Jane", "Pennsylvania", "555-2671", "Infinite"]) expect(chain).not.toContain(secret);
    expect(bodies(h, "block")).toHaveLength(1);
  });

  it("identity is refused even when other details are missing", async () => {
    const h = await setup();
    expect((await h.gateway.findOffers({ product: "gift for jane.doe@mail.example" })).status).toBe("blocked");
    expect(h.totalSends()).toBe(0);
  });

  it("create_cart with a card or an address next to the offer handle: 0 sends", async () => {
    const h = await setup();
    const handle = await offerHandle(h, "Trail Runner 3");
    const before = h.store.entries().length;
    for (const extra of [{ card_number: "4111111111111111" }, { note: "ship to 742 Evergreen Terrace" }, { recipient: "Jane Doe" }]) {
      const result = await h.gateway.createCart({ offer_handle: handle, ...extra });
      expect(result.status).toBe("blocked");
    }
    expect(h.sends.createCart + h.sends.createApproval).toBe(0);
    // What these calls wrote, without the hashes, whose random hex can contain "4111".
    expect(JSON.stringify(h.store.entries().slice(before).map((e) => [e.kind, e.body]))).not.toMatch(/4111|Evergreen|Jane/);
  });

  it("get_approval_status with an email next to the handle: 0 sends", async () => {
    const h = await setup();
    const result = await h.gateway.getApprovalStatus({ approval_handle: "ap_abcdefgh", email: "jane.doe@mail.example" });
    expect(result.status).toBe("blocked");
    expect(h.sends.getApproval).toBe(0);
  });
});

// ---- invariant 4 --------------------------------------------------------------------------------------------------

describe("invariant 4: approved only when verified, chained and from the pinned passkey", () => {
  it("pending until the passkey approves; then the pin and the approval are chained, and the pin goes to stderr", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("pending");
    expect(bodies(h, "approval")).toHaveLength(0);

    const passkey = new SoftPasskey();
    expect(h.fake.approveWithPasskey(approval, passkey).status).toBe(200);
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    const pin = bodies(h, "approver_pin");
    expect(pin).toHaveLength(1);
    expect(pin[0]?.fingerprint).toBe(result.fingerprint);
    expect(pin[0]?.credential_id).toBe(passkey.credentialId);
    const chained = bodies(h, "approval");
    expect(chained).toHaveLength(1);
    expect(chained[0]?.handle).toBe(approval);
    expect((chained[0]?.proof as { approval_handle?: string }).approval_handle).toBe(approval);
    // The pin entry precedes the approval entry.
    expect(h.kinds().lastIndexOf("approver_pin")).toBeLessThan(h.kinds().lastIndexOf("approval"));
    expect(h.warnings).toEqual([`intent-gateway: pinned the first approving passkey. Fingerprint: ${result.fingerprint}`]);
    expect(verifyChain(h.store.entries()).ok).toBe(true);
  });

  it("a proof whose snapshot hash was tampered with is not verified: a block entry, no approval", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    h.fake.tamper.proofHash();
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("not_verified");
    expect(result.message).toContain("could not be verified");
    expect(bodies(h, "approval")).toHaveLength(0);
    expect(bodies(h, "approver_pin")).toHaveLength(0);
    expect(bodies(h, "block").at(-1)).toMatchObject({ endpoint: "getApproval", fields: ["proof"] });
  });

  it("a proof signed by a key the statement does not list is not verified", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    h.fake.tamper.proofUnknownKid();
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("not_verified");
    expect(result.message).toContain("unknown_kid");
    expect(bodies(h, "approval")).toHaveLength(0);
  });

  it("a replayed proof is not counted twice: asking again chains nothing new", async () => {
    const h = await setup();
    const passkey = new SoftPasskey();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, passkey);
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("approved");
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("approved");
    expect(bodies(h, "approval")).toHaveLength(1);
    expect(bodies(h, "approver_pin")).toHaveLength(1);
  });

  it("another approval's proof replayed for this one is not verified", async () => {
    const h = await setup();
    const passkey = new SoftPasskey();
    expect((await approvedPurchase(h, "Trail Runner 3", passkey)).status).toBe("approved");
    const oldProof = bodies(h, "approval")[0]?.proof as ApprovalStatus["proof"];
    const second = await pendingPurchase(h, "Road Runner 2");
    h.patch.getApproval = async (handle) => {
      const r = await h.real.getApproval(handle);
      return r.ok ? { ...r, body: { ...r.body, state: "approved", ...(oldProof === undefined ? {} : { proof: oldProof }) } } : r;
    };
    const result = await h.gateway.getApprovalStatus({ approval_handle: second });
    expect(result.status).toBe("not_verified");
    expect(result.message).toContain("handle_mismatch");
    expect(bodies(h, "approval")).toHaveLength(1);
  });

  it("a pending state that carries a proof is not verified", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    h.patch.getApproval = async (handle) => {
      const r = await h.real.getApproval(handle);
      return r.ok ? { ...r, body: { ...r.body, state: "pending" } } : r;
    };
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("not_verified");
    expect(result.message).toContain("proof_in_wrong_state");
    expect(bodies(h, "approval")).toHaveLength(0);
    expect(bodies(h, "block")).toHaveLength(1);
  });

  it("an approved state without a proof is not verified", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.patch.getApproval = async (handle) => {
      const r = await h.real.getApproval(handle);
      return r.ok ? { ...r, body: { ...r.body, state: "approved" } } : r;
    };
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("not_verified");
    expect(result.message).toContain("missing_proof");
  });

  it("a second passkey is flagged, naming intent approver accept and its fingerprint; accepting it at the terminal approves", async () => {
    const h = await setup();
    expect((await approvedPurchase(h, "Trail Runner 3", new SoftPasskey())).status).toBe("approved");
    const second = await pendingPurchase(h, "Road Runner 2");
    expect(h.fake.tamper.secondCredential(second).outcome.status).toBe(200);
    const result = await h.gateway.getApprovalStatus({ approval_handle: second });
    expect(result.status).toBe("flagged");
    if (result.status !== "flagged") return;
    expect(result.message).toContain("intent approver accept");
    expect(result.message).toContain(result.fingerprint);
    const flag = bodies(h, "approver_flag");
    expect(flag).toHaveLength(1);
    expect(flag[0]?.fingerprint).toBe(result.fingerprint);
    expect(bodies(h, "approver_pin")).toHaveLength(1);
    // A flagged approval is not chained as an approval.
    expect(bodies(h, "approval")).toHaveLength(1);
    expect(h.warnings).toHaveLength(1);
    // Asking again still says flagged, without a second flag entry.
    expect((await h.gateway.getApprovalStatus({ approval_handle: second })).status).toBe("flagged");
    expect(bodies(h, "approver_flag")).toHaveLength(1);

    // What `intent approver accept` writes after the person types the fingerprint.
    await h.store.append("approver_pin", flag[0]);
    const accepted = await h.gateway.getApprovalStatus({ approval_handle: second });
    expect(accepted.status).toBe("approved");
    expect(bodies(h, "approval")).toHaveLength(2);
  });

  it("a copy of the pinned passkey whose signature counter did not go up is flagged, not approved (attack)", async () => {
    const h = await setup();
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const at = (signCount: number) => new SoftPasskey({ privateKey: key, credentialId: "Y3JlZC0x", signCount });
    expect((await approvedPurchase(h, "Trail Runner 3", at(5))).status).toBe("approved");
    expect(bodies(h, "approver_pin")[0]?.sign_count).toBe(5);
    expect(bodies(h, "approval")[0]?.sign_count).toBe(5);

    const cloned = await pendingPurchase(h, "Road Runner 2");
    expect(h.fake.approveWithPasskey(cloned, at(5)).status).toBe(200);
    const result = await h.gateway.getApprovalStatus({ approval_handle: cloned });
    expect(result.status).toBe("flagged");
    expect(result.message).toContain("signature counter");
    expect(bodies(h, "approver_flag")).toMatchObject([{ reason: "sign_count", sign_count: 5, handle: cloned }]);
    expect(bodies(h, "approval")).toHaveLength(1);

    // The real passkey's counter has gone up: its next approval is accepted.
    expect((await approvedPurchase(h, "Trail Runner 3", at(6))).status).toBe("approved");
    expect(bodies(h, "approval").map((b) => b.sign_count)).toEqual([5, 6]);
  });

  it("an approval this gateway never asked for is unknown, and nothing is sent", async () => {
    const h = await setup();
    const result = await h.gateway.getApprovalStatus({ approval_handle: "ap_neverasked1" });
    expect(result.status).toBe("unknown");
    expect(h.sends.getApproval).toBe(0);
  });

  it("rejected and expired approvals are reported as such", async () => {
    const h = await setup();
    const rejected = await pendingPurchase(h, "Trail Runner 3");
    h.fake.reject(rejected, new SoftPasskey());
    expect((await h.gateway.getApprovalStatus({ approval_handle: rejected })).status).toBe("rejected");
    const expiring = await pendingPurchase(h, "Road Runner 2");
    h.advance(16 * 60_000);
    expect((await h.gateway.getApprovalStatus({ approval_handle: expiring })).status).toBe("expired");
    expect(bodies(h, "approval")).toHaveLength(0);
  });

  it("handed_off and ordered are worded as what Intent Cloud reported", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    expect(h.fake.handoff(approval).status).toBe(200);
    const handedOff = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(handedOff).toMatchObject({ status: "approved", cloud_reported: "handed_off" });
    expect(handedOff.message).toContain("Intent Cloud reported that the buyer was handed off");
    expect(h.fake.order(approval).status).toBe(200);
    const ordered = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(ordered).toMatchObject({ status: "approved", cloud_reported: "ordered" });
    expect(ordered.message).toMatch(/Intent Cloud reported that the merchant placed the order \(order ORD-\d+\)/);
    expect(bodies(h, "approval")).toHaveLength(1);
  });
});

// ---- observations: what came back, recorded locally (F-y) ----------------------------------------------------------

describe("observations: an `observed` entry after each acknowledged answer, never sent", () => {
  const seqOf = (h: Harness, kind: string, n = -1): number => h.store.entries().filter((e) => e.kind === kind).at(n)?.seq ?? -1;

  it("a search records the offer count and each offer's handle, title, merchant, price and shipping after its receipt", async () => {
    const h = await setup();
    const result = offersOf(await h.gateway.findOffers(SHOES));
    const observed = bodies(h, "observed");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ disclosure_seq: seqOf(h, "disclosure"), endpoint: "searchCatalog", offers_count: result.offers.length, offers_hidden: 0 });
    const first = result.offers[0];
    expect((observed[0]?.offers as unknown[])[0]).toEqual({
      offer_handle: first?.offer_handle,
      title: first?.title,
      merchant: first?.merchant.name,
      price_minor: first?.price.amount_minor,
      shipping_minor: first?.shipping.amount_minor,
      currency: "USD",
    });
    // After the receipt, so it never stands in for one.
    expect(h.kinds().slice(-3)).toEqual(["disclosure", "receipt", "observed"]);
    // Nothing more was sent for it: the search is the only request since start.
    expect(h.sends.search).toBe(1);
    expect(h.totalSends()).toBe(1);
  });

  it("the offers the policy hid are counted, and the list is capped while the count is not", async () => {
    const h = await setup({ policy: `${BASE_POLICY}spend:\n  per_order_usd: 60\n` });
    const result = offersOf(await h.gateway.findOffers(SHOES));
    expect(result.hidden).toBeGreaterThan(0);
    expect(bodies(h, "observed")[0]).toMatchObject({ offers_count: result.offers.length + result.hidden, offers_hidden: result.hidden });

    const many = await setup();
    many.patch.search = async (r) => {
      const res = await many.real.search(r);
      if (res.ok) {
        const offer = res.body.offers[0];
        if (offer !== undefined) res.body.offers = Array.from({ length: 14 }, (_, i) => ({ ...offer, offer_handle: `${offer.offer_handle.slice(0, -2)}${String(10 + i)}` }));
      }
      return res;
    };
    await many.gateway.findOffers(SHOES);
    const capped = bodies(many, "observed")[0];
    expect(capped?.offers_count).toBe(14);
    expect(capped?.offers).toHaveLength(10);
  });

  it("a cart records the title, merchant, quantity and total; the approval request its handle and state", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    const [, cart, created] = bodies(h, "observed");
    expect(cart).toMatchObject({ endpoint: "createCart", title: "Trail Runner 3", quantity: 1, currency: "USD" });
    expect(typeof cart?.merchant).toBe("string");
    expect(created).toMatchObject({ endpoint: "createApproval", approval_handle: approval, state: "pending", title: "Trail Runner 3", total_minor: cart?.total_minor });
  });

  it("a status check records the state Intent Cloud returned: rejected after a rejection on the confirm page", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.reject(approval, new SoftPasskey());
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("rejected");
    expect(bodies(h, "observed").at(-1)).toMatchObject({ endpoint: "getApproval", approval_handle: approval, state: "rejected", title: "Trail Runner 3" });
  });

  it("no observation when the answer was discarded or never came", async () => {
    const h = await setup();
    h.fake.tamper.dropReceipt();
    expect((await h.gateway.findOffers(SHOES)).status).toBe("error");
    expect(bodies(h, "observed")).toHaveLength(0);
  });

  it("invariant 3: a returned value that looks like buyer identity is withheld, and the chain still verifies", async () => {
    const h = await setup();
    h.patch.search = async (r) => {
      const res = await h.real.search(r);
      const offer = res.ok ? res.body.offers[0] : undefined;
      if (offer !== undefined) offer.title = "Call 415-555-2671 or mail jane.doe@mail.example";
      return res;
    };
    await h.gateway.findOffers(SHOES);
    const observed = bodies(h, "observed")[0];
    expect(observed?.withheld).toEqual(["$.offers[0].title"]);
    expect((observed?.offers as { title: string }[])[0]?.title).toBe("[withheld]");
    const chain = JSON.stringify(h.store.entries().map((e) => e.body));
    for (const secret of ["555-2671", "jane.doe"]) expect(chain).not.toContain(secret);
    const report = await runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(h.now()), skipSupplyChain: true });
    expect(report.exitCode).toBe(0);
  });

  it("a policy block keeps the value it held back (never sent); an identity block never does", async () => {
    const h = await setup();
    expect((await h.gateway.findOffers({ category: "alcohol", budget_usd: 50, zip: "94103" })).status).toBe("blocked");
    expect(h.sends.search).toBe(0);
    expect(bodies(h, "block").at(-1)).toEqual({
      endpoint: "searchCatalog",
      fields: ["budget_max", "budget_max.amount_minor", "budget_max.currency", "category", "ship_to", "ship_to.country", "ship_to.postal_code"],
      blocked: ["categories.block at category"],
      held: { category: "alcohol" },
    });
    expect((await h.gateway.findOffers({ ...SHOES, product: "mail jane.doe@mail.example" })).status).toBe("blocked");
    expect(bodies(h, "block").at(-1)).not.toHaveProperty("held");
  });

  it("attack: a blocked search never keeps the free-text product, where a name cannot be detected", async () => {
    const h = await setup();
    const result = await h.gateway.findOffers({ category: "alcohol", product: "a gift for Jane Q Doe", budget_usd: 50, zip: "94103" });
    expect(result.status).toBe("blocked");
    expect(h.sends.search).toBe(0);
    expect(bodies(h, "block").at(-1)?.held).toEqual({ category: "alcohol" });
    expect(JSON.stringify(h.store.entries().map((e) => e.body))).not.toContain("Jane");
  });
});

// ---- intent verify over a gateway chain ---------------------------------------------------------------------------

describe("runVerify over a chain the gateway wrote", () => {
  const verify = (h: Harness) =>
    runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(h.now()), skipSupplyChain: true });

  it("a search, a cart, an approval and a flag verify with exit 0; a dropped receipt then fails with exit 1", async () => {
    const h = await setup();
    expect((await approvedPurchase(h, "Trail Runner 3", new SoftPasskey())).status).toBe("approved");
    const second = await pendingPurchase(h, "Road Runner 2");
    h.fake.tamper.secondCredential(second);
    expect((await h.gateway.getApprovalStatus({ approval_handle: second })).status).toBe("flagged");
    const report = await verify(h);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.counts).toMatchObject({ approvals: 1, flags: 1, discarded: 0 });

    h.fake.tamper.dropReceipt();
    const result = await h.gateway.findOffers(SHOES);
    expect(result.status).toBe("error");
    expect(result.message).toContain("discarded");
    const after = await verify(h);
    expect(after.exitCode).toBe(1);
    expect(after.counts.discarded).toBe(1);
  });
});

// ---- key statement expiry -----------------------------------------------------------------------------------------

describe("the key statement expires while the gateway runs", () => {
  // The fake's statement lives 90 days from the day it was issued; 100 days on it has expired.
  const LATER = 100 * DAY_MS;
  const endpoints = (h: Harness, fromSeq: number) =>
    h.store
      .entries()
      .filter((e) => e.seq > fromSeq && e.kind === "disclosure")
      .map((e) => (e.body as { endpoint: string }).endpoint);

  it("attack: Cloud still serves the expired statement, so every tool refuses and nothing but the re-fetch is sent", async () => {
    const h = await setup();
    const road = await offerHandle(h, "Road Runner 2");
    const approval = await pendingPurchase(h, "Trail Runner 3");
    const expiredOn = new Date(h.fake.statement.expires_at).toISOString();
    const fromSeq = h.store.entries().at(-1)?.seq ?? -1;
    const searches = h.sends.search;
    h.advance(LATER);

    const search = await h.gateway.findOffers(SHOES);
    expect(search.status).toBe("error");
    expect(search.message).toContain(`the key statement expired on ${expiredOn}`);
    expect(search.message).toContain("Restart the gateway to fetch a fresh one");
    expect((await h.gateway.createCart({ offer_handle: road })).status).toBe("error");
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("error");

    expect(h.sends.search).toBe(searches);
    expect(h.sends.createCart).toBe(1);
    expect(h.sends.getApproval).toBe(0);
    // Only the disclosed statement re-fetch left the gateway: no ZIP, no search terms.
    expect(endpoints(h, fromSeq)).toEqual(["getKeyStatement", "getKeyStatement", "getKeyStatement"]);
    expect(bodies(h, "keys")).toHaveLength(1);
  });

  it("a fresh valid statement is fetched, chained and used, and intent verify still passes", async () => {
    const h = await setup();
    h.advance(LATER);
    // The same test root signs a statement issued 100 days later (the fake's keys are the published test seeds).
    const later = await startFakeCloud({ now: () => T0 + LATER });
    try {
      h.patch.keyStatement = async () => {
        const served = await h.real.keyStatement();
        return served.ok ? { ...served, body: later.statement } : served;
      };
      const fromSeq = h.store.entries().at(-1)?.seq ?? -1;
      const result = offersOf(await h.gateway.findOffers(SHOES));
      expect(result.offers.length).toBeGreaterThan(0);
      expect(endpoints(h, fromSeq)).toEqual(["getKeyStatement", "searchCatalog"]);
      expect(bodies(h, "keys").map((k) => k.statement)).toEqual([h.fake.statement, later.statement]);
      expect(h.warnings.some((w) => w.includes("fetched and chained a fresh one"))).toBe(true);
      // The next call uses the fresh statement without fetching again.
      offersOf(await h.gateway.findOffers(SHOES));
      expect(endpoints(h, fromSeq)).toEqual(["getKeyStatement", "searchCatalog", "searchCatalog"]);

      const report = await runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(h.now()), skipSupplyChain: true });
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.exitCode).toBe(0);
    } finally {
      await later.close();
    }
  });

  it("a re-fetched statement that does not verify is refused and not chained", async () => {
    const h = await setup();
    h.advance(LATER);
    h.fake.tamper.statementNonRoot();
    const result = await h.gateway.findOffers(SHOES);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/expired on .*returns now is not a fresh valid one \(the key statement did not verify .*step 2: bad_signature/);
    expect(bodies(h, "keys")).toHaveLength(1);
    expect(h.sends.search).toBe(0);
  });
});

// ---- contract 1.6.0 (G3) ------------------------------------------------------------------------------------------

describe("contract 1.6.0: completer key, local checks before any approval request", () => {
  const pendingBody = (h: Harness, handle: string) => bodies(h, "approval_pending").find((b) => b.handle === handle) ?? {};
  const keyidOf = (h: Harness, handle: string): string => String(pendingBody(h, handle).completer_keyid);
  const keyFiles = async (h: Harness): Promise<string[]> => (await h.completerKeys.list()).map((k) => k.keyid);
  /** The entries after the createCart disclosure's receipt (what the gateway did once the cart came back). */
  const afterCartReceipt = (h: Harness): Entry[] => {
    const chain = h.store.entries();
    const cart = chain.findLast((e) => e.kind === "disclosure" && (e.body as { endpoint?: unknown }).endpoint === "createCart");
    const receipt = chain.find((e) => e.kind === "receipt" && (e.body as { disclosure_seq?: unknown }).disclosure_seq === cart?.seq);
    if (receipt === undefined) throw new Error("no cart receipt");
    return chain.filter((e) => e.seq > receipt.seq);
  };
  const BINDING_OK = {
    rule_version: "binding-v1",
    result: "ok",
    checks: { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "match", total: "match" },
  } as const;

  it("the cart request names a fresh completer key, saved 0600 before the request is logged, and the snapshot binds it", async () => {
    const h = await setup();
    const offer = await offerHandle(h, "Trail Runner 3");
    let checked = false;
    h.patch.createCart = async (r) => {
      // Before the disclosed call runs (and so before its disclosure is appended), the key is on disk.
      expect(await keyFiles(h)).toContain(r.completer_keyid);
      const named = (e: Entry): boolean => e.kind === "disclosure" && Buffer.from(String((e.body as { body_b64?: unknown }).body_b64), "base64").toString().includes(r.completer_keyid);
      expect(h.store.entries().some(named)).toBe(false);
      checked = true;
      return h.real.createCart(r);
    };
    const result = approvalOf(await h.gateway.createCart({ offer_handle: offer }));
    expect(checked).toBe(true);
    const keyid = keyidOf(h, result.approval_handle);
    expect(await keyFiles(h)).toEqual([keyid]);
    if (process.platform !== "win32") expect((await fsp.stat(join(h.completerKeys.dir, `${keyid}.key`))).mode & 0o777).toBe(0o600);
    const snapshot = h.fake.inspect(result.approval_handle)?.snapshot;
    expect(snapshot).toMatchObject({ v: 2, completer_keyid: keyid, completion_mode: "handoff", ship_to: { postal_code: SHOES.zip } });
    const logged = bodies(h, "disclosure").find((d) => d.endpoint === "createCart");
    const sent = JSON.parse(Buffer.from(String(logged?.body_b64), "base64").toString("utf8")) as Record<string, unknown>;
    expect(sent).toMatchObject({ completer_keyid: keyid, completion_accepts: ["handoff"] });
    // A second cart gets its own key: a key links no purchases.
    const second = approvalOf(await h.gateway.createCart({ offer_handle: await offerHandle(h, "Road Runner 2") }));
    expect(keyidOf(h, second.approval_handle)).not.toBe(keyid);
  });

  it("only the completer keyid leaves or is logged: the private key is in no disclosure and nowhere in audit.jsonl", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    const keyid = keyidOf(h, approval);
    const file = JSON.parse(await fsp.readFile(join(h.completerKeys.dir, `${keyid}.key`), "utf8")) as { private_key_pem: string };
    const der = Buffer.from(file.private_key_pem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
    const audit = await fsp.readFile(join(h.dir, "audit.jsonl"), "utf8");
    for (const secret of [file.private_key_pem, der.toString("base64"), der.subarray(-32).toString("base64url"), der.subarray(-32).toString("hex")]) {
      expect(audit).not.toContain(secret);
    }
    expect(audit).toContain(keyid);
    // Requests to Intent Cloud are logged byte for byte (G2b): no redaction, and the version header is kept.
    for (const d of bodies(h, "disclosure")) {
      expect(d).not.toHaveProperty("redacted");
      expect(d.headers).toContainEqual(["intent-contract-version", "1.6.0"]);
    }
  });

  it("a usable wallet adds its mode ahead of handoff, only where the policy allows one_tap", async () => {
    const offered = async (policy: string): Promise<unknown> => {
      const h = await setup({ policy, walletModes: () => ["shop_agent"] });
      await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
      const logged = bodies(h, "disclosure").find((d) => d.endpoint === "createCart");
      return (JSON.parse(Buffer.from(String(logged?.body_b64), "base64").toString("utf8")) as { completion_accepts?: unknown }).completion_accepts;
    };
    expect(await offered(BASE_POLICY)).toEqual(["shop_agent", "handoff"]);
    expect(await offered(`${BASE_POLICY}completion: [handoff]\n`)).toEqual(["handoff"]);
  });

  it("attack (AC-G2): policy [handoff], Intent Cloud returns a shop_agent cart: refused, no disclosure after the cart's receipt, no key left", async () => {
    const h = await setup({ policy: `${BASE_POLICY}completion: [handoff]\n` });
    h.fake.tamper.cart({ completion_mode: "shop_agent" });
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("completion mode shop_agent was not offered");
    expect(afterCartReceipt(h).filter((e) => e.kind === "disclosure")).toEqual([]);
    expect(h.sends.createApproval).toBe(0);
    expect(bodies(h, "approval_pending")).toHaveLength(0);
    expect(bodies(h, "block").at(-1)).toMatchObject({ endpoint: "createCart", fields: ["cart"] });
    expect(await keyFiles(h)).toEqual([]);
  });

  it("attack: a shop_agent cart is refused under the default policy too, since this gateway has no wallet to offer it", async () => {
    const h = await setup();
    h.fake.tamper.cart({ completion_mode: "shop_agent" });
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(h.sends.createApproval).toBe(0);
  });

  it("a policy that allows only one_tap hides every hand-off offer, so no cart is sent and no key made", async () => {
    const h = await setup({ policy: `${BASE_POLICY}completion: [one_tap]\n` });
    const found = offersOf(await h.gateway.findOffers(SHOES));
    expect(found.offers).toEqual([]);
    expect(found.message).toContain("hidden by the gateway policy (completion)");
    expect(h.sends.createCart).toBe(0);
    expect(await keyFiles(h)).toEqual([]);
  });

  it.each([
    ["a variant_ref other than the offer's", { variant_ref: "gid://shopify/ProductVariant/1" }, "variant_ref differs from the offer"],
    ["an origin that is not the merchant's", { merchant_origin: "https://evil.example" }, "merchant_origin is not https:// + the merchant's domain"],
  ])("attack: a cart with %s is refused before any approval request", async (_name, patch, reason) => {
    const h = await setup();
    h.fake.tamper.cart(patch);
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain(reason);
    expect(h.sends.createApproval).toBe(0);
    expect(await keyFiles(h)).toEqual([]);
  });

  it("a cart without the 1.6.0 fields is refused before any approval request", async () => {
    const h = await setup();
    h.patch.createCart = async (r) => {
      const res = await h.real.createCart(r);
      if (!res.ok) return res;
      return { ...res, body: omit(res.body, ["completion_mode", "variant_ref"]) };
    };
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("cart lacks completion_mode, variant_ref");
    expect(h.sends.createApproval).toBe(0);
  });

  // Appendix E step 7 (amendment H2) at approval-request time, one attack per fact, plus the cart-equality ones.
  it.each([
    ["quantity 2 when 1 was requested", { quantity: 2 }, "quantity is not the quantity requested"],
    ["origin https://evil.example for domain shop.example", { merchant_origin: "https://evil.example" }, "merchant_origin is not https:// + the offer's merchant domain and the cart's"],
    ["another total than the cart's", { total: { amount_minor: 1, currency: "USD" } as const }, "total is not the cart's"],
    ["an expiry after the cart's", { expires_at: "2099-01-01T00:00:00Z" }, "expires_at is later than the cart's"],
    ["ZIP 94104 when 94103 was sent", { ship_to: { country: "US", postal_code: "94104" } as const }, "ship_to differs from the ZIP sent"],
    ["another variant", { variant_ref: "gid://shopify/ProductVariant/2" }, "variant_ref is not the offer's and the cart's"],
    ["a completion mode the cart request did not offer", { completion_mode: "shop_agent" as const }, "completion_mode is not one the cart request offered"],
    ["another completion mode than the cart's", { completion_mode: "shop_agent" as const }, "completion_mode differs from the cart"],
    ["an estimated total the cart did not have", { total_estimated: true }, "total_estimated differs from the cart"],
    ["another completer key", { completer_keyid: createSession().keyid }, "completer_keyid is not the key this gateway made for the cart"],
  ])("attack: a snapshot with %s is refused: no approval_pending, no key left", async (_name, patch, reason) => {
    const h = await setup();
    h.fake.tamper.snapshot(patch);
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain(reason);
    expect(bodies(h, "approval_pending")).toHaveLength(0);
    expect(await keyFiles(h)).toEqual([]);
  });

  it.each([
    ["quantity", { quantity: 2 }],
    ["ship_to", { ship_to: { country: "US", postal_code: "94104" } }],
    ["completer_keyid", { completer_keyid: createSession().keyid }],
    ["completion_mode", { completion_accepts: ["shop_agent"] }],
  ] as const)("attack (H2): at acceptance, step 7 refuses a proof whose snapshot is not the chained request's %s", async (field, change) => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    const status = await h.real.getApproval(approval);
    if (!status.ok) throw new Error("status failed");
    const entry = h.store.entries().find((e) => e.kind === "approval_pending" && (e.body as { handle?: unknown }).handle === approval);
    if (entry === undefined) throw new Error("no pending");
    const keySet = verifyStatement(h.fake.statement, [h.fake.keys.rootPin], new Date(h.now()));
    if (!keySet.ok) throw new Error("statement");
    // The chained entry passes; the same proof against a request that asked for something else fails at step 7.
    expect(verifyApprovalProof(status.body, entry, keySet.keySet, [], new Date(h.now())).ok).toBe(true);
    const body = entry.body as { sent: { cart_request: object } };
    const forged = { ...entry, body: { ...body, sent: { ...body.sent, cart_request: { ...body.sent.cart_request, ...change } } } };
    expect(verifyApprovalProof(status.body, forged, keySet.keySet, [], new Date(h.now()))).toMatchObject({ ok: false, step: 7, reason: field });
  });

  it("attack (H2): at acceptance, step 7 refuses another variant or origin than the offer's and the cart's", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    const status = await h.real.getApproval(approval);
    if (!status.ok) throw new Error("status failed");
    const entry = h.store.entries().find((e) => e.kind === "approval_pending" && (e.body as { handle?: unknown }).handle === approval);
    const keySet = verifyStatement(h.fake.statement, [h.fake.keys.rootPin], new Date(h.now()));
    if (entry === undefined || !keySet.ok) throw new Error("setup");
    const body = entry.body as { sent: { offer: object; cart: object } };
    const check = (sent: object) => verifyApprovalProof(status.body, { ...entry, body: { ...body, sent: { ...body.sent, ...sent } } }, keySet.keySet, [], new Date(h.now()));
    expect(check({ offer: { ...body.sent.offer, variant_ref: "gid://shopify/ProductVariant/9" } })).toMatchObject({ step: 7, reason: "variant_ref" });
    expect(check({ cart: { ...body.sent.cart, merchant_origin: "https://evil.example" } })).toMatchObject({ step: 7, reason: "merchant_origin" });
    expect(check({ offer: { ...body.sent.offer, merchant: { name: "Other", domain: "other.example" } } })).toMatchObject({ step: 7, reason: "merchant_origin" });
    expect(check({ cart: { ...body.sent.cart, total: { amount_minor: 1, currency: "USD" } } })).toMatchObject({ step: 7, reason: "total" });
    expect(check({ cart: { ...body.sent.cart, expires_at: "2026-10-15T12:00:01Z" } })).toMatchObject({ step: 7, reason: "expires_at" });
  });

  it("a pending entry without step 7's `sent` (a 1.5.0 gateway's) is refused live: the v1 proof form is for intent verify only", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    const entry = h.store.entries().find((e) => e.kind === "approval_pending" && (e.body as { handle?: unknown }).handle === approval);
    await h.store.append("approval_pending", omit(entry?.body as Record<string, unknown>, ["sent"]));
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("not_verified");
    expect(result.message).toContain("before contract 1.6.0");
    expect(bodies(h, "approval")).toHaveLength(0);
  });

  it("a cart whose answer step 7 could not read is refused before any approval request", async () => {
    const h = await setup();
    // Past the adapter's schema (as a faulty one would hand it on): an expiry that is no Timestamp.
    h.patch.createCart = async (r) => {
      const res = await h.real.createCart(r);
      return res.ok ? { ...res, body: { ...res.body, expires_at: "2026-10-15 12:15:00Z" } } : res;
    };
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("step 7");
    expect(h.sends.createApproval).toBe(0);
    expect(await keyFiles(h)).toEqual([]);
  });

  it("M5: the gateway's key choice refuses an earlier approval's keyid", async () => {
    const h = await setup();
    const first = await pendingPurchase(h, "Trail Runner 3");
    const accepted: boolean[] = [];
    const keys = h.completerKeys;
    const wrapped: CompleterKeys = { ...keys, create: (accept) => (accepted.push(accept?.(keyidOf(h, first)) ?? true), keys.create(accept)) };
    const restarted = await build({ fake: h.fake, store: h.store, dir: h.dir, clock: { at: h.now() }, now: h.now }, { completerKeys: wrapped });
    approvalOf(await restarted.gateway.createCart({ offer_handle: await offerHandle(restarted, "Road Runner 2") }));
    expect(accepted).toEqual([false]);
  });

  it("M5: a cart never reuses an earlier approval's completer key, and Intent Cloud refuses one that does", async () => {
    const h = await setup();
    const first = await pendingPurchase(h, "Trail Runner 3");
    const reused = keyidOf(h, first);
    h.patch.createCart = (r) => h.real.createCart({ ...r, completer_keyid: reused });
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Road Runner 2") });
    expect(result.status).toBe("error");
    expect(result.message).toContain("completer_keyid belongs to an earlier approval");
  });

  it("attack (AC-G4): a proof whose snapshot completion_mode differs from the pending one is not_pending_snapshot", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    h.fake.tamper.proofSnapshot({ completion_mode: "shop_agent" });
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("not_verified");
    expect(result.message).toContain("not_pending_snapshot");
    expect(bodies(h, "approval")).toHaveLength(0);
  });

  it("restart: a new session key reads the approval with its completer key, and it is approved", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("pending");
    expect(h.signers.at(-1)).toEqual({ op: "getApproval", keyid: null });
    const restarted = await h.restart();
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    const result = await restarted.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("approved");
    const keyid = keyidOf(h, approval);
    expect(restarted.signers.at(-1)).toEqual({ op: "getApproval", keyid });
    // The logged request names the completer key, so `intent verify` checks the receipt against the key that signed.
    const read = bodies(h, "disclosure").findLast((d) => d.endpoint === "getApproval");
    expect(read?.keyid).toBe(keyid);
    const report = await runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(h.now()), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("restart without the key file: the read goes out under the session key and Intent Cloud answers 404", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    await h.completerKeys.remove(keyidOf(h, approval));
    const restarted = await h.restart();
    const result = await restarted.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("error");
    expect(result.message).toContain("404");
    expect(restarted.signers.at(-1)).toEqual({ op: "getApproval", keyid: null });
  });

  it("against a host that serves only 1.5.0, start fails with contract mismatch", async () => {
    const h = await setup({ start: false, fake: { versions: ["1.5.0"] } });
    await expect(h.gateway.start()).rejects.toThrow(/contract mismatch: this gateway implements contract 1\.6\.0 .*Intent-Contract-Version is 1\.5\.0/);
  });

  it("the key is gone after a terminal outcome (the merchant's order), read once", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("approved");
    expect(h.fake.handoff(approval).status).toBe(200);
    expect(await keyFiles(h)).toEqual([keyidOf(h, approval)]);
    expect(h.fake.order(approval).status).toBe(200);
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ status: "approved", cloud_reported: "ordered" });
    expect(await keyFiles(h)).toEqual([]);
  });

  it("retention with a fake clock: an unapproved cart's key is gone at expires_at", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    const expiresAt = Date.parse(String(pendingBody(h, approval).expires_at));
    h.advance(expiresAt - h.now() - 1000);
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("pending");
    expect(await keyFiles(h)).toHaveLength(1);
    h.advance(1000);
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("expired");
    expect(await keyFiles(h)).toEqual([]);
  });

  it("retention: a handed-off key survives to expires_at + 47 h, where a restarted gateway reads a webhook order with it", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    expect((await h.gateway.getApprovalStatus({ approval_handle: approval })).status).toBe("approved");
    expect(h.fake.handoff(approval).status).toBe(200);
    expect(await h.gateway.getApprovalStatus({ approval_handle: approval })).toMatchObject({ cloud_reported: "handed_off" });
    const expiresAt = Date.parse(String(pendingBody(h, approval).expires_at));
    h.advance(expiresAt + 47 * 3_600_000 - h.now());
    const restarted = await h.restart();
    expect(await keyFiles(h)).toEqual([keyidOf(h, approval)]);
    expect(h.fake.order(approval).status).toBe(200);
    expect(await restarted.gateway.getApprovalStatus({ approval_handle: approval })).toMatchObject({ status: "approved", cloud_reported: "ordered" });
    expect(restarted.signers.at(-1)?.keyid).toBe(keyidOf(h, approval));
    expect(await keyFiles(h)).toEqual([]);
  });

  it("retention: a handed-off key with no terminal outcome is gone at expires_at + 48 h", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    h.fake.handoff(approval);
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    const expiresAt = Date.parse(String(pendingBody(h, approval).expires_at));
    h.advance(expiresAt + 48 * 3_600_000 - h.now());
    await h.restart();
    expect(await keyFiles(h)).toEqual([]);
  });

  it.each([
    ["checkout_expired", "handed_off"],
    ["mismatch", "handed_off"],
    ["reported", "handed_off"],
    ["ordered", "ordered"],
  ] as const)("o3, hand-off: Intent Cloud's %s outcome is reported as %s", async (outcome, reported) => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    const verified = outcome === "ordered" || outcome === "mismatch";
    // An order outcome carries order_ref, final_total and binding (Appendix G statement validity, M2), and a
    // mismatch's binding result follows its checks.
    const order = { order_ref: "#1001", final_total: { amount_minor: Number(pendingBody(h, approval).total_minor), currency: "USD" as const } };
    const binding = outcome === "mismatch" ? { ...BINDING_OK, result: "mismatch" as const, checks: { ...BINDING_OK.checks, line: "differs" as const } } : BINDING_OK;
    expect(h.fake.setOutcome(approval, { state: outcome, source: "merchant_api", assurance: verified ? "verified" : "reported", ...(verified ? { ...order, binding } : {}) }).status).toBe(200);
    expect(await h.gateway.getApprovalStatus({ approval_handle: approval })).toMatchObject({ status: "approved", cloud_reported: reported });
    expect(bodies(h, "observed").at(-1)).toMatchObject({ endpoint: "getApproval", outcome_state: outcome });
  });

  it.each(["ordered", "handed_off"] as const)("attack (invariant 5): a 1.6.0 status %s with no outcome is not repeated, and the key stays", async (state) => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    h.patch.getApproval = async (handle, signer) => {
      const r = await h.real.getApproval(handle, signer);
      return r.ok ? { ...r, body: { ...omit(r.body, ["outcome"]), state, order_number: "ORD-1" } } : r;
    };
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("approved");
    expect(result).not.toHaveProperty("cloud_reported");
    expect(result).not.toHaveProperty("order_number");
    expect(result.message).not.toContain("placed the order");
    expect(result.message).toContain("inconsistently");
    expect(await keyFiles(h)).toEqual([keyidOf(h, approval)]);
  });

  it("attack: a mid-session answer in another contract version is not used", async () => {
    const h = await setup();
    h.patch.search = async (r) => ({ ...(await h.real.search(r)), contractVersion: "1.5.0" });
    const result = await h.gateway.findOffers(SHOES);
    expect(result.status).toBe("error");
    expect(result.message).toContain("answered in contract 1.5.0, not 1.6.0");
    expect(bodies(h, "observed")).toHaveLength(0);
    // A cart whose answer comes back downgraded asks for no approval and keeps no key.
    delete h.patch.search;
    const offer = await offerHandle(h, "Trail Runner 3");
    h.patch.createCart = async (r) => ({ ...(await h.real.createCart(r)), contractVersion: "1.5.0" });
    expect((await h.gateway.createCart({ offer_handle: offer })).status).toBe("error");
    expect(h.sends.createApproval).toBe(0);
    expect(await keyFiles(h)).toEqual([]);
  });

  it("attack: an offer without variant_ref is refused before any key is made or cart sent", async () => {
    const h = await setup();
    h.patch.search = async (r) => {
      const res = await h.real.search(r);
      return res.ok ? { ...res, body: { offers: res.body.offers.map((o) => omit(o, ["variant_ref"])) } } : res;
    };
    const offer = await offerHandle(h, "Trail Runner 3");
    const result = await h.gateway.createCart({ offer_handle: offer });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("no variant_ref");
    expect(h.sends.createCart).toBe(0);
    expect(await keyFiles(h)).toEqual([]);
  });

  it("attack: a status whose state claims more than its outcome is not repeated", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    h.fake.handoff(approval);
    h.patch.getApproval = async (handle, signer) => {
      const r = await h.real.getApproval(handle, signer);
      return r.ok ? { ...r, body: { ...r.body, state: "ordered", order_number: "ORD-1" } } : r;
    };
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result.status).toBe("approved");
    expect(result).not.toHaveProperty("cloud_reported");
    expect(result.message).toContain("inconsistently");
    expect(h.warnings.some((w) => w.includes("disagree"))).toBe(true);
  });
});

// ---- outcomes (plan G4, ADR-0015) -----------------------------------------------------------------------------

describe("outcomes: only a verified statement is acted on, and never more than it shows", () => {
  const verify = (h: Harness) => runVerify({ dataDir: h.dir, pinnedRootKeys: [h.fake.keys.rootPin], now: new Date(h.now()), skipSupplyChain: true });
  const outcomes = (h: Harness) => bodies(h, "outcome");
  const plusOne = (o: Record<string, unknown>) => ({ ...o, final_total: { amount_minor: (o.final_total as { amount_minor: number }).amount_minor + 1, currency: "USD" } });

  /** An approved hand-off purchase the merchant ordered; returns its handle. The gateway has read the hand-off. */
  async function orderedPurchase(h: Harness): Promise<string> {
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    h.fake.handoff(approval);
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    h.fake.order(approval);
    return approval;
  }

  /**
   * Serves each status read with its outcome changed by `change`, in both `outcome` and a statement correctly signed
   * by the test approval key (with `prefix`), so the attack fails exactly the rule under test. `state` overrides the
   * status's state.
   */
  function serveSigned(h: Harness, change: (outcome: Record<string, unknown>) => Record<string, unknown>, prefix?: string, state?: ApprovalStatus["state"]): void {
    h.patch.getApproval = async (handle, signer) => {
      const r = await h.real.getApproval(handle, signer);
      if (!r.ok || r.body.outcome_statement === undefined) return r;
      const outcome = change(r.body.outcome_statement.outcome);
      const unsigned = omit({ ...r.body.outcome_statement, outcome }, ["cloud_signature"]) as Record<string, unknown>;
      const statement = signOutcomeStatement(unsigned, undefined, prefix);
      return { ...r, body: { ...r.body, ...(state === undefined ? {} : { state }), outcome, outcome_statement: statement } as ApprovalStatus };
    };
  }

  it("a merchant order: chained with its verified statement, shown ordered, once per outcome; intent verify re-checks it", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ status: "approved", cloud_reported: "ordered", outcome: { state_shown: "ordered", statement_verified: true, source: "signed_webhook" } });
    expect(result.message).toMatch(/Intent Cloud reported that the merchant placed the order \(order ORD-\d+\), in a statement the gateway verified/);
    expect(outcomes(h).map((o) => [o.state_shown, o.statement_verified])).toEqual([
      ["handed_off", true],
      ["ordered", true],
    ]);
    expect(outcomes(h).at(-1)).toMatchObject({ basis: "cloud", handle: approval, local_binding: { result: "ok" } });
    expect(String(outcomes(h).at(-1)?.order_ref)).toMatch(/^ORD-/);
    const report = await verify(h);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.counts.outcomes).toBe(2);
    expect(report.checks.find((c) => c.name === "outcomes")?.details[0]).toBe("re-checked: 2 (handed_off: 1, ordered: 1)");
  });

  it("attack (AC-G4.1): Intent Cloud signs ordered with a final total above the approved one: refused final_total, never ordered", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    serveSigned(h, plusOne);
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    // Nothing is shown from the refused statement; the hand-off adopted from the earlier verified statement stays.
    expect(result).toMatchObject({
      outcome: { state_shown: "handed_off", kept_earlier: true, cloud_state: "ordered", statement_verified: false, refused_by: "final_total" },
      cloud_reported: "handed_off",
    });
    expect(result).not.toHaveProperty("order_number");
    expect(result.message).not.toContain("placed the order");
    expect(result.message).toContain("Intent Cloud reported ordered, but its statement fails final_total; not acted on.");
    expect(outcomes(h).at(-1)).toMatchObject({ state_shown: null, statement_verified: false, refused_by: "final_total", local_binding: { result: "mismatch" } });
    expect(outcomes(h).some((o) => o.state_shown === "mismatch" || o.state_shown === "ordered")).toBe(false);
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("attack (AC-G4.2): ordered signed with assurance reported: refused o1, never ordered", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    serveSigned(h, (o) => ({ ...o, assurance: "reported" }));
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    // Intent Cloud's status still says ordered: the sentence repeats nothing.
    expect(result).toMatchObject({ outcome: { state_shown: "handed_off", kept_earlier: true, refused_by: "o1" } });
    expect(result).not.toHaveProperty("cloud_reported");
    expect(result.message).not.toContain("placed the order");
    expect(outcomes(h).at(-1)).toMatchObject({ state_shown: null, statement_verified: false, refused_by: "o1" });
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("attack: a statement signed without the prefix is refused and nothing of it is shown", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    serveSigned(h, (o) => o, "");
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ outcome: { state_shown: "handed_off", kept_earlier: true, statement_verified: false, refused_by: "cloud_signature" } });
    expect(result).not.toHaveProperty("order_number");
    expect(result.message).toContain("but its statement fails cloud_signature; not acted on.");
    expect(outcomes(h).at(-1)).toMatchObject({ state_shown: null, statement_verified: false });
    expect(outcomes(h).at(-1)).not.toHaveProperty("order_ref");
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("with no earlier verified outcome, a refused statement shows nothing at all", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    h.fake.handoff(approval);
    serveSigned(h, (o) => o, "");
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ outcome: { state_shown: null, refused_by: "cloud_signature" } });
    expect(result).not.toHaveProperty("cloud_reported");
  });

  it("attack (M1): an outcome without its statement, or one that differs from the statement's, is not acted on", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    h.patch.getApproval = async (handle, signer) => {
      const r = await h.real.getApproval(handle, signer);
      return r.ok ? { ...r, body: omit(r.body, ["outcome_statement"]) } : r;
    };
    const bare = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(bare).toMatchObject({ outcome: { state_shown: "handed_off", kept_earlier: true, refused_by: "m1" } });
    expect(bare).not.toHaveProperty("order_number");
    h.patch.getApproval = async (handle, signer) => {
      const r = await h.real.getApproval(handle, signer);
      return r.ok && r.body.outcome !== undefined ? { ...r, body: { ...r.body, outcome: { ...r.body.outcome, order_ref: "ORD-999999" } } } : r;
    };
    const differing = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(differing).toMatchObject({ outcome: { state_shown: "handed_off", refused_by: "m1" } });
    expect(differing).not.toHaveProperty("order_number");
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("a statement naming a Shopify order gid whose 14-digit number passes Luhn is kept and shown ordered (ADR-0019), and verify passes", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    // Fixed: 12345678901237 passes Luhn, so the card check alone reads this gid as a card.
    const gid = "gid://shopify/Order/12345678901237";
    serveSigned(h, (o) => ({ ...o, order_ref: gid }));
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ outcome: { state_shown: "ordered", statement_verified: true } });
    expect(outcomes(h).at(-1)).toMatchObject({ statement_verified: true, state_shown: "ordered", order_ref: gid });
    expect(outcomes(h).at(-1)).toHaveProperty("statement_jcs");
    const report = await verify(h);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("attack (invariant 3): a statement holding what looks like a card number (a 16-digit Luhn-valid order id, not an order gid) is not kept: refused identity, and verify passes", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    serveSigned(h, (o) => ({ ...o, order_ref: "4111111111111111" }));
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ outcome: { state_shown: "handed_off", kept_earlier: true, statement_verified: false, refused_by: "identity" } });
    expect(result).not.toHaveProperty("order_number");
    const entry = outcomes(h).at(-1);
    expect(entry).toMatchObject({ statement_verified: false, refused_by: "identity", state_shown: null });
    expect(entry).not.toHaveProperty("statement_jcs");
    expect(entry).not.toHaveProperty("order_ref");
    expect(h.store.entries().some((e) => e.kind === "outcome" && JSON.stringify(e.body).includes("4111111111111111"))).toBe(false);
    expect((await verify(h)).exitCode).toBe(0);
  });

  it("attack (invariant 1): a verified Intent Cloud checkout_expired never frees spend-cap room", async () => {
    const h = await setup();
    const approval = await pendingPurchase(h, "Trail Runner 3");
    h.fake.approveWithPasskey(approval, new SoftPasskey());
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    const before = spendHistory(h.store.entries(), h.now());
    h.fake.setOutcome(approval, { state: "checkout_expired", source: "merchant_api", assurance: "verified" });
    expect(await h.gateway.getApprovalStatus({ approval_handle: approval })).toMatchObject({ outcome: { state_shown: "checkout_expired", statement_verified: true } });
    expect(spendHistory(h.store.entries(), h.now())).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("R5a: after a verified ordered, a later verified outcome is not adopted, and the order number stays the adopted one", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    const ordered = await h.gateway.getApprovalStatus({ approval_handle: approval });
    const orderNumber = ordered.status === "approved" ? ordered.order_number : undefined;
    expect(orderNumber).toMatch(/^ORD-/);
    const count = outcomes(h).length;
    serveSigned(h, (o) => ({ ...o, state: "handed_off", source: "merchant_api", order_ref: "ORD-999999" }), undefined, "handed_off");
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ outcome: { state_shown: "ordered", kept_earlier: true, cloud_state: "handed_off" }, order_number: orderNumber });
    expect(outcomes(h)).toHaveLength(count);
    expect(h.warnings.some((w) => w.includes("R5a"))).toBe(true);
  });

  it("R5a: a verified terminal ordered is never followed by a shown mismatch, even from a refused statement", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    const ordered = await h.gateway.getApprovalStatus({ approval_handle: approval });
    const orderNumber = ordered.status === "approved" ? ordered.order_number : undefined;
    serveSigned(h, (o) => ({ ...plusOne(o), order_ref: "ORD-999999" }));
    const result = await h.gateway.getApprovalStatus({ approval_handle: approval });
    expect(result).toMatchObject({ outcome: { state_shown: "ordered", kept_earlier: true, refused_by: "final_total" }, order_number: orderNumber });
    expect(result.message).toContain("but its statement fails final_total");
    expect(outcomes(h).some((o) => o.state_shown === "mismatch")).toBe(false);
  });

  it("attack: an outcome entry rewritten (and re-hashed) to show ordered fails intent verify", async () => {
    const h = await setup();
    const approval = await orderedPurchase(h);
    serveSigned(h, plusOne);
    await h.gateway.getApprovalStatus({ approval_handle: approval });
    let prev = "0".repeat(64);
    const lines = h.store.entries().map(({ seq, ts, kind, body }) => {
      const refused = kind === "outcome" && (body as { refused_by?: unknown }).refused_by === "final_total";
      const fields = { seq, prev, ts, kind, body: refused ? { ...(body as object), state_shown: "ordered" } : body };
      prev = sha256Hex(canonicalize(fields));
      return canonicalize({ ...fields, hash: prev });
    });
    await fsp.writeFile(join(h.dir, "audit.jsonl"), `${lines.join("\n")}\n`);
    const report = await verify(h);
    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.name === "outcomes")?.details.join("\n")).toContain("shows ordered, but its statement supports null (rule O1");
  });
});
