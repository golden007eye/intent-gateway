// `intent log` on a chain with observations (F-y): the timeline shows what came back (`→ 3 offers`, the product
// title, merchant and total, the approval state, a rejection), a blocked search names the value it held back, `-v`
// lists each observation, and `--json` (v2) carries them. The footer prints the real invocation and is never cut.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_SESSION } from "../gateway/index.ts";
import { type Entry, openStore } from "../store/index.ts";
import { formatJson, formatLog, formatVerbose, readLog } from "./log.ts";

const TS = Date.parse("2026-10-16T17:26:37.000Z");
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const SEARCH = { category: "running shoes", budget_max: { amount_minor: 12000, currency: "USD" }, ship_to: { country: "US", postal_code: "94103" } };
const SEARCH_FIELDS = ["budget_max", "budget_max.amount_minor", "budget_max.currency", "category", "ship_to", "ship_to.country", "ship_to.postal_code"];
const CART_FIELDS = ["offer_handle", "quantity", "ship_to", "ship_to.country", "ship_to.postal_code"];
const offer = (n: number, title: string, merchant: string, price: number) => ({ offer_handle: `of_${String(n).repeat(20)}`, title, merchant, price_minor: price, shipping_minor: 199, currency: "USD" });

function disclosure(endpoint: string, method: string, path: string, body: unknown, fields: string[] = []) {
  return { endpoint, method, path, fields, body_b64: body === null ? "" : b64(body), content_digest: "sha-256=:x:", keyid: "gw-k" };
}

