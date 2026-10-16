// The gateway use cases against the fake Intent Cloud over real HTTP, with the real store, disclosure log and trust
// checks. Invariant 3: identity anywhere in a tool input → 0 sends. Invariant 4: "approved" only after the proof
// verified, was chained, and came from the pinned passkey. Invariant 1: the policy's blocks and caps (the weekly one
// computed from the chain) hold before anything is sent.
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeCloud, SoftPasskey, startFakeCloud } from "../cloud-fake/index.ts";
import type { ApprovalCreated, ApprovalStatus } from "../contract/index.ts";
import { connectCloud, type DisclosedCloud } from "../disclosure/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { createSession } from "../signing/index.ts";
import { type Entry, openStore, type Store, verifyChain } from "../store/index.ts";
import type { PinnedRootKey } from "../trust/index.ts";
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
  advance(ms: number): void;
  kinds(): string[];
  totalSends(): number;
}

let open: { fake: FakeCloud; store: Store }[] = [];

afterEach(async () => {
  for (const { fake, store } of open) {
    await store.close();
    await fake.close();
  }
  open = [];
});

async function setup(options: { policy?: string; pin?: PinnedRootKey[]; start?: boolean } = {}): Promise<Harness> {
  let clock = T0;
  const now = (): number => clock;
  const fake = await startFakeCloud({ now });
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "gateway-")), "data");
  const store = await openStore(dir, { clock: now });
  open.push({ fake, store });
  const session = createSession();
  const warnings: string[] = [];
  const sends = { search: 0, createCart: 0, createApproval: 0, getApproval: 0 };
  const patch: Partial<DisclosedCloud> = {};
  const holder: { real: DisclosedCloud | null } = { real: null };
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
        getApproval: (h) => (sends.getApproval++, (patch.getApproval ?? real.getApproval)(h)),
      };
    },
    store,
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
    advance: (ms) => {
      clock += ms;
    },
    kinds: () => store.entries().map((e) => e.kind),
    totalSends: () => OPS.reduce((n, op) => n + sends[op], 0),
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
    expect(h.kinds().slice(0, 4)).toEqual(["disclosure", "receipt", "disclosure", "receipt"]);
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
    await expect(failure).rejects.toThrow(/contract mismatch: this gateway implements contract 1\.5\.0.*contract_sums_sha256 is 0{64}/);
    expect(bodies(h, "keys")).toHaveLength(0);
    await expect(h.gateway.findOffers(SHOES)).rejects.toThrow(GatewayNotStartedError);
    expect(h.totalSends()).toBe(0);
  });

  it("an Intent-Contract-Version mismatch fails start clearly", async () => {
    const h = await setup({ start: false });
    h.patch.meta = async () => ({ ...(await h.real.meta()), contractVersion: "1.6.0" });
    await expect(h.gateway.start()).rejects.toThrow(/Intent-Contract-Version is 1\.6\.0/);
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
    });
    expect(result.summary).toBe(
      "Sent: createCart (offer_handle, quantity, ship_to.country, ship_to.postal_code; receipt verified); " +
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

  it("a snapshot whose postal_prefix is not the ZIP sent is refused", async () => {
    const h = await setup();
    rewriteApproval(h, (c) => ({ ...c, snapshot: { ...c.snapshot, ship_to: { country: "US", postal_prefix: "100" } } }));
    const result = await h.gateway.createCart({ offer_handle: await offerHandle(h, "Trail Runner 3") });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("ship_to differs from the ZIP sent");
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
