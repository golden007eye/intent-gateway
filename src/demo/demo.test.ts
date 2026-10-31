// Demo mode end to end and its guards.
// - Flow: startDemo → find_offers → create_cart → Approve on the local confirm page (an HTTP POST) →
//   get_approval_status = approved → runVerify exit 0 over the demo data dir; every tool result carries the banner.
// - Confirm page: CSP, loopback bind, no approval by GET, CSRF token required (missing, wrong, other page, reused),
//   foreign Host/Origin/Sec-Fetch-Site refused, no external URL or inline handler; Approve needs the demo code
//   (missing, wrong, five or seven digits refused; spaces, hyphens, words around it accepted; a wrong one shows the
//   form again with the error and the tries left; locked after MAX_WRONG_CODES), asked for as a one-time code, kept
//   0600, new on every start and never in a tool result.
// - Separation: a demo chain and a real chain never mix (both ways); demo mode refuses any root but the published
//   test root; the test root is never in PINNED_HOSTS; the demo passkey is stable per data dir.
// - Port: the confirm page listens on the port asked for, falls back to a free one only when told to, and the next
//   steps name its address with the ssh -L forward (and the taken port, after a fallback).
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freePort } from "../cloud-fake/index.ts";
import { ensureAccountKey } from "../account/index.ts";
import type { SnapshotV3 } from "../contract/index.ts";
import { PINNED_HOSTS } from "../config/index.ts";
import { connectCloud } from "../disclosure/index.ts";
import { createGateway, DEMO_SESSION, type Gateway, GatewayStartError } from "../gateway/index.ts";
import { type HttpHandle, runHttp } from "../mcp/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { createSession, openCompleterKeys } from "../signing/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { isTestRoot, type PinnedRootKey, TEST_ROOT_KEY } from "../trust/index.ts";
import { formatReport, runVerify } from "../verify/index.ts";
import { SHIPPING_MINOR } from "../wallet-shop-fake/index.ts";
import { CONFIRM_CSP, type Demo, DEMO_BANNER, demoDataDir, demoTrustKeys, MAX_WRONG_CODES, nextSteps, startDemo } from "./index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SHOES = { category: "running-shoes", budget: 200, country: "US", postcode: "94103" };
const POLICY = "version: 1\napproval: passkey\n";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.reverse()) await run();
  cleanup = [];
});

async function tmpData(): Promise<string> {
  return join(await fsp.mkdtemp(join(tmpdir(), "demo-")), "data");
}

async function demoAt(dataDir: string): Promise<Demo> {
  const demo = await startDemo({ dataDir });
  cleanup.push(() => demo.close());
  return demo;
}

async function gatewayOver(
  demo: Demo,
  options: { dir?: string; demoMode?: boolean; pins?: PinnedRootKey[]; confirmBaseUrl?: string; oneTap?: boolean } = {},
): Promise<{ gateway: Gateway; store: Store }> {
  const store = await openStore(options.dir ?? demo.dataDir);
  cleanup.push(() => store.close());
  const session = createSession();
  const gateway = createGateway({
    cloud: (keySet) => connectCloud({ baseUrl: demo.cloudUrl, session }, store, { keySet }),
    store,
    completerKeys: openCompleterKeys(options.dir ?? demo.dataDir),
    ...(options.oneTap === true ? { oneTap: demo.oneTap, accountKey: async () => (await ensureAccountKey(options.dir ?? demo.dataDir)).key } : {}),
    policy: loadPolicy(POLICY),
    pinnedRootKeys: options.pins ?? demo.trustKeys.rootKeys,
    ...(options.demoMode === false
      ? {}
      : { demo: { confirmBaseUrl: options.confirmBaseUrl ?? demo.confirmBaseUrl, catalogNote: demo.catalogNote } }),
    logger: { warn: () => undefined },
  });
  return { gateway, store };
}