/** The demo flow by hand: a search, a blocked "alcohol" search, an approved cart, a second cart rejected on the page. */
async function writeObservedFlow(dir: string): Promise<void> {
  let second = 0;
  const store = await openStore(dir, { clock: () => TS + (second += 1000) });
  const append = (kind: Entry["kind"], body: unknown) => store.append(kind, body);
  const ok = (d: Entry, status = 200) => append("receipt", { disclosure_seq: d.seq, status, verified: true });
  await append("session", DEMO_SESSION);
  await append("keys", { statement: { kid: "cloud-root-1", expires_at: "2027-01-14T00:00:00Z" } });
  const search = await append("disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH, SEARCH_FIELDS));
  await ok(search);
  await append("observed", {
    disclosure_seq: search.seq,
    endpoint: "searchCatalog",
    offers_count: 3,
    offers_hidden: 0,
    offers: [offer(1, "Budget Running Shoe", "Resale Hub", 3999), offer(2, "Road Runner 2", "Road Runners", 6300), offer(3, "Trail Runner 3", "Trailhead", 8999)],
  });
  await append("block", { endpoint: "searchCatalog", fields: SEARCH_FIELDS, blocked: ["categories.block at category"], held: { category: "alcohol" } });
  for (const [n, title, merchant, total, handle, state] of [
    [1, "Budget Running Shoe", "Resale Hub", 4198, "ap_Jzpm00000000KSG1", "approved"],
    [2, "Road Runner 2", "Road Runners", 6499, "ap_po2000000000qmW2", "rejected"],
  ] as const) {
    const cart = await append("disclosure", disclosure("createCart", "POST", "/v1/carts", { offer_handle: `of_${String(n).repeat(20)}`, quantity: 1, ship_to: SEARCH.ship_to }, CART_FIELDS));
    await ok(cart, 201);
    await append("observed", { disclosure_seq: cart.seq, endpoint: "createCart", title, merchant, quantity: 1, total_minor: total, currency: "USD" });
    const ask = await append("disclosure", disclosure("createApproval", "POST", `/v1/carts/ct_${String(n)}/approvals`, null));
    await ok(ask, 201);
    await append("observed", { disclosure_seq: ask.seq, endpoint: "createApproval", approval_handle: handle, state: "pending", title, merchant, quantity: 1, total_minor: total, currency: "USD" });
    await append("approval_pending", { handle, approval_url: "http://127.0.0.1:8788/confirm/c/x", total_minor: total });
    const status = await append("disclosure", disclosure("getApproval", "GET", `/v1/approvals/${handle}`, null));
    await ok(status);
    await append("observed", { disclosure_seq: status.seq, endpoint: "getApproval", approval_handle: handle, state, title, merchant, total_minor: total, currency: "USD" });
    if (state === "approved") {
      await append("approver_pin", { fingerprint: "f502 1111 2222 8c9f", handle });
      await append("approval", { handle });
    }
  }
  await store.close();
}

async function observedChain(): Promise<{ items: unknown[]; dir: string }> {
  const dir = join(mkdtempSync(join(tmpdir(), "log-observed-")), "demo");
  await writeObservedFlow(dir);
  return { items: readLog(dir), dir };
}

const PLAIN = { color: false, utc: true } as const;

interface JsonLine {
  v: number;
  action: string;
  outcome: string;
  facts: Record<string, unknown>;
  requests: { observed: unknown }[];
}

describe("intent log with observations (golden)", () => {
  it("the timeline shows what came back: offers, product, merchant, total, the approval state and a rejection", async () => {
    const { items } = await observedChain();
    expect(formatLog(items, { style: PLAIN, dataDir: "/home/u/.local/share/intent-gateway/demo", home: "/home/u", intent: "intent" })).toMatchInlineSnapshot(`
      "intent log · DEMO (test keys) · ~/.local/share/intent-gateway/demo · 28 entries

      Friday 16 October 2026 (UTC)
      17:26:45  keys      keys signed by cloud-root-1 · valid until 2027-01-14  ✓ recorded
      17:26:49  search    running shoes · under $120 · ZIP 94103                → 3 offers · ✓ receipt
      17:27:01  blocked   search for "alcohol": category excluded by your gateway policy  ✗ nothing sent
      17:27:05  cart      Budget Running Shoe ×1 · $41.98 · Resale Hub          → approval link  ✓ 2 receipts
      17:27:33  status    approval ap_Jzpm…KSG1                                 → Intent Cloud says approved · ✓ receipt
      17:27:45  approved  $41.98 · passkey f502…8c9f (pinned now)               ✓ passkey proof checked
      17:27:53  cart      Road Runner 2 ×1 · $64.99 · Road Runners              → approval link  ✓ 2 receipts
      17:28:21  rejected  $64.99 · Road Runner 2 · approval ap_po20…qmW2        → Intent Cloud says rejected · ✓ receipt

      Sent to Intent Cloud only: category, budget, offer, quantity, ZIP code, country.
      No buyer name, address or card field was sent.
      Free text is sent as written: a name in it cannot be detected.

      8 actions · 1 search · 2 carts · 2 status checks · 1 approval · 1 blocked · 7 receipts
      Details: intent log --demo -v · Machine-readable: intent log --demo --json · Integrity: intent verify --demo
      "
    `);
  });

  it("-v lists each observation as returned by Intent Cloud, recorded here and never sent, with the offers", async () => {
    const { items } = await observedChain();
    const out = formatVerbose(items, { style: PLAIN });
    expect(out).toContain("returned       #2, returned by Intent Cloud (recorded here, never sent): 3 offers\n");
    expect(out).toContain(`offer of_${"1".repeat(20)}: Budget Running Shoe, Resale Hub, $39.99 + $1.99 shipping\n`);
    expect(out).toContain("returned       #6, returned by Intent Cloud (recorded here, never sent): cart: Budget Running Shoe x1, $41.98, Resale Hub\n");
    expect(out).toContain("approval ap_po2000000000qmW2 rejected: Road Runner 2, $64.99, Road Runners\n");
    expect(out).toContain('held back categories.block at category (category = "alcohol", kept here only); nothing was sent\n');
    expect(out).toMatchSnapshot();
  });

  it("--json is v2: each request carries its observation, the facts what came back; the rejected status is its outcome", async () => {
    const { items } = await observedChain();
    const lines = formatJson(items).trimEnd().split("\n").map((l) => JSON.parse(l) as JsonLine);
    expect(lines.every((l) => l.v === 2)).toBe(true);
    expect(lines.map((l) => [l.action, l.outcome])).toEqual([
      ["keys", "recorded"],
      ["search", "acknowledged"],
      ["blocked", "blocked"],
      ["cart", "approval_asked"],
      ["status", "acknowledged"],
      ["approval", "approved"],
      ["cart", "approval_asked"],
      ["status", "rejected"],
    ]);
    const [, search, blocked, cart, , , , rejected] = lines;
    expect(search?.facts).toMatchObject({ offers_count: 3, offers_hidden: 0 });
    expect(search?.requests[0]?.observed).toMatchObject({ seq: 4, endpoint: "searchCatalog", offers_count: 3 });
    expect(blocked?.facts.held).toEqual({ category: "alcohol" });
    expect(cart?.facts).toMatchObject({ title: "Budget Running Shoe", merchant: "Resale Hub", total_minor: 4198, approval_state: "approved" });
    expect(rejected?.facts).toMatchObject({ approval_state: "rejected", title: "Road Runner 2" });
    expect(lines[6]?.facts.approval_state).toBe("rejected");
  });
});

describe("intent log -v with a 1.6.0 outcome", () => {
  it("names the outcome as served and the order it names (plan G4 test 7)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "log-outcome-")), "demo");
    const store = await openStore(dir, { clock: () => TS });
    const status = await store.append("disclosure", disclosure("getApproval", "GET", "/v1/approvals/ap_TEST0003", null));
    await store.append("receipt", { disclosure_seq: status.seq, status: 200, verified: true });
    await store.append("observed", {
      disclosure_seq: status.seq,
      endpoint: "getApproval",
      approval_handle: "ap_TEST0003",
      state: "ordered",
      outcome_state: "ordered",
      outcome: { state: "ordered", source: "signed_webhook", assurance: "verified", order_ref: "ORD-100001", final_total_minor: 12500, binding_result: "ok" },
      order_number: "ORD-100001",
      title: "Trail Runner 3",
      merchant: "Trailhead",
      total_minor: 12500,
      currency: "USD",
    });
    await store.close();
    expect(formatVerbose(readLog(dir), { style: PLAIN })).toContain(
      "approval ap_TEST0003 ordered: Trail Runner 3, $125.00, Trailhead; outcome as served: ordered (signed_webhook, verified), order ORD-100001\n",
    );
  });
});

