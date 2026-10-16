// Demo mode end to end and its guards.
// - Flow: startDemo → find_offers → create_cart → Approve on the local confirm page (an HTTP POST) →
//   get_approval_status = approved → runVerify exit 0 over the demo data dir; every tool result carries the banner.
// - Confirm page: CSP, loopback bind, no approval by GET, CSRF token required (missing, wrong, other page, reused),
//   foreign Host/Origin/Sec-Fetch-Site refused; Approve needs the demo code (missing, wrong refused; locked after
//   MAX_WRONG_CODES), which is kept 0600, new on every start and never in a tool result.
// - Separation: a demo chain and a real chain never mix (both ways); demo mode refuses any root but the published
//   test root; the test root is never in PINNED_HOSTS; the demo passkey is stable per data dir.
import * as fsp from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PINNED_HOSTS } from "../config/index.ts";
import { connectCloud } from "../disclosure/index.ts";
import { createGateway, DEMO_SESSION, type Gateway, GatewayStartError } from "../gateway/index.ts";
import { type HttpHandle, runHttp } from "../mcp/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { createSession } from "../signing/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { isTestRoot, type PinnedRootKey, TEST_ROOT_KEY } from "../trust/index.ts";
import { formatReport, runVerify } from "../verify/index.ts";
import { CONFIRM_CSP, type Demo, DEMO_BANNER, demoDataDir, demoTrustKeys, MAX_WRONG_CODES, nextSteps, startDemo } from "./index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SHOES = { category: "running-shoes", budget_usd: 200, zip: "94103" };
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
  options: { dir?: string; demoMode?: boolean; pins?: PinnedRootKey[]; confirmBaseUrl?: string } = {},
): Promise<{ gateway: Gateway; store: Store }> {
  const store = await openStore(options.dir ?? demo.dataDir);
  cleanup.push(() => store.close());
  const session = createSession();
  const gateway = createGateway({
    cloud: (keySet) => connectCloud({ baseUrl: demo.cloudUrl, session }, store, { keySet }),
    store,
    policy: loadPolicy(POLICY),
    pinnedRootKeys: options.pins ?? demo.trustKeys.rootKeys,
    ...(options.demoMode === false ? {} : { demo: { confirmBaseUrl: options.confirmBaseUrl ?? demo.confirmBaseUrl } }),
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
    expect(page.body).toContain("Approve with demo passkey");
    expect(page.body).toContain("ZIP 941xx");
    expect(page.body).toContain(DEMO_BANNER);
    expect(page.body).toContain(`cat ${demo.codeFile}`);
    const done = await post(link, { csrf: csrfOf(page.body), action: "approve", code: demo.code }, { origin: new URL(link).origin, "sec-fetch-site": "same-origin" });
    expect(done.status).toBe(200);
    expect(done.body).toContain("Approved with the demo passkey.");

    const status = texts(await call("get_approval_status", { approval_handle: handle })).join("\n");
    expect(status).toContain("Approver passkey fingerprint:");
    // The demo code reaches the person through the gateway's stderr and its file, never through a tool result.
    for (const text of [offers, cart, status]) expect(text).not.toContain(demo.code);
    expect(cart).toContain("click Approve with demo passkey (enter the code shown in the gateway's terminal)");
    expect(cart).not.toMatch(/phone/);
    expect(store.entries().map((e) => e.kind)).toContain("approval");

    await store.close();
    const report = await runVerify({ dataDir: demo.dataDir, pinnedRootKeys: demoTrustKeys().rootKeys, now: new Date(), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.counts.approvals).toBe(1);
    expect(formatReport(report)).toContain("acknowledged by a receipt from the local demo Intent Cloud (demo chain, test keys): ");
    expect(formatReport(report)).not.toContain("public edge");
  });

  it("rejects with the demo passkey", async () => {
    const demo = await demoAt(await tmpData());
    const { gateway } = await gatewayOver(demo);
    await gateway.start();
    const { url, handle } = await pendingApproval(gateway);
    const page = await raw(url);
    expect((await post(url, { csrf: csrfOf(page.body), action: "reject" })).body).toContain("Rejected.");
    expect(demo.cloud.inspect(handle)?.state).toBe("rejected");
    const after = await raw(url);
    expect(after.body).not.toContain('name="csrf"');
    expect(after.body).toContain("This approval is rejected.");
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
    expect(page.body).not.toMatch(/(src|href)="https?:/);
    expect(page.body).not.toContain("<script");
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

  it("locks Approve after MAX_WRONG_CODES wrong codes, even for the right code, until the demo restarts", async () => {
    const { demo, url, handle } = await pending();
    const wrong = String((Number(demo.code) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < MAX_WRONG_CODES; i += 1) expect((await approve(url, wrong)).status).toBe(403);
    const locked = await approve(url, demo.code);
    expect(locked.status).toBe(403);
    expect(locked.body).toContain("Too many wrong demo codes");
    expect(demo.cloud.inspect(handle)?.state).toBe("pending");
    // Reject needs no code and still works.
    expect((await post(url, { csrf: csrfOf((await raw(url)).body), action: "reject" })).status).toBe(200);
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
    expect(store.entries().map((e) => e.kind)).toEqual(["session", "disclosure", "receipt", "disclosure", "receipt", "keys"]);
  });

  it("a second demo run keeps one demo session entry", async () => {
    const demo = await demoAt(await tmpData());
    const first = await gatewayOver(demo);
    await first.gateway.start();
    await first.store.close();
    cleanup.pop();
    const second = await gatewayOver(demo);
    await second.gateway.start();
    expect(second.store.entries().filter((e) => e.kind === "session")).toHaveLength(1);
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
    expect(lines.join("\n")).toContain("open the approval link, enter the demo code and click Approve with demo passkey");
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
});