/** A pending demo approval through the gateway; returns its local approval link. */
async function pendingApproval(gateway: Gateway): Promise<{ url: string; handle: string }> {
  const found = await gateway.findOffers(SHOES);
  if (found.status !== "offers" || found.offers[0] === undefined) throw new Error(`no offers: ${found.message}`);
  const cart = await gateway.createCart({ offer_handle: found.offers[0].offer_handle });
  if (cart.status !== "approval_needed") throw new Error(`no approval: ${cart.message}`);
  return { url: cart.approval_url, handle: cart.approval_handle };
}

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: options.method ?? "GET", headers: { host: u.host, ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const csrfOf = (html: string): string => /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? "";
const post = (url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Raw> =>
  raw(url, { method: "POST", headers: { ...FORM, ...headers }, body: new URLSearchParams(form).toString() });

const texts = (result: CallToolResult): string[] => result.content.flatMap((c) => (c.type === "text" ? [c.text] : []));

describe("demo flow", () => {
  it("find → cart → Approve on the local page → approved → verify exit 0, with the banner on every tool result", async () => {
    const data = await tmpData();
    const demo = await demoAt(data);
    expect(demo.dataDir).toBe(join(data, "demo"));
    expect(demo.confirmBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/confirm$/);
    const { gateway, store } = await gatewayOver(demo);
    await gateway.start();
    expect(store.entries()[0]).toMatchObject({ seq: 0, kind: "session", body: DEMO_SESSION });

    const http: HttpHandle = await runHttp({ gateway, host: "127.0.0.1", port: 0, token: null, banner: DEMO_BANNER, log: () => undefined });
    cleanup.push(() => http.close());
    const client = new Client({ name: "demo-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)) as Transport);
    cleanup.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.content[0]).toEqual({ type: "text", text: DEMO_BANNER });
      return result;
    };

    const offers = texts(await call("find_offers", SHOES)).join("\n");
    const offer = /offer_handle: (\S+)/.exec(offers)?.[1] ?? "";
    const cart = texts(await call("create_cart", { offer_handle: offer })).join("\n");
    const link = /Approval link: (\S+)/.exec(cart)?.[1] ?? "";
    expect(link.startsWith(`${demo.confirmBaseUrl}/c/`)).toBe(true);
    const handle = /approval_handle: (\S+)/.exec(cart)?.[1] ?? "";
    expect(texts(await call("get_approval_status", { approval_handle: handle })).join("\n")).not.toContain("fingerprint");
    // The banner also leads a failed call.
    expect((await call("no_such_tool", {})).isError).toBe(true);

    const page = await raw(link);
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/>Approve \$\d+\.\d\d with demo passkey</);
    expect(page.body).toContain("ZIP 94103");
    expect(page.body).toContain(DEMO_BANNER);
    expect(page.body).toContain(`cat ${demo.codeFile}`);
    // The read-the-code hint is folded away behind a disclosure, so it does not clutter the card.
    expect(page.body).toMatch(/<details class="hint more"><summary>Can't see the code\?<\/summary><p>If your agent started the gateway, read the code with <code class="cmd">cat [^<]+<\/code><\/p><\/details>/);
    const done = await post(link, { csrf: csrfOf(page.body), action: "approve", code: demo.code }, { origin: new URL(link).origin, "sec-fetch-site": "same-origin" });
    expect(done.status).toBe(200);
    expect(done.body).toContain("<h1>Approved</h1><p>Approved with the demo passkey. Nothing is bought in demo mode.</p>");
    expect(done.body).toContain("<strong>Next step</strong>Go back to your agent and ask it to check the approval status.");
    expect(done.body.split("Approved with the demo passkey").length - 1).toBe(1);
    expect(done.body).toContain(DEMO_BANNER);

    const status = texts(await call("get_approval_status", { approval_handle: handle })).join("\n");
    expect(status).toContain("Approver passkey fingerprint:");
    // The demo code reaches the person through the gateway's stderr and its file, never through a tool result.
    for (const text of [offers, cart, status]) expect(text).not.toContain(demo.code);
    // The cart message names the button exactly as the confirm page labels it.
    const label = /click "(Approve \$[0-9,]+\.[0-9]{2} with demo passkey)" \(enter the demo code: the page shows the command that prints it\)/.exec(cart)?.[1] ?? "";
    expect(label).not.toBe("");
    expect(page.body).toContain(`>${label}<`);
    // The message says the page shows the command that prints the demo code: it does.
    expect(page.body).toContain("read the code with <code class=\"cmd\">");
    expect(cart).not.toMatch(/phone/);
    expect(store.entries().map((e) => e.kind)).toContain("approval");

    await store.close();
    const report = await runVerify({ dataDir: demo.dataDir, pinnedRootKeys: demoTrustKeys().rootKeys, now: new Date(), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.counts.approvals).toBe(1);
    expect(formatReport(report)).toContain("acknowledged by a receipt from the local demo Intent Cloud (demo log, test keys): ");
    expect(formatReport(report)).not.toContain("public edge");
  });

  it("one-tap (plan G7c): the sticker is completed by the gateway with the demo Shop wallet → ordered, the banner on every result", async () => {
    const demo = await demoAt(await tmpData());
    const { gateway, store } = await gatewayOver(demo, { oneTap: true });
    await gateway.start();
    const http: HttpHandle = await runHttp({ gateway, host: "127.0.0.1", port: 0, token: null, banner: DEMO_BANNER, log: () => undefined });
    cleanup.push(() => http.close());
    const client = new Client({ name: "demo-one-tap", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)) as Transport);
    cleanup.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.content[0]).toEqual({ type: "text", text: DEMO_BANNER });
      return texts(result).join("\n");
    };
    const offers = await call("find_offers", { category: "stickers", budget: 20, country: "US", postcode: "94107" });
    const offer = /offer_handle: (\S+)/.exec(offers)?.[1] ?? "";
    const cart = await call("create_cart", { offer_handle: offer });
    const link = /Approval link: (\S+)/.exec(cart)?.[1] ?? "";
    const handle = /approval_handle: (\S+)/.exec(cart)?.[1] ?? "";
    const page = await raw(link);
    const done = await post(link, { csrf: csrfOf(page.body), action: "approve", code: demo.code }, { origin: new URL(link).origin, "sec-fetch-site": "same-origin" });
    expect(done.body).toContain("Your gateway completes payment with demo Shop; check your agent.");
    const status = await call("get_approval_status", { approval_handle: handle });
    expect(status).toContain("One-tap: ordered (read from Shop), order gid://shopify/Order/");
    expect(status).toContain("Shop reported the order");
    expect(demo.shop.completeCount).toBe(1);
    // Contract 1.7.0: the gateway submitted the Shop checkout it made (POST /v1/checkouts), and no cart.
    expect(demo.cloud.checkouts.received).toHaveLength(1);
    expect(cart).toContain("Shop checkout: 1 × ");
    await store.close();
    const report = await runVerify({ dataDir: demo.dataDir, pinnedRootKeys: demoTrustKeys().rootKeys, now: new Date(), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it("one-tap buys every offer the demo lists, each checkout with the picked item's title and price (the Vinyl sheet at paper.example too)", async () => {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo, { oneTap: true });
    await gateway.start();
    const found = await gateway.findOffers({ category: "stickers", budget: 20, country: "US", postcode: "94107" });
    if (found.status !== "shop_offers") throw new Error(`no Shop offers: ${found.message}`);
    expect(found.offers.map((o) => `${o.title} at ${o.store}`).sort()).toEqual(["Holographic sticker at stickers.example", "Vinyl sticker sheet at paper.example"]);
    for (const [i, offer] of found.offers.entries()) {
      const cart = await gateway.createCart({ offer_handle: offer.offer_handle });
      if (cart.status !== "approval_needed") throw new Error(`${offer.title}: no approval: ${cart.message}`);
      const sent = demo.cloud.checkouts.received[i] as { checkout: { title: string; totals: { subtotal: number; shipping: number; total: number } } };
      expect(sent.checkout.title).toBe(offer.title);
      expect(sent.checkout.totals.subtotal).toBe(offer.price.amount_minor);
      expect(sent.checkout.totals.total).toBe(offer.price.amount_minor + SHIPPING_MINOR);
      const page = await raw(cart.approval_url);
      const done = await post(cart.approval_url, { csrf: csrfOf(page.body), action: "approve", code: demo.code }, { origin: new URL(cart.approval_url).origin, "sec-fetch-site": "same-origin" });
      expect(done.body).toContain("Your gateway completes payment with demo Shop; check your agent.");
      const status = await gateway.getApprovalStatus({ approval_handle: cart.approval_handle });
      expect(status.message).toContain("Shop reported the order (order gid://shopify/Order/");
    }
    expect(demo.shop.completeCount).toBe(found.offers.length);
  });

  it("rejects with the demo passkey", async () => {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo);
    await gateway.start();
    const { url, handle } = await pendingApproval(gateway);
    const page = await raw(url);
    const rejected = (await post(url, { csrf: csrfOf(page.body), action: "reject" })).body;
    expect(rejected).toContain("<h1>Rejected</h1><p>You rejected this purchase. Nothing was approved.</p>");
    expect(rejected).toContain("<strong>Next step</strong>Go back to your agent and ask it to check the approval status.");
    expect(rejected.split("Rejected").length - 1).toBe(2); // the <title> and the heading, not the paragraph too
    expect(rejected).toContain(DEMO_BANNER);
    expect(demo.cloud.inspect(handle)?.state).toBe("rejected");
    const after = await raw(url);
    expect(after.body).not.toContain('name="csrf"');
    expect(after.body).toContain("This purchase was rejected.");
  });
});

describe("the sample catalog through the demo gateway", () => {
  async function started(): Promise<{ demo: Demo; gateway: Gateway }> {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo);
    await gateway.start();
    return { demo, gateway };
  }

  it("a developer's first prompt finds offers: stainless water bottle around 1 liter, ZIP 10001, budget $40", async () => {
    const { gateway } = await started();
    for (const asked of [
      { category: "water bottles", must_haves: ["stainless", "around 1 liter"] },
      { product: "stainless water bottle around 1 liter" },
      { category: "drinkware", product: "Stainless Steel Water Bottle", must_haves: ["1L"] },
    ]) {
      const found = await gateway.findOffers({ ...asked, budget: 40, country: "US", postcode: "10001" });
      expect(found.status, JSON.stringify(asked)).toBe("offers");
      if (found.status !== "offers") continue;
      expect(found.offers.length, JSON.stringify(asked)).toBeGreaterThanOrEqual(2);
      for (const offer of found.offers) expect(offer.price.amount_minor + offer.shipping.amount_minor).toBeLessThanOrEqual(4000);
      expect(found.message).not.toContain("The demo catalog has");
    }
  });

  it("each everyday category a developer tries first finds something", async () => {
    const { gateway } = await started();
    for (const category of ["running shoes", "headphones", "coffee", "backpacks", "phone accessories", "books", "toys", "home", "office supplies", "camping", "pet supplies", "beauty", "gifts"]) {
      const found = await gateway.findOffers({ category, budget: 200, country: "US", postcode: "10001" });
      expect(found.status === "offers" ? found.offers.length : 0, category).toBeGreaterThan(0);
    }
  });

  it("a search that finds nothing still returns 0 offers, and says what the demo catalog has", async () => {
    const { demo, gateway } = await started();
    const found = await gateway.findOffers({ category: "lawnmowers", budget: 400, country: "US", postcode: "10001" });
    expect(found.status).toBe("offers");
    if (found.status !== "offers") return;
    expect(found.offers).toEqual([]);
    expect(found.message).toBe(`0 offers. ${demo.catalogNote}`);
    expect(demo.catalogNote).toMatch(/^The demo catalog has: running shoes, water bottles, .*headphones.*\.$/);
  });

  it("an excluded category is refused by the baseline before it is sent, and never returned by the demo Intent Cloud", async () => {
    const { demo, gateway } = await started();
    const blocked = await gateway.findOffers({ category: "alcohol", product: "red wine", budget: 50, country: "US", postcode: "10001" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.summary).toBe("Sent: nothing / Blocked: a blocked category (alcohol, in the category); a blocked category (alcohol, in the product)");
    // Attack: a product-only search whose words name no excluded keyword is sent (the policy names no category block),
    // but the demo Intent Cloud, like Intent Cloud, never returns an item in an excluded category.
    for (const product of ["Cabernet Sauvignon", "Vitamin D3 Gummies", "Premium Cigars", "Store Gift Card", "Folding Hunting Knife"]) {
      const found = await gateway.findOffers({ product, budget: 100, country: "US", postcode: "10001" });
      expect(found.status === "offers" ? found.offers.map((o) => o.title) : [], product).not.toContain(product);
    }
    const none = await gateway.findOffers({ product: "Cabernet Sauvignon", budget: 100, country: "US", postcode: "10001" });
    expect(none.message).toContain(demo.catalogNote);
  });

  it("outside demo mode the gateway adds no catalog line", async () => {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo, { dir: await tmpData(), demoMode: false });
    await gateway.start();
    const found = await gateway.findOffers({ category: "lawnmowers", budget: 400, country: "US", postcode: "10001" });
    expect(found.message).toBe("0 offers.");
  });
});

describe("confirm page", () => {
  async function pending(): Promise<{ demo: Demo; url: string; handle: string; gateway: Gateway }> {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo);
    await gateway.start();
    return { demo, gateway, ...(await pendingApproval(gateway)) };
  }

  it("serves the strict CSP with no external asset, and binds 127.0.0.1 only", async () => {
    const { url } = await pending();
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const page = await raw(url);
    expect(page.headers["content-security-policy"]).toBe(CONFIRM_CSP);
    expect(CONFIRM_CSP).toContain("default-src 'none'");
    expect(CONFIRM_CSP).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    // A browser sends `Origin: null` on a form POST under no-referrer, and the Origin check would refuse every click.
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.body).not.toMatch(/(src|href)="https?:/);
    expect(page.body).not.toMatch(/https?:\/\//);
    expect(page.body).not.toMatch(/\son[a-z]+=|style=/i);
    // One inline script, allowed by its hash only: no src, no 'unsafe-inline'.
    const scripts = [...page.body.matchAll(/<script([^>]*)>([^<]*)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toBe("");
    const hash = createHash("sha256").update(scripts[0]?.[2] ?? "").digest("base64");
    expect(CONFIRM_CSP).toContain(`script-src 'sha256-${hash}';`);
    expect(CONFIRM_CSP).not.toMatch(/unsafe|script-src[^;]*'self'|font-src|connect-src/);
    const css = await raw(new URL("/confirm/style.css", url).href);
    expect(css.status).toBe(200);
    expect(css.headers["content-security-policy"]).toBe(CONFIRM_CSP);
    // Not reachable on another local address.
    await expect(raw(url.replace("127.0.0.1", "127.0.0.2"))).rejects.toThrow();
  });

  it("never approves on a GET, even with a valid token in the query", async () => {
    const { url, demo, handle } = await pending();
    const token = csrfOf((await raw(url)).body);
    const got = await raw(`${url}?action=approve&csrf=${token}`);
    expect(got.status).toBe(200);
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
  });

  it("refuses a POST without, or with a wrong, reused or other page's token (CSRF)", async () => {
    const { url, demo, handle, gateway } = await pending();
    expect((await post(url, { action: "approve" })).status).toBe(403);
    expect((await post(url, { action: "approve", csrf: "A".repeat(43) })).status).toBe(403);
    // A JSON body is not the page's form.
    const token = csrfOf((await raw(url)).body);
    expect((await raw(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ csrf: token, action: "approve" }) })).status).toBe(403);
    // A token from another approval's page.
    const other = await pendingApproval(gateway);
    const otherToken = csrfOf((await raw(other.url)).body);
    expect((await post(url, { action: "approve", csrf: otherToken })).status).toBe(403);
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
    // A used token cannot be replayed.
    const fresh = csrfOf((await raw(url)).body);
    expect((await post(url, { action: "nothing", csrf: fresh })).status).toBe(400);
    expect((await post(url, { action: "approve", csrf: fresh })).status).toBe(403);
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
  });

  it("refuses a foreign Host (421), a foreign Origin or cross-site fetch (403), other methods (405), unknown links (404)", async () => {
    const { url, demo, handle } = await pending();
    const token = (): Promise<string> => raw(url).then((p) => csrfOf(p.body));
    expect((await raw(url, { headers: { host: "evil.example" } })).status).toBe(421);
    expect((await post(url, { action: "approve", csrf: await token() }, { origin: "http://evil.example" })).status).toBe(403);
    // A sandboxed or no-referrer page sends Origin: null; still refused.
    expect((await post(url, { action: "approve", csrf: await token() }, { origin: "null" })).status).toBe(403);
    expect((await post(url, { action: "approve", csrf: await token() }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const put = await raw(url, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe("GET, POST");
    expect((await raw(url.replace(/\/c\/.*$/, "/c/unknown"))).status).toBe(404);
    expect((await raw(new URL("/", url).href)).status).toBe(404);
    expect((await post(url, { action: "approve", csrf: (await token()) + "x".repeat(5000) })).status).toBe(403);
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
  });
});

describe("the demo code", () => {
  async function pending(): Promise<{ demo: Demo; url: string; handle: string }> {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo);
    await gateway.start();
    return { demo, ...(await pendingApproval(gateway)) };
  }
  const approve = async (url: string, code?: string): Promise<Raw> =>
    post(url, { csrf: csrfOf((await raw(url)).body), action: "approve", ...(code === undefined ? {} : { code }) });

  it("refuses Approve without the code or with a wrong one, as a local script would send it (attack)", async () => {
    const { demo, url, handle } = await pending();
    const missing = await approve(url);
    expect(missing.status).toBe(403);
    expect(missing.body).toContain("That is not the demo code");
    const wrong = String((Number(demo.code) + 1) % 1_000_000).padStart(6, "0");
    expect((await approve(url, wrong)).status).toBe(403);
    expect((await approve(url, `${demo.code}0`)).status).toBe(403);
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
    const right = await approve(url, ` ${demo.code} `);
    expect(right.status).toBe(200);
    expect(demo.cloud.inspect(handle)?.state).toBe("approved");
  });

  it("accepts the code typed or pasted with spaces, hyphens, words or full-width digits: only its digits count", async () => {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo);
    await gateway.start();
    const c = demo.code;
    const fullWidth = c.replace(/[0-9]/g, (d) => String.fromCodePoint(0xff10 + Number(d)));
    for (const typed of [`${c.slice(0, 3)} ${c.slice(3)}`, `${c.slice(0, 3)}-${c.slice(3)}`, ` ${c}\n`, `Demo code: ${c}`, fullWidth]) {
      const { url, handle } = await pendingApproval(gateway);
      const done = await approve(url, typed);
      expect(done.status, JSON.stringify(typed)).toBe(200);
      expect(demo.cloud.inspect(handle)?.state).toBe("approved");
    }
  });

  it("refuses five or seven digits and a code with an extra digit in its text, counting each as a wrong try (attack)", async () => {
    const { demo, url, handle } = await pending();
    const c = demo.code;
    const tries = [c.slice(0, 5), `${c}1`, `${c} (1)`];
    for (const [i, typed] of tries.entries()) {
      const got = await approve(url, typed);
      expect(got.status).toBe(403);
      expect(got.body).toContain(`${String(MAX_WRONG_CODES - 1 - i)} tries left`);
    }
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
  });

  it("shows a wrong code as an error under the field, on the form again with a fresh token and the tries left", async () => {
    const { demo, url, handle } = await pending();
    const wrong = String((Number(demo.code) + 1) % 1_000_000).padStart(6, "0");
    const first = await approve(url, wrong);
    expect(first.status).toBe(403);
    expect(first.body).toMatch(/<p class="error" id="code-error" role="alert"><svg[^]*?<\/svg><span>That is not the demo code\. 4 tries left\.<\/span><\/p>/);
    expect(first.body).toContain('<div class="code dash invalid">');
    expect(first.body).toMatch(/<input id="code"[^>]* aria-describedby="code-error code-hint" aria-invalid="true" autofocus>/);
    // The typed code is not echoed back.
    expect(first.body).not.toContain(`value="${wrong}"`);
    expect(first.body).toContain('id="approve"');
    const short = await post(url, { csrf: csrfOf(first.body), action: "approve", code: "12" });
    expect(short.body).toContain("That is not the demo code (it has 6 digits; this had 2). 3 tries left.");
    let last = short;
    for (const left of [2, 1]) {
      last = await post(url, { csrf: csrfOf(last.body), action: "approve", code: wrong });
      expect(last.body).toContain(`${String(left)} ${left === 1 ? "try" : "tries"} left.`);
    }
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
    // The re-rendered form's token works: the right code approves on the last try.
    const right = await post(url, { csrf: csrfOf(last.body), action: "approve", code: demo.code });
    expect(right.status).toBe(200);
    expect(demo.cloud.inspect(handle)?.state).toBe("approved");
  });

  it("asks for a one-time code with a numeric keyboard and no pattern or length cap that would block a paste", async () => {
    const { url } = await pending();
    const field = /<input id="code"[^>]*>/.exec((await raw(url)).body)?.[0] ?? "";
    expect(field).toContain('autocomplete="one-time-code"');
    expect(field).toContain('inputmode="numeric"');
    expect(field).toContain('aria-describedby="code-hint"');
    expect(field).not.toMatch(/pattern=|maxlength=|aria-invalid/);
  });

  it("locks Approve after MAX_WRONG_CODES wrong codes, even for the right code, until the demo restarts", async () => {
    const { demo, url, handle } = await pending();
    const wrong = String((Number(demo.code) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < MAX_WRONG_CODES; i += 1) expect((await approve(url, wrong)).status).toBe(403);
    const locked = await approve(url, demo.code);
    expect(locked.status).toBe(403);
    expect(locked.body).toContain("Too many wrong demo codes");
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
    // The locked page has no code field, no Approve button and no script; Reject needs no code and still works.
    const page = (await raw(url)).body;
    expect(page).toContain("Too many wrong demo codes");
    expect(page).not.toMatch(/id="code"|value="approve"|<script/);
    const rejected = await post(url, { csrf: csrfOf(page), action: "reject" });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toContain("<h1>Rejected</h1>");
    expect(rejected.body).toContain("Go back to your agent and ask it to check the approval status.");
  });

  it("draws six aria-hidden boxes over one real input, and shows the receipt: total, lines, check code, approval", async () => {
    const { demo, url, handle } = await pending();
    const body = (await raw(url)).body;
    const view = demo.cloud.inspect(handle);
    if (view === undefined) throw new Error("no approval");
    expect(body.match(/<input id="code"/g)).toHaveLength(1);
    expect(body).toContain(`<div class="boxes" aria-hidden="true">${'<span class="box"></span>'.repeat(6)}</div>`);
    expect(body).toContain('<label for="code">');
    const total = `$${((view.snapshot as SnapshotV3).total.amount_minor / 100).toFixed(2)}`;
    expect(body).toContain(`<span class="v">${total}</span>`);
    expect(body).toContain(`>Approve ${total} with demo passkey</button>`);
    expect(body).toContain(`${String(view.snapshot.quantity)} × ${(view.snapshot as SnapshotV3).item.title}`);
    const check = view.snapshot_hash.slice(0, 8);
    expect(body).toContain(`<span>${check.slice(0, 4)}</span><span>${check.slice(4)}</span>`);
    expect(body).toContain(`title="${handle}"`);
    expect(body).toContain("DEMO · nothing can be bought");
    // A settled approval shows its state and the next step, with no form.
    await approve(url, demo.code);
    const after = (await raw(url)).body;
    expect(after).toContain("<h1>Already approved</h1>");
    expect(after).toContain("<strong>Next step</strong>");
    expect(after).not.toContain("<form");
  });

  it("is six digits, kept 0600 in <data>/demo/approval-code, and new on every start", async () => {
    const data = await tmpData();
    const a = await demoAt(data);
    expect(a.code).toMatch(/^[0-9]{6}$/);
    expect(a.codeFile).toBe(join(demoDataDir(data), "approval-code"));
    expect(await fsp.readFile(a.codeFile, "utf8")).toBe(`${a.code}\n`);
    expect((await fsp.stat(a.codeFile)).mode & 0o777).toBe(0o600);
    const codes = new Set([a.code]);
    for (let i = 0; i < 3; i += 1) codes.add((await demoAt(data)).code);
    expect(codes.size).toBeGreaterThan(1);
  });

  it("shows the command that reads the code file (docker exec in the image)", async () => {
    const demo = await startDemo({ dataDir: await tmpData(), readCommand: "docker exec <container> cat" });
    cleanup.push(() => demo.close());
    const { gateway } = await gatewayOver(demo);
    await gateway.start();
    const { url } = await pendingApproval(gateway);
    expect((await raw(url)).body).toContain(`docker exec &#60;container&#62; cat ${demo.codeFile}`);
  });
});

describe("the confirm page in the Docker image (bind 0.0.0.0)", () => {
  it("still links to 127.0.0.1 and still answers only to that Host", async () => {
    const demo = await startDemo({ dataDir: await tmpData(), bind: "0.0.0.0" });
    cleanup.push(() => demo.close());
    expect(demo.confirmBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/confirm$/);
    const unknown = `${demo.confirmBaseUrl}/c/unknown`;
    expect((await raw(unknown)).status).toBe(404);
    // A request reaching the wildcard bind under another name (a rebinding page, another container) is refused.
    expect((await raw(unknown, { headers: { host: "evil.example" } })).status).toBe(421);
    const port = new URL(demo.confirmBaseUrl).port;
    expect((await raw(unknown, { headers: { host: `0.0.0.0:${port}` } })).status).toBe(421);
  });
});

describe("the confirm page's port (F-n)", () => {
  /** A port some other program holds, on 127.0.0.1, released after the test. */
  async function takenPort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );
    return (server.address() as AddressInfo).port;
  }

  it("listens on the port asked for, on 127.0.0.1", async () => {
    // A port outside the ephemeral range: one listen(0) picked and released could be taken before the demo binds it.
    const port = await freePort();
    const demo = await startDemo({ dataDir: await tmpData(), port, portFallback: true });
    cleanup.push(() => demo.close());
    expect(demo.confirmBaseUrl).toBe(`http://127.0.0.1:${String(port)}/confirm`);
    expect(demo.confirmPortBusy).toBeNull();
  });

  it("falls back to a free port when the port is taken and fallback is on, and says which port was taken", async () => {
    const port = await takenPort();
    const demo = await startDemo({ dataDir: await tmpData(), port, portFallback: true });
    cleanup.push(() => demo.close());
    expect(demo.confirmPortBusy).toBe(port);
    const origin = new URL(demo.confirmBaseUrl);
    expect(origin.hostname).toBe("127.0.0.1");
    expect(origin.port).not.toBe(String(port));
    expect((await raw(`${demo.confirmBaseUrl}/c/unknown`)).status).toBe(404);
  });

  it("fails on a taken port without fallback: a chosen port is never swapped for another", async () => {
    const port = await takenPort();
    await expect(startDemo({ dataDir: await tmpData(), port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("demo and real chains never mix", () => {
  it("demo mode refuses a data dir holding a real chain", async () => {
    const demo = await demoAt(await tmpData());
    const real = await gatewayOver(demo, { demoMode: false });
    await real.gateway.start();
    await real.store.close();
    cleanup.pop();
    const { gateway } = await gatewayOver(demo);
    await expect(gateway.start()).rejects.toThrow(/holds a real chain/);
  });

  it("a normal run refuses a demo chain", async () => {
    const demo = await demoAt(await tmpData());
    const first = await gatewayOver(demo);
    await first.gateway.start();
    await first.store.close();
    cleanup.pop();
    const { gateway, store } = await gatewayOver(demo, { demoMode: false });
    await expect(gateway.start()).rejects.toThrow(GatewayStartError);
    await expect(gateway.start()).rejects.toThrow(/holds a demo chain/);
    // The demo session entry, then the first run's gateway session entry and its start.
    expect(store.entries().map((e) => e.kind)).toEqual(["session", "session", "disclosure", "receipt", "disclosure", "receipt", "keys"]);
  });

  it("a second demo run keeps one demo session entry", async () => {
    const demo = await demoAt(await tmpData());
    const first = await gatewayOver(demo);
    await first.gateway.start();
    await first.store.close();
    cleanup.pop();
    const second = await gatewayOver(demo);
    await second.gateway.start();
    const sessions = second.store.entries().filter((e) => e.kind === "session").map((e) => e.body as { mode?: string; id?: string });
    expect(sessions[0]).toEqual({ mode: "demo" });
    expect(sessions.filter((b) => b.mode === "demo")).toHaveLength(1);
    // Each run starts its own gateway session.
    expect(sessions.slice(1).map((b) => typeof b.id)).toEqual(["string", "string"]);
  });

  it("demo mode refuses a pinned root other than the published test root (a real host's links are never redirected)", async () => {
    const demo = await demoAt(await tmpData());
    const realRoot = { kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) } };
    for (const pins of [[realRoot], [TEST_ROOT_KEY, realRoot], []]) {
      const { gateway, store } = await gatewayOver(demo, { pins });
      await expect(gateway.start()).rejects.toThrow(/only the published test root/);
      expect(store.entries()).toEqual([]);
    }
  });

  it("demo mode refuses a confirm page off 127.0.0.1", async () => {
    const demo = await demoAt(await tmpData());
    for (const confirmBaseUrl of ["https://confirm.example/confirm", "http://localhost:1234/confirm", "http://127.0.0.1:1234/confirm/x"]) {
      const { gateway, store } = await gatewayOver(demo, { confirmBaseUrl });
      await expect(gateway.start()).rejects.toThrow(/127\.0\.0\.1/);
      expect(store.entries()).toEqual([]);
    }
  });
});

describe("demo keys and passkey", () => {
  it("are never pinned for a real host: the demo trusts only the published test root, passed explicitly", async () => {
    for (const [host, pin] of Object.entries(PINNED_HOSTS)) {
      expect(pin.rootKeys.some(isTestRoot), host).toBe(false);
    }
    const demo = await demoAt(await tmpData());
    expect(demo.trustKeys).toEqual(demoTrustKeys());
    expect(demo.trustKeys.rootKeys.every(isTestRoot)).toBe(true);
  });

  it("keeps one passkey per demo data dir (0600), so the approver pin holds across runs", async () => {
    const data = await tmpData();
    const a = await demoAt(data);
    const b = await demoAt(data);
    expect(b.passkey.publicJwk).toEqual(a.passkey.publicJwk);
    expect(b.passkey.credentialId).toBe(a.passkey.credentialId);
    const file = join(demoDataDir(data), "demo-passkey.json");
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(demoDataDir(data))).mode & 0o777).toBe(0o700);
    const other = await demoAt(await tmpData());
    expect(other.passkey.publicJwk).not.toEqual(a.passkey.publicJwk);
  });

  it("refuses a passkey file that is not one", async () => {
    const data = await tmpData();
    await fsp.mkdir(demoDataDir(data), { recursive: true });
    const file = join(demoDataDir(data), "demo-passkey.json");
    await fsp.writeFile(file, JSON.stringify({ v: 2 }));
    await expect(startDemo({ dataDir: data })).rejects.toThrow(/not a demo passkey file/);
    await fsp.rm(file);
    await fsp.mkdir(file);
    await expect(startDemo({ dataDir: data })).rejects.toThrow(/not a regular file/);
  });
});

describe("next steps", () => {
  it("prints the banner and the exact claude mcp add line for stdio", () => {
    const lines = nextSteps({ code: { code: "123456", file: "/d/demo/approval-code" } });
    expect(lines[0]).toBe("DEMO: test keys, sample catalog, nothing can be bought.");
    // Under vitest this process is not the gateway's own script, so the command is the bare `intent`.
    expect(lines).toContain("  claude mcp add intent -- intent demo");
    expect(lines.join("\n")).toContain("open the approval link, enter the demo code and click \"Approve $… with demo passkey\"");
    expect(lines).toContain("Demo code for the confirm page: 123456 (new on every start; also in /d/demo/approval-code; never sent to the agent)");
    expect(lines).toContain("Re-check what was sent afterwards with: intent verify --demo");
  });

  it.each([
    ["npx -y intent-gateway@next", "a published preview"],
    ["npx -y file:/home/dev/intent-gateway.tgz", "a local tarball"],
    ["node /home/dev/intent-gateway/dist/main.js", "a source build"],
  ])("names the command that started this gateway: %s (%s)", (intent) => {
    const lines = nextSteps({ intent });
    expect(lines).toContain(`  claude mcp add intent -- ${intent} demo`);
    expect(lines).toContain(`Re-check what was sent afterwards with: ${intent} verify --demo`);
  });

  it("prints the HTTP form with --http, with the token header only when there is a token", () => {
    expect(nextSteps({ http: { url: "http://127.0.0.1:8787/mcp", token: null } })).toContain(
      "  claude mcp add --transport http intent http://127.0.0.1:8787/mcp",
    );
    expect(nextSteps({ http: { url: "http://127.0.0.1:8787/mcp", token: "t".repeat(32) } })).toContain(
      `  claude mcp add --transport http intent http://127.0.0.1:8787/mcp --header "Authorization: Bearer ${"t".repeat(32)}"`,
    );
  });

  it("names the confirm page's address and the ssh -L forward for it", () => {
    const lines = nextSteps({ code: { code: "123456", file: "/d/demo/approval-code" }, confirm: { origin: "http://127.0.0.1:8788", busy: null } });
    expect(lines).toContain("Approval links open the demo confirm page at http://127.0.0.1:8788 (over SSH, forward it: ssh -L 8788:127.0.0.1:8788 <host>)");
    expect(lines.join("\n")).not.toContain("is taken");
    expect(lines.indexOf("then ask the agent to check the approval status.")).toBeLessThan(lines.findIndex((l) => l.startsWith("Approval links")));
  });

  it("says when the default port was taken and which one the confirm page uses instead", () => {
    const lines = nextSteps({ confirm: { origin: "http://127.0.0.1:41233", busy: 8788 } });
    expect(lines).toContain("Port 8788 is taken (another demo running?), so the confirm page uses 41233; set INTENT_DEMO_CONFIRM_PORT to choose one.");
    expect(lines).toContain("Approval links open the demo confirm page at http://127.0.0.1:41233 (over SSH, forward it: ssh -L 41233:127.0.0.1:41233 <host>)");
  });

  it("in the image, points at the entrypoint's connect line instead of printing a second one", () => {
    const lines = nextSteps({ http: "above" });
    expect(lines).toContain("Add the demo gateway to Claude Code with the claude mcp add line above.");
    expect(lines.join("\n")).not.toContain("claude mcp add --transport");
  });
});