describe("the footer prints the real invocation", () => {
  it("a short invocation goes before each command; a long one is named once on its own line; neither is cut", async () => {
    const { items } = await observedChain();
    const short = formatLog(items, { style: PLAIN, intent: "npx -y intent-gateway@next" });
    expect(short).toContain(
      "Details: npx -y intent-gateway@next log --demo -v · Machine-readable: npx -y intent-gateway@next log --demo --json · Integrity: npx -y intent-gateway@next verify --demo\n",
    );
    expect(short).not.toContain("<intent>");
    const path = "node /home/u/src/intent-gateway/dist/main.js";
    const long = formatLog(items, { style: { ...PLAIN, columns: 90 }, intent: path });
    expect(long).toMatch(/\nDetails: log --demo -v · Machine-readable: log --demo --json · Integrity: verify --demo\nRun each as: node \/home\/u\/src\/intent-gateway\/dist\/main\.js <command>\n$/);
    expect(formatLog(items, { style: PLAIN, intent: path })).toContain("\nDetails: log --demo -v · Machine-readable: log --demo --json · Integrity: verify --demo\nRun each as: ");
    // On a terminal too narrow for one footer line, each command gets its own, whole.
    const narrow = formatLog(items, { style: { ...PLAIN, columns: 50 }, intent: "intent" });
    expect(narrow).toMatch(/\nDetails: intent log --demo -v\nMachine-readable: intent log --demo --json\nIntegrity: intent verify --demo\n$/);
    // The other lines are cut to the terminal's width, the footer is not.
    expect(long.split("\n").find((l) => l.includes("blocked"))?.length).toBeLessThanOrEqual(90);
  });
});

describe("intent log -v on an offer whose shipping is quoted at the cart", () => {
  it("says shipping is quoted at the cart for a max offer, never $0.00, and keeps the amount for an exact one", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "log-max-")), "data");
    const store = await openStore(dir, { clock: () => TS });
    await store.append("session", DEMO_SESSION);
    const search = await store.append("disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH, SEARCH_FIELDS));
    await store.append("receipt", { disclosure_seq: search.seq, status: 200, verified: true });
    await store.append("observed", {
      disclosure_seq: search.seq,
      endpoint: "searchCatalog",
      offers_count: 2,
      offers_hidden: 0,
      offers: [{ ...offer(1, "Test Tee", "tees.example", 100), shipping_minor: 0, total_kind: "max" }, offer(2, "Road Runner 2", "Road Runners", 6300)],
    });
    await store.close();
    const out = formatVerbose(readLog(dir));
    expect(out).toContain("Test Tee, tees.example, $1.00 + shipping quoted at cart");
    expect(out).not.toContain("$1.00 + $0.00 shipping");
    expect(out).toContain("Road Runner 2, Road Runners, $63.00 + $1.99 shipping");
  });
});
