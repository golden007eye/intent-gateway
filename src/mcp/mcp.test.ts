// The MCP module over Streamable HTTP, against the gateway and the fake Intent Cloud (AC-R1, AC-R2, AC-D1).
// - Tools: exactly three, their input schemas are the gateway's own; a full find → cart → approval run ends every
//   result with the Sent/Blocked line; an identity field an agent adds reaches the gateway and is blocked, not sent.
// - Transport (ADR-0005): no token off loopback refuses to start; missing or wrong token → 401; foreign Host or
//   Origin → 421; an oversized body → 413.
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SHOES, startTestGateway, type TestGateway } from "../../test/support/mcp-gateway.ts";
import { SoftPasskey } from "../cloud-fake/index.ts";
import { ApprovalHandle, OfferHandle } from "../contract/index.ts";
import { ApprovalStatusInput, CreateCartInput, FindOffersInput } from "../gateway/index.ts";
import { type HttpHandle, MAX_BODY_BYTES, McpHttpError, runHttp } from "./index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TOKEN = "t".repeat(16) + "0123456789abcdef0123";
const SUMMARY_END = /\n\nSent: .+ \/ Blocked: .+$/s;
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};

let env: TestGateway;
let servers: HttpHandle[] = [];
let clients: Client[] = [];
const logs: string[] = [];

beforeEach(async () => {
  env = await startTestGateway({ log: (line) => logs.push(line) });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  for (const server of servers) await server.close();
  clients = [];
  servers = [];
  await env.close();
});

async function serve(host = "127.0.0.1", token: string | null = null): Promise<HttpHandle> {
  const handle = await runHttp({ gateway: env.gateway, host, port: 0, token, log: (line) => logs.push(line) });
  servers.push(handle);
  return handle;
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "http-test", version: "0" });
  const headers: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }) as Transport);
  clients.push(client);
  return client;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTP request with exactly the headers given (Host included), so the tests can forge them. */
function raw(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<RawResponse> {
  const body = options.body ?? JSON.stringify(INITIALIZE);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/mcp",
        headers: {
          host: `127.0.0.1:${String(port)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
        });
      },
    );
    req.on("error", reject);
    if (options.method === undefined || options.method === "POST") req.end(body);
    else req.end();
  });
}

function textOf(result: unknown): string {
  const content = (result as CallToolResult).content;
  const last = content.at(-1);
  if (last?.type !== "text") throw new Error("the last content item is not text");
  return last.text;
}

// ---- Tools --------------------------------------------------------------------------------------------------------

describe("tools (AC-R1)", () => {
  it("an SDK client over HTTP lists exactly the three tools", async () => {
    const client = await connect((await serve()).url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["find_offers", "create_cart", "get_approval_status"]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(80);
    }
  });

  it("each input schema is the gateway's input schema, and its handles are the contract's", async () => {
    const client = await connect((await serve()).url);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t.inputSchema]));
    expect(byName.get("find_offers")).toEqual(z.toJSONSchema(FindOffersInput, { io: "input" }));
    expect(byName.get("create_cart")).toEqual(z.toJSONSchema(CreateCartInput, { io: "input" }));
    expect(byName.get("get_approval_status")).toEqual(z.toJSONSchema(ApprovalStatusInput, { io: "input" }));

    // Spelled out independently of the conversion, so a change to either side shows here.
    const find = byName.get("find_offers") as unknown as { properties: Record<string, unknown>; additionalProperties: boolean; required?: string[] };
    expect(Object.keys(find.properties).sort()).toEqual(["budget", "category", "country", "must_haves", "postcode", "product"]);
    expect(find.additionalProperties).toBe(false);
    expect(find.required ?? []).toEqual([]);
    const cart = byName.get("create_cart") as unknown as { properties: Record<string, { pattern?: string }>; required: string[] };
    expect(Object.keys(cart.properties).sort()).toEqual(["offer_handle", "quantity"]);
    expect(cart.required).toEqual(["offer_handle"]);
    expect(cart.properties.offer_handle?.pattern).toBe((z.toJSONSchema(OfferHandle) as { pattern: string }).pattern);
    const status = byName.get("get_approval_status") as unknown as { properties: Record<string, { pattern?: string }>; required?: string[] };
    // Optional: without one, a new session lists the purchases waiting for approval in the log.
    expect(status.required ?? []).toEqual([]);
    expect(status.properties.approval_handle?.pattern).toBe((z.toJSONSchema(ApprovalHandle) as { pattern: string }).pattern);
  });

  it("the descriptions tell an agent the rules: only what the user said, no guessed country, postcode or budget, where it ships, passkey", async () => {
    const client = await connect((await serve()).url);
    const text = (await client.listTools()).tools.map((t) => t.description ?? "").join(" ");
    expect(text).toContain("Pass only what the user said");
    expect(text).toContain("Never guess a postcode or a budget.");
    // The one country an agent may infer: a US ZIP code with a dollar budget and no other country (a dogfood agent
    // asked "Which country does 94103 ship to?"), and only when nothing else points elsewhere: Mexico also writes $ and
    // has 5-digit postcodes ("under $300, ship to 06600, Ciudad de México" is asked). Everything else is asked.
    expect(text).toContain(
      "Never guess a country, with one exception: a 5-digit ZIP code or ZIP+4 (12345 or 12345-6789) with a budget in dollars " +
        "($, USD, or the user said dollars) means US, when nothing in the conversation suggests another country (a non-US city, " +
        "region or language); if unsure, ask. Any other postcode needs the country from the user",
    );
    expect(text).toContain("5-digit postcodes are also used in other countries, and other countries' currencies are written $ too.");
    expect(text).not.toContain("Never guess a country, a postcode or a budget");
    expect(text).not.toContain("no other country named means US");
    // The schema the agent sees says the same, and nothing looser.
    const country = (z.toJSONSchema(FindOffersInput, { io: "input" }) as unknown as { properties: { country: { description: string } } }).properties.country.description;
    expect(country).toContain(
      "Never guess it, except US for a 5-digit ZIP code or ZIP+4 with a budget in dollars when nothing in the conversation suggests another country; if unsure, ask.",
    );
    expect(text).toContain("their budget in the currency of the ship-to country");
    expect(text).toContain("ask the user only for those");
    expect(text).toContain("Never put a name, street or full postcode in product or must_haves.");
    expect(text).toContain("if find_offers refuses a country, tell the user what it says");
    // The countries come from Intent Cloud at start, and the refusal names them: none is hard-coded here.
    expect(text).not.toMatch(/Canada|Australia/);
    expect(text).not.toContain("US delivery only");
    expect(text).toContain("needs a person to approve it with a passkey");
  });

  it("find_offers → create_cart → get_approval_status, each result ending with the summary (AC-D1)", async () => {
    const client = await connect((await serve()).url);

    const found = await client.callTool({ name: "find_offers", arguments: SHOES });
    const foundText = textOf(found);
    expect(found.isError).toBe(false);
    expect(foundText).toMatch(SUMMARY_END);
    expect(foundText).toMatch(/Sent: searchCatalog \(/);
    const offerHandle = /offer_handle: (of_[A-Za-z0-9_-]+)/.exec(foundText)?.[1];
    expect(offerHandle).toBeDefined();

    const cart = await client.callTool({ name: "create_cart", arguments: { offer_handle: offerHandle } });
    const cartText = textOf(cart);
    expect(cart.isError).toBe(false);
    expect(cartText).toMatch(SUMMARY_END);
    const approvalHandle = /approval_handle: (ap_[A-Za-z0-9_-]+)/.exec(cartText)?.[1] ?? "";
    expect(approvalHandle).not.toBe("");
    expect(cartText).toContain(`Approval link: ${env.fake.inspect(approvalHandle)?.approval_link ?? "missing"}`);
    expect(cartText).toContain("QR code for the approval link:\n");
    expect(cartText).toMatch(/[▀▄█]/);
    const content = (cart as CallToolResult).content;
    const image = content.find((c) => c.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/gif" });
    expect(Buffer.from((image as { data: string }).data, "base64").subarray(0, 6).toString("latin1")).toMatch(/^GIF8[79]a$/);

    const waiting = textOf(await client.callTool({ name: "get_approval_status", arguments: { approval_handle: approvalHandle } }));
    expect(waiting).toMatch(/^Waiting for the buyer/);
    expect(waiting).toMatch(SUMMARY_END);

    expect(env.fake.approveWithPasskey(approvalHandle, new SoftPasskey({ sub: "buyer-1" })).status).toBe(200);
    const approved = await client.callTool({ name: "get_approval_status", arguments: { approval_handle: approvalHandle } });
    const approvedText = textOf(approved);
    expect(approvedText).toMatch(/^Approved: /);
    expect(approvedText).toContain("Approver passkey fingerprint: ");
    expect(approvedText).toMatch(SUMMARY_END);
    expect(env.store.entries().filter((e) => e.kind === "approval")).toHaveLength(1);
  });

  it("an exact offer shows its shipping; a max one never shows a cap, since shipping and tax come with the cart", async () => {
    const client = await connect((await serve()).url);
    const exact = textOf(await client.callTool({ name: "find_offers", arguments: SHOES }));
    expect(exact).toContain("- Trail Runner 3 (US 10 / Blue) from Trail Supply Co: $89.99 + $5.00 shipping, in stock. offer_handle: of_");
    // Intent Cloud's storefront offers: shipping 0 and max mean "not quoted yet" (the dogfood's confirm page then
    // showed $1.00 shipping and a $2.14 total for an offer listed as "$1.00 + $0.00 shipping (at most)").
    env.fake.tamper.offer({ total_kind: "max", shipping: { amount_minor: 0, currency: "USD" } });
    const unquoted = textOf(await client.callTool({ name: "find_offers", arguments: SHOES }));
    expect(unquoted).toContain("- Trail Runner 3 (US 10 / Blue) from Trail Supply Co: $89.99; shipping and tax are quoted when the cart is made, in stock.");
    env.fake.tamper.offer({ total_kind: "max", shipping: { amount_minor: 500, currency: "USD" } });
    const partial = textOf(await client.callTool({ name: "find_offers", arguments: SHOES }));
    expect(partial).toContain("$89.99 + $5.00 shipping, not final; shipping and tax are quoted when the cart is made, in stock.");
    for (const text of [exact, unquoted, partial]) expect(text).not.toMatch(/at most|up to/i);
  });

  it("create_cart states the cart's total first, before the approval link, so the developer sees it before the confirm page", async () => {
    const client = await connect((await serve()).url);
    const found = textOf(await client.callTool({ name: "find_offers", arguments: SHOES }));
    const handle = /Trail Runner 3 .*offer_handle: (of_[A-Za-z0-9_-]+)/.exec(found)?.[1];
    const text = textOf(await client.callTool({ name: "create_cart", arguments: { offer_handle: handle, quantity: 2 } }));
    const line = "Cart: 2 × Trail Runner 3 (US 10 / Blue) from Trail Supply Co, total $184.98 ($89.99 each, shipping $5.00). Tell the buyer this total before the approval link.";
    expect(text.startsWith(`${line}\n\nAsk the buyer to open `)).toBe(true);
    expect(text.indexOf(line)).toBeLessThan(text.indexOf("Approval link: "));
    // Said once each: the link and the check code are in their own lines, not repeated in the sentence above them.
    const link = /Approval link: (\S+)/.exec(text)?.[1] ?? "missing";
    const code = /Check code: (\S+)/.exec(text)?.[1] ?? "missing";
    expect(text.split(link)).toHaveLength(2);
    expect(text.split(code)).toHaveLength(2);
  });

  it("an estimated cart total says so", async () => {
    env.fake.tamper.cart({ total_estimated: true });
    const client = await connect((await serve()).url);
    const found = textOf(await client.callTool({ name: "find_offers", arguments: SHOES }));
    const handle = /Trail Runner 3 .*offer_handle: (of_[A-Za-z0-9_-]+)/.exec(found)?.[1];
    const text = textOf(await client.callTool({ name: "create_cart", arguments: { offer_handle: handle } }));
    // The confirm page's words for an estimated total (contract Appendix A).
    expect(text).toContain("from Trail Supply Co, total $94.99 (estimated: the final total can be lower, never higher) ($89.99 each, shipping $5.00).");
  });

  it("a total above the items and shipping is said as the merchant's quote, with no breakdown the cart does not carry", async () => {
    // The dogfood: $1.00 each, shipping $1.00, total $2.14 (the cart carries no tax field).
    env.fake.tamper.cart({ total: { amount_minor: 9513, currency: "USD" } });
    const client = await connect((await serve()).url);
    const found = textOf(await client.callTool({ name: "find_offers", arguments: SHOES }));
    const handle = /Trail Runner 3 .*offer_handle: (of_[A-Za-z0-9_-]+)/.exec(found)?.[1];
    const text = textOf(await client.callTool({ name: "create_cart", arguments: { offer_handle: handle } }));
    expect(text).toMatch(
      /^Cart: 1 × Trail Runner 3 \(US 10 \/ Blue\) from Trail Supply Co, total \$95\.13 \(\$89\.99 each, shipping \$5\.00; the total includes tax and fees the merchant quoted\)\. Tell the buyer this total before the approval link\./,
    );
    expect(text).not.toMatch(/tax \$/);
  });

  it("a create_cart refusal with no code names a next step (attack: the dogfood's 'names no fix')", async () => {
    const client = await connect((await serve()).url);
    const found = textOf(await client.callTool({ name: "find_offers", arguments: SHOES }));
    const handle = /Road Runner 2 .*offer_handle: (of_[A-Za-z0-9_-]+)/.exec(found)?.[1];
    const result = await client.callTool({ name: "create_cart", arguments: { offer_handle: handle, quantity: 3 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^Intent Cloud answered with a refusal: not enough stock\. Nothing was bought: no approval was made\. Pick another offer, or search again\.\n\nSent: /,
    );
  });

  it("missing details are asked for, nothing is sent, and the result still ends with the summary", async () => {
    const client = await connect((await serve()).url);
    const text = textOf(await client.callTool({ name: "find_offers", arguments: { category: "running-shoes" } }));
    expect(text).toContain("Ask the user only these questions:");
    expect(text).toContain("Where should it ship? Country and postcode.");
    expect(text).toMatch(/\n\nSent: nothing \/ Blocked: nothing$/);
  });

  it("attack: an identity field an agent adds reaches the gateway, is blocked and logged, and nothing is sent", async () => {
    const client = await connect((await serve()).url);
    const before = env.store.entries().length;
    const result = await client.callTool({ name: "find_offers", arguments: { ...SHOES, email: "buyer@example.com" } });
    const text = textOf(result);
    expect(text).toMatch(/\n\nSent: nothing \/ Blocked: .*email/);
    expect(text).not.toContain("buyer@example.com");
    const added = env.store.entries().slice(before);
    expect(added.map((e) => e.kind)).toEqual(["block"]);
    expect(JSON.stringify(added)).not.toContain("buyer@example.com");
  });

  it("a malformed input is an error result that still ends with the summary; an unknown tool is an error", async () => {
    const client = await connect((await serve()).url);
    const bad = await client.callTool({ name: "create_cart", arguments: { offer_handle: "nope" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^Not sent: /);
    expect(textOf(bad)).toMatch(SUMMARY_END);
    const unknown = await client.callTool({ name: "buy_now", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Unknown tool");
  });

  it("a gateway that throws becomes an error result, not a dropped connection", async () => {
    const handle = await runHttp({
      gateway: { ...env.gateway, findOffers: () => Promise.reject(new Error("store is closed")) },
      host: "127.0.0.1",
      port: 0,
      token: null,
      log: () => undefined,
    });
    servers.push(handle);
    const client = await connect(handle.url);
    const result = await client.callTool({ name: "find_offers", arguments: SHOES });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("store is closed");
  });
});

// ---- Transport ----------------------------------------------------------------------------------------------------

describe("runHttp refuses to start", () => {
  it.each([
    ["0.0.0.0", null],
    ["::", null],
    ["192.0.2.10", null],
    ["localhost", null],
  ])("on %s without a token", async (host, token) => {
    await expect(runHttp({ gateway: env.gateway, host, port: 0, token })).rejects.toThrow(McpHttpError);
  });

  it("with a token shorter than 32 characters or with spaces", async () => {
    await expect(runHttp({ gateway: env.gateway, host: "0.0.0.0", port: 0, token: "short" })).rejects.toThrow(/at least 32/);
    await expect(runHttp({ gateway: env.gateway, host: "127.0.0.1", port: 0, token: `${"a".repeat(32)} b` })).rejects.toThrow(McpHttpError);
  });
});

describe("bearer token (401)", () => {
  it("a missing, wrong, truncated or non-Bearer token gets 401; the right one gets through", async () => {
    const { port } = await serve("127.0.0.1", TOKEN);
    expect((await raw(port, {})).status).toBe(401);
    expect((await raw(port, { headers: { authorization: `Bearer ${TOKEN}x` } })).status).toBe(401);
    expect((await raw(port, { headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}` } })).status).toBe(401);
    expect((await raw(port, { headers: { authorization: `Bearer ${"x".repeat(TOKEN.length)}` } })).status).toBe(401);
    expect((await raw(port, { headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401);
    expect((await raw(port, { headers: { authorization: `Bearer  ${TOKEN}` } })).status).toBe(401);
    const denied = await raw(port, {});
    expect(denied.headers["www-authenticate"]).toBe('Bearer realm="intent-gateway"');
    expect(denied.body).not.toContain(TOKEN);

    const ok = await raw(port, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "intent-gateway" } } });
  });

  it("an SDK client with the token lists the tools; without it, connecting fails", async () => {
    const { url } = await serve("127.0.0.1", TOKEN);
    const client = await connect(url, TOKEN);
    expect((await client.listTools()).tools).toHaveLength(3);
    await expect(connect(url)).rejects.toThrow();
  });

  it("on a wildcard bind any Host is accepted, but only with the token", async () => {
    const { port } = await serve("0.0.0.0", TOKEN);
    const host = { host: "gateway.example:8787" };
    expect((await raw(port, { headers: host })).status).toBe(401);
    expect((await raw(port, { headers: { ...host, authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    // An Origin must still match the Host it was sent to.
    const foreign = { ...host, authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" };
    expect((await raw(port, { headers: foreign })).status).toBe(421);
    const same = { ...host, authorization: `Bearer ${TOKEN}`, origin: "http://gateway.example:8787" };
    expect((await raw(port, { headers: same })).status).toBe(200);
  });
});

describe("Host and Origin (421)", () => {
  it("on loopback, only the bind address and the localhost forms are accepted", async () => {
    const { port } = await serve();
    const p = String(port);
    for (const host of [`127.0.0.1:${p}`, `localhost:${p}`, `LOCALHOST:${p}`, `[::1]:${p}`]) {
      expect((await raw(port, { headers: { host } })).status, host).toBe(200);
    }
    for (const host of ["evil.example", `evil.example:${p}`, "127.0.0.1", `127.0.0.1:${String(port + 1)}`, `localhost.evil.example:${p}`]) {
      expect((await raw(port, { headers: { host } })).status, host).toBe(421);
    }
  });

  it("a foreign or opaque Origin gets 421, and so does a request that would otherwise be 401", async () => {
    const { port } = await serve("127.0.0.1", TOKEN);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const p = String(port);
    for (const origin of ["http://evil.example", `http://evil.example:${p}`, "null", `file://localhost:${p}`, "not a url"]) {
      expect((await raw(port, { headers: { ...auth, origin } })).status, origin).toBe(421);
    }
    for (const origin of [`http://127.0.0.1:${p}`, `http://localhost:${p}`]) {
      expect((await raw(port, { headers: { ...auth, origin } })).status, origin).toBe(200);
    }
    // Host is checked before the token, so a rebinding page learns nothing about the token.
    expect((await raw(port, { headers: { host: "evil.example" } })).status).toBe(421);
  });
});

describe("other requests", () => {
  it("an oversized body gets 413, before it is parsed", async () => {
    const { port } = await serve();
    const big = JSON.stringify({ ...INITIALIZE, padding: "x".repeat(MAX_BODY_BYTES) });
    expect((await raw(port, { body: big })).status).toBe(413);
    // Also when the length is not declared up front.
    expect((await raw(port, { body: big, headers: { "transfer-encoding": "chunked" } })).status).toBe(413);
  });

  it("a path other than /mcp is 404, a GET is 405, a body that is not JSON is 400", async () => {
    const { port } = await serve();
    expect((await raw(port, { path: "/" })).status).toBe(404);
    expect((await raw(port, { method: "GET" })).status).toBe(405);
    expect((await raw(port, { body: "{not json" })).status).toBe(400);
  });

  it("logs to the given logger, never to stdout; the address line is left to the caller (serve prints it once)", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const { url } = await serve();
    expect(logs.some((line) => line.includes(url))).toBe(false);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
