// The adapter against a local node:http stub that records every byte each connection received, so the fixed header
// set (plan §3.1) is compared as the raw header block, not as Node's parsed view of it.
import { readFileSync } from "node:fs";
import { Agent, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CartRequest, SearchRequest } from "../contract/index.ts";
import { canonicalize } from "../jcs/index.ts";
import { contentDigest, createNonceCache, createSession, verifyRequest } from "../signing/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  createHttpCloud,
  type HttpCloudOptions,
  type PreparedRequest,
} from "./index.ts";
import { networkFailure } from "./http.ts";

type Json = Record<string, unknown>;
const vector = (name: string): Json =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", name), "utf8")) as Json;
const d1 = ((vector("d1-receipt.json")["cases"] as Json[])[0] as Json)["expected"] as Json;
const RECEIPT = { header: d1["intent_receipt"] as string, signature: d1["intent_receipt_signature"] as string };
const STATEMENT = (vector("s1-key-statement.json")["expected"] as Json)["statement"] as Json;

const NOW_MS = 1790251200_000;
const NOW_S = NOW_MS / 1000;
const USD = (amount_minor: number): Json => ({ amount_minor, currency: "USD" });
const MERCHANT = { name: "Example Shop", domain: "shop.example" };
const ITEM = { title: "Trail shoe", variant: "Size 10" };
const SEARCH: SearchRequest = { ship_to: { postal_code: "94110", country: "US" }, product: "trail shoe" };
const CART_REQUEST: CartRequest = { offer_handle: "of_TEST0001", quantity: 1, ship_to: { country: "US", postal_code: "94110" }, completer_keyid: createSession().keyid };

const BODIES: Readonly<Record<string, Json>> = {
  "/v1/meta": { contract_version: "1.5.0", contract_sums_sha256: "c".repeat(64), rule_versions: ["recheck-v1"] },
  "/v1/signature-keys": { keys: [{ kty: "OKP", crv: "Ed25519", kid: "cloud-receipt-202610", x: "JUO5L_EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0" }] },
  "/v1/key-statement": STATEMENT,
  "/v1/catalog/search": {
    offers: [
      {
        offer_handle: "of_TEST0001",
        merchant: MERCHANT,
        title: "Trail shoe",
        variant: "Size 10",
        price: USD(8999),
        shipping: USD(0),
        total_kind: "exact",
        availability: "in_stock",
      },
    ],
  },
  "/v1/carts": {
    cart_handle: "ct_TEST0001",
    merchant: MERCHANT,
    item: ITEM,
    quantity: 1,
    unit_price: USD(8999),
    shipping: USD(0),
    total: USD(8999),
    total_kind: "exact",
    expires_at: "2026-09-24T12:30:00Z",
  },
  "/v1/carts/ct_TEST0001/approvals": {
    approval_handle: "ap_TEST0001",
    approval_link_path: "/c/abcdefghijklmnop",
    snapshot: {
      v: 3,
      approval: "ap_TEST0001",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      merchant: MERCHANT,
      item: ITEM,
      quantity: 1,
      unit_price: USD(8999),
      shipping: USD(0),
      total: USD(8999),
      total_kind: "exact",
      ship_to: { country: "US", postal_code: "94110" },
      continue_url_hash: `sha256:${"a".repeat(64)}`,
      rule_version: "recheck-v1",
      expires_at: "2026-09-24T12:30:00Z",
      merchant_origin: "https://shop.example",
      variant_ref: "gid://shopify/ProductVariant/1",
      checkout_ref_hash: `sha256:${"c".repeat(64)}`,
      completion_mode: "handoff",
      completer_keyid: CART_REQUEST.completer_keyid,
      total_estimated: false,
    },
    snapshot_hash: "b".repeat(64),
    check_code: "0123abcd",
    state: "pending",
    expires_at: "2026-09-24T12:30:00Z",
  },
  "/v1/approvals/ap_TEST0001": { state: "pending", display: { merchant: "Example Shop", title: "Trail shoe", total: USD(8999) } },
};
const STATUS: Readonly<Record<string, number>> = { "/v1/carts": 201, "/v1/carts/ct_TEST0001/approvals": 201 };

interface Reply {
  status: number;
  headers?: [string, string][];
  body?: string | Buffer;
}
type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => Reply | "hang" | "handled";

interface Received {
  raw: Buffer;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface Stub {
  baseUrl: string;
  port: number;
  /** Raw bytes of every connection, in arrival order. */
  connections: Buffer[];
  requests: Received[];
  handler: Handler;
}

const okReply: Handler = (req) => ({
  status: STATUS[req.url ?? ""] ?? 200,
  headers: [
    ["Intent-Contract-Version", "1.5.0"],
    ["Intent-Receipt", RECEIPT.header],
    ["Intent-Receipt-Signature", RECEIPT.signature],
    ["Content-Type", "application/json"],
  ],
  body: JSON.stringify(BODIES[req.url ?? ""] ?? {}),
});

const servers: { close(): void }[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function startStub(handler: Handler = okReply): Promise<Stub> {
  const stub: Stub = { baseUrl: "", port: 0, connections: [], requests: [], handler };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const socketIndex = stub.connections.length - 1;
      stub.requests.push({
        raw: stub.connections[socketIndex] ?? Buffer.alloc(0),
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      const reply = stub.handler(req, body, res);
      if (reply === "hang" || reply === "handled") return;
      res.writeHead(reply.status, reply.headers?.flat() ?? []);
      res.end(reply.body);
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.push(socket);
    const index = stub.connections.push(Buffer.alloc(0)) - 1;
    socket.on("data", (c: Buffer) => {
      stub.connections[index] = Buffer.concat([stub.connections[index] ?? Buffer.alloc(0), c]);
    });
  });
  stub.port = await listen(server);
  stub.baseUrl = `http://127.0.0.1:${String(stub.port)}`;
  return stub;
}

const session = createSession();
const cloudFor = (stub: Stub, over: Partial<HttpCloudOptions> = {}) =>
  createHttpCloud({ baseUrl: stub.baseUrl, session, now: () => NOW_MS, ...over });

function headerOf(r: Received, name: string): string {
  const v = r.headers[name];
  if (typeof v !== "string") throw new Error(`no single ${name}`);
  return v;
}

function verify(r: Received, cache = createNonceCache()) {
  return verifyRequest(r.headers, { method: r.method, path: r.path, body: r.body }, { now: NOW_S, seenNonce: cache });
}

describe("the fixed header set, as raw bytes", () => {
  it("a signed POST sends exactly host, content-type, accept, intent-contract-version, the three signature headers, content-length and connection: close", async () => {
    const stub = await startStub();
    const result = await cloudFor(stub).search(SEARCH);
    expect(result.ok).toBe(true);
    const [r] = stub.requests;
    if (r === undefined) throw new Error("no request");
    const body = '{"product":"trail shoe","ship_to":{"country":"US","postal_code":"94110"}}';
    expect(r.body.toString("utf8")).toBe(body);
    const sigInput = headerOf(r, "signature-input");
    expect(sigInput).toMatch(new RegExp(`^sig1=\\("@method" "@path" "content-digest"\\);created=${String(NOW_S)};nonce="[A-Za-z0-9_-]{22}";keyid="${session.keyid}";alg="ed25519";tag="intent-gateway-v1"$`));
    const expected =
      "POST /v1/catalog/search HTTP/1.1\r\n" +
      `host: 127.0.0.1:${String(stub.port)}\r\n` +
      "content-type: application/json\r\n" +
      "accept: application/json\r\n" +
      "intent-contract-version: 1.6.1\r\n" +
      `content-digest: ${contentDigest(Buffer.from(body))}\r\n` +
      `signature-input: ${sigInput}\r\n` +
      `signature: ${headerOf(r, "signature")}\r\n` +
      `content-length: ${String(Buffer.byteLength(body))}\r\n` +
      "connection: close\r\n" +
      "\r\n" +
      body;
    expect(r.raw.toString("latin1")).toBe(expected);
    expect(r.raw.toString("latin1").toLowerCase()).not.toMatch(/transfer-encoding|user-agent|accept-language|accept-encoding|sec-fetch|keep-alive/);
    expect(verify(r)).toMatchObject({ ok: true, keyid: session.keyid, created: NOW_S });
  });

  it("the returned request is byte for byte what the stub received", async () => {
    const stub = await startStub();
    const result = await cloudFor(stub).createCart(CART_REQUEST);
    const [r] = stub.requests;
    if (r === undefined) throw new Error("no request");
    const { request } = result.raw;
    const block = `${request.method} ${request.path} HTTP/1.1\r\n${request.headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
    expect(Buffer.concat([Buffer.from(block, "latin1"), request.body]).equals(r.raw)).toBe(true);
    expect(Buffer.from(request.body).toString("utf8")).toBe(canonicalize(CART_REQUEST));
  });

  it("a signed GET has no content-type and content-length: 0", async () => {
    const stub = await startStub();
    await cloudFor(stub).meta();
    const [r] = stub.requests;
    if (r === undefined) throw new Error("no request");
    expect(r.raw.toString("latin1")).toBe(
      "GET /v1/meta HTTP/1.1\r\n" +
        `host: 127.0.0.1:${String(stub.port)}\r\n` +
        "accept: application/json\r\n" +
        "intent-contract-version: 1.6.1\r\n" +
        `content-digest: ${contentDigest(new Uint8Array(0))}\r\n` +
        `signature-input: ${headerOf(r, "signature-input")}\r\n` +
        `signature: ${headerOf(r, "signature")}\r\n` +
        "content-length: 0\r\n" +
        "connection: close\r\n\r\n",
    );
    expect(verify(r).ok).toBe(true);
  });

  it("a POST without a body (createApproval) is signed over the empty body, with no content-type", async () => {
    const stub = await startStub();
    const result = await cloudFor(stub).createApproval("ct_TEST0001");
    expect(result.ok).toBe(true);
    const [r] = stub.requests;
    if (r === undefined) throw new Error("no request");
    expect(r.raw.toString("latin1")).toMatch(/^POST \/v1\/carts\/ct_TEST0001\/approvals HTTP\/1\.1\r\nhost: [^\r]+\r\naccept: application\/json\r\nintent-contract-version: 1\.6\.1\r\ncontent-digest: [^\r]+\r\nsignature-input: [^\r]+\r\nsignature: [^\r]+\r\ncontent-length: 0\r\nconnection: close\r\n\r\n$/);
    expect(verify(r).ok).toBe(true);
  });

  it("unsigned endpoints send the same set minus signature-input and signature", async () => {
    const stub = await startStub();
    const cloud = cloudFor(stub);
    await cloud.signatureKeys();
    await cloud.keyStatement();
    const host = `host: 127.0.0.1:${String(stub.port)}\r\n`;
    const rest = `accept: application/json\r\nintent-contract-version: 1.6.1\r\ncontent-digest: ${contentDigest(new Uint8Array(0))}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`;
    expect(stub.requests.map((r) => r.raw.toString("latin1"))).toEqual([
      `GET /v1/signature-keys HTTP/1.1\r\n${host}${rest}`,
      `GET /v1/key-statement HTTP/1.1\r\n${host}${rest}`,
    ]);
  });

  it("a fresh nonce on every request, one connection per request", async () => {
    const stub = await startStub();
    const cloud = cloudFor(stub);
    await cloud.search(SEARCH);
    await cloud.search(SEARCH);
    await cloud.getApproval("ap_TEST0001");
    const cache = createNonceCache();
    const nonces = stub.requests.map((r) => {
      const v = verify(r, cache);
      if (!v.ok) throw new Error(v.code);
      return v.nonce;
    });
    expect(new Set(nonces).size).toBe(3);
    expect(stub.connections).toHaveLength(3);
  });

  it("an agentFactory agent sends the same header block; a keep-alive agent is refused before sending", async () => {
    const stub = await startStub();
    await cloudFor(stub, { agentFactory: () => new Agent({ keepAlive: false }) }).meta();
    const [r] = stub.requests;
    if (r === undefined) throw new Error("no request");
    expect(r.raw.toString("latin1")).toMatch(/content-length: 0\r\nconnection: close\r\n\r\n$/);
    expect(r.raw.toString("latin1").toLowerCase()).not.toContain("keep-alive");
    await expect(cloudFor(stub, { agentFactory: () => new Agent({ keepAlive: true }) }).meta()).rejects.toThrow(CloudRequestError);
    expect(stub.requests).toHaveLength(1);
  });

  it("refuses a keep-alive agent before beforeSend, so a request that never leaves is never logged as sent", async () => {
    const stub = await startStub();
    let logged = 0;
    const cloud = cloudFor(stub, { agentFactory: () => new Agent({ keepAlive: true }) });
    await expect(cloud.search(SEARCH, {
        beforeSend: () => {
          logged++;
        },
      })).rejects.toThrow(CloudRequestError);
    expect(logged).toBe(0);
    expect(stub.connections).toHaveLength(0);
  });

  it("destroys the caller's agent when beforeSend throws", async () => {
    const stub = await startStub();
    const agent = new Agent({ keepAlive: false });
    let destroyed = 0;
    const destroy = agent.destroy.bind(agent);
    agent.destroy = () => {
      destroyed++;
      destroy();
    };
    const cloud = cloudFor(stub, { agentFactory: () => agent });
    await expect(cloud.meta({ beforeSend: () => Promise.reject(new Error("log append failed")) })).rejects.toThrow("log append failed");
    expect(destroyed).toBe(1);
    expect(stub.connections).toHaveLength(0);
  });
});

describe("contract 1.6.x: a per-call signer and outcome reports", () => {
  it("a per-call session signs that request only; the adapter's session signs the next", async () => {
    const stub = await startStub();
    const cloud = cloudFor(stub);
    const completer = createSession();
    const read = await cloud.getApproval("ap_TEST0001", { session: completer });
    expect(read.ok).toBe(true);
    await cloud.getApproval("ap_TEST0001");
    const [first, second] = stub.requests;
    if (first === undefined || second === undefined) throw new Error("two requests expected");
    expect(verify(first)).toMatchObject({ ok: true, keyid: completer.keyid });
    expect(verify(second)).toMatchObject({ ok: true, keyid: session.keyid });
    expect(read.raw.request.headers.find(([k]) => k === "signature-input")?.[1]).toContain(`keyid="${completer.keyid}"`);
  });

  it("reportOutcome posts the canonical OutcomeReport to the approval's outcome-reports path, signed", async () => {
    const stub = await startStub(() => ({
      status: 201,
      headers: [["Intent-Contract-Version", "1.6.1"]],
      body: JSON.stringify({ accepted: true, outcome: { state: "completing", source: "gateway_report", assurance: "reported", observed_at: "2026-10-15T12:01:00Z", reported: { state: "completing", source: "shop_api" } } }),
    }));
    const report = { report_id: `or_${"A".repeat(22)}`, state: "completing", source: "shop_api", checkout_ref_hash: `sha256:${"0".repeat(64)}`, observed_at: "2026-10-15T12:01:00Z" } as const;
    const result = await cloudFor(stub).reportOutcome("ap_TEST0001", report);
    expect(result).toMatchObject({ ok: true, status: 201, body: { accepted: true } });
    const [r] = stub.requests;
    if (r === undefined) throw new Error("no request");
    expect([r.method, r.path, r.body.toString("utf8")]).toEqual(["POST", "/v1/approvals/ap_TEST0001/outcome-reports", canonicalize(report)]);
    expect(verify(r).ok).toBe(true);
  });

  it("attack (item 9): an answer with a non-integer number token is refused, though JSON.parse would make it an integer", async () => {
    const body = JSON.stringify(BODIES["/v1/carts"]).replace('"amount_minor":8999', '"amount_minor":8999.0');
    expect(body).toContain("8999.0");
    const stub = await startStub(() => ({ status: 201, headers: [["Intent-Contract-Version", "1.6.1"]], body }));
    await expect(cloudFor(stub).createCart(CART_REQUEST)).rejects.toMatchObject({ name: "CloudResponseError", reason: "schema" });
  });

  it("reportOutcome refuses a malformed handle or report before anything is sent", async () => {
    const stub = await startStub();
    const cloud = cloudFor(stub);
    const report = { report_id: `or_${"A".repeat(22)}`, state: "completing", source: "shop_api", checkout_ref_hash: `sha256:${"0".repeat(64)}`, observed_at: "2026-10-15T12:01:00Z" } as const;
    await expect(cloud.reportOutcome("ap_../x", report)).rejects.toThrow(CloudRequestError);
    await expect(cloud.reportOutcome("ap_TEST0001", { ...report, state: "ordered_maybe" } as never)).rejects.toThrow(CloudRequestError);
    expect(stub.connections).toHaveLength(0);
  });
});

describe("beforeSend", () => {
  it("sees the final request before it is sent; when it throws, nothing reaches the stub", async () => {
    const stub = await startStub();
    const cloud = cloudFor(stub);
    let seen: PreparedRequest | undefined;
    const result = await cloud.search(SEARCH, {
      beforeSend: (req) => {
        seen = req;
        expect(stub.connections).toHaveLength(0);
      },
    });
    expect(seen).toBe(result.raw.request);
    expect(seen?.operation).toBe("searchCatalog");

    await expect(
      cloud.createCart(CART_REQUEST, {
        beforeSend: () => Promise.reject(new Error("log append failed")),
      }),
    ).rejects.toThrow("log append failed");
    expect(stub.connections).toHaveLength(1);
  });
});

describe("refused before sending", () => {
  it("a request body outside the contract, a non-US destination, or a handle that adds path segments", async () => {
    const stub = await startStub();
    const cloud = cloudFor(stub);
    await expect(cloud.search({ ...SEARCH, name: "Jane Doe" } as never)).rejects.toThrow(CloudRequestError);
    await expect(cloud.search({ ship_to: { country: "CA", postal_code: "94110" } } as never)).rejects.toThrow(CloudRequestError);
    await expect(cloud.createApproval("ct_x/../../v1/meta")).rejects.toThrow(CloudRequestError);
    await expect(cloud.getApproval("ap_TEST0001?x=1")).rejects.toThrow(CloudRequestError);
    expect(stub.connections).toHaveLength(0);
  });

  it("a base URL that is not https or loopback http, or carries a path, credentials, query or fragment", () => {
    const make = (baseUrl: string) => () => createHttpCloud({ baseUrl, session });
    for (const bad of [
      "http://cloud.example",
      "http://localhost:8080",
      "http://10.0.0.1",
      "ftp://cloud.example",
      "https://cloud.example/v1",
      "https://user:pw@cloud.example",
      "https://cloud.example/?a=1",
      "https://cloud.example/#x",
      "not a url",
    ]) {
      expect(make(bad), bad).toThrow(CloudRequestError);
    }
    expect(make("https://cloud.example")).not.toThrow();
    expect(make("http://127.0.0.1:9")).not.toThrow();
    expect(make("http://[::1]:9")).not.toThrow();
  });
});

describe("responses", () => {
  it("every operation parses its success body with the contract schema", async () => {
    const stub = await startStub();
    const cloud = cloudFor(stub);
    const results = [
      await cloud.meta(),
      await cloud.signatureKeys(),
      await cloud.keyStatement(),
      await cloud.search(SEARCH),
      await cloud.createCart(CART_REQUEST),
      await cloud.createApproval("ct_TEST0001"),
      await cloud.getApproval("ap_TEST0001"),
    ];
    expect(results.map((r) => [r.ok, r.status])).toEqual([
      [true, 200],
      [true, 200],
      [true, 200],
      [true, 200],
      [true, 201],
      [true, 201],
      [true, 200],
    ]);
    expect(results.map((r) => r.body)).toEqual(stub.requests.map((r) => BODIES[r.path]));
  });

  it("surfaces the receipt and Intent-Contract-Version headers, and the raw response", async () => {
    const stub = await startStub();
    const result = await cloudFor(stub).createCart(CART_REQUEST);
    expect(result.receipt).toEqual(RECEIPT);
    expect(result.contractVersion).toBe("1.5.0");
    expect(result.retryAfter).toBeNull();
    expect(result.raw.responseHeaders).toContainEqual(["Intent-Receipt", RECEIPT.header]);
    expect(Buffer.from(result.raw.responseBytes).toString("utf8")).toBe(JSON.stringify(BODIES["/v1/carts"]));
  });

  it("a missing, repeated or malformed receipt or version header is reported as null", async () => {
    const replies: [string, string][][] = [
      [],
      [["Intent-Receipt", RECEIPT.header]],
      [
        ["Intent-Receipt", RECEIPT.header],
        ["Intent-Receipt", RECEIPT.header],
        ["Intent-Receipt-Signature", RECEIPT.signature],
        ["Intent-Contract-Version", "1.5.0"],
        ["Intent-Contract-Version", "1.5.0"],
      ],
      [
        ["Intent-Receipt", "not base64url!"],
        ["Intent-Receipt-Signature", RECEIPT.signature],
        ["Intent-Contract-Version", "v1.5"],
      ],
    ];
    let i = 0;
    const stub = await startStub((req) => ({ status: 200, headers: replies[i++] ?? [], body: JSON.stringify(BODIES[req.url ?? ""]) }));
    const cloud = cloudFor(stub);
    for (let n = 0; n < replies.length; n++) {
      const result = await cloud.meta();
      expect(result.ok).toBe(true);
      expect([result.receipt, result.contractVersion]).toEqual([null, null]);
    }
  });

  it("maps a 429 with Retry-After through Number()", async () => {
    const limited = { error: "rate_limited", message: "slow down", limit: "carts", retry_after_seconds: 7 };
    let retry = "7";
    const stub = await startStub(() => ({ status: 429, headers: [["Retry-After", retry], ["Intent-Contract-Version", "1.5.0"]], body: JSON.stringify(limited) }));
    const cloud = cloudFor(stub);
    const result = await cloud.createCart(CART_REQUEST);
    expect(result).toMatchObject({ ok: false, status: 429, body: limited, retryAfter: 7, contractVersion: "1.5.0" });
    for (const bad of ["soon", "0", "1.5", ""]) {
      retry = bad;
      expect((await cloud.createCart(CART_REQUEST)).retryAfter, bad).toBeNull();
    }
  });

  it("parses a listed error status with ErrorBody", async () => {
    const stub = await startStub(() => ({ status: 410, body: '{"error":"gone","message":"offer expired"}' }));
    const result = await cloudFor(stub).createCart(CART_REQUEST);
    expect(result).toMatchObject({ ok: false, status: 410, body: { error: "gone", message: "offer expired" }, receipt: null });
  });

  it("returns a status the spec does not list (a 503 edge page) with a null body and its raw bytes", async () => {
    const stub = await startStub(() => ({ status: 503, body: "<html>unavailable</html>" }));
    const result = await cloudFor(stub).search(SEARCH);
    expect(result).toMatchObject({ ok: false, status: 503, body: null, receipt: null, contractVersion: null });
    expect(Buffer.from(result.raw.responseBytes).toString("utf8")).toBe("<html>unavailable</html>");
  });

  it("rejects a schema-invalid or non-JSON body with a typed error that keeps the exchange", async () => {
    const replies: Reply[] = [
      { status: 200, body: JSON.stringify({ offers: [], extra: true }) },
      { status: 200, body: JSON.stringify({ offers: [{ offer_handle: "bad" }] }) },
      { status: 400, body: JSON.stringify({ error: "teapot", message: "x" }) },
      { status: 429, body: JSON.stringify({ error: "bad_request", message: "x" }) },
      { status: 200, body: "{not json" },
      { status: 200, body: "" },
    ];
    let i = 0;
    const stub = await startStub(() => {
      const r = replies[i++];
      if (r === undefined) throw new Error("no reply");
      return { ...r, headers: [["Intent-Receipt", RECEIPT.header], ["Intent-Receipt-Signature", RECEIPT.signature]] };
    });
    const cloud = cloudFor(stub);
    const reasons: string[] = [];
    for (const reply of replies) {
      const error = await cloud.search(SEARCH).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(CloudResponseError);
      const e = error as CloudResponseError;
      expect(e.status).toBe(reply.status);
      expect(e.receipt).toEqual(RECEIPT);
      expect(Buffer.from(e.raw.responseBytes).toString("utf8")).toBe(reply.body);
      reasons.push(e.reason);
    }
    expect(reasons).toEqual(["schema", "schema", "schema", "schema", "not_json", "not_json"]);
  });
});

describe("failures without a usable response", () => {
  it("times out cleanly when the stub never answers", async () => {
    const stub = await startStub(() => "hang");
    const error = await cloudFor(stub, { timeoutMs: 100 })
      .search(SEARCH)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(CloudNetworkError);
    expect((error as CloudNetworkError).reason).toBe("timeout");
    expect((error as CloudNetworkError).request.path).toBe("/v1/catalog/search");
    // A connection was made, so the request may have arrived: never reported as not sent.
    expect(error).toMatchObject({ neverLeft: false, message: `Intent Cloud at 127.0.0.1:${String(stub.port)} cannot be reached (no complete response within 100 ms)` });
  });

  it("slow: notifies once with the host while a sent request has no answer, then still times out (F-l)", async () => {
    const stub = await startStub(() => "hang");
    const hosts: string[] = [];
    let sentAt = 0;
    let notifiedAfter = -1;
    const deadlines: number[] = [];
    const slow = {
      afterMs: 50,
      notify: (host: string, timeoutMs: number) => ((notifiedAfter = Date.now() - sentAt), hosts.push(host), deadlines.push(timeoutMs)),
    };
    const beforeSend = async (): Promise<void> => {
      // Time spent before the send (logging it) does not count towards afterMs.
      await new Promise((resolve) => setTimeout(resolve, 120));
      sentAt = Date.now();
    };
    await expect(cloudFor(stub, { timeoutMs: 300, slow }).meta({ beforeSend })).rejects.toMatchObject({ reason: "timeout" });
    expect(hosts).toEqual([`127.0.0.1:${String(stub.port)}`]);
    // The adapter's own deadline, not the default, so the notice says when this wait ends.
    expect(deadlines).toEqual([300]);
    expect(notifiedAfter).toBeGreaterThanOrEqual(40);
  });

  it("slow: a response within afterMs notifies nothing", async () => {
    const stub = await startStub();
    const hosts: string[] = [];
    const slow = { afterMs: 2000, notify: (host: string) => hosts.push(host) };
    expect((await cloudFor(stub, { slow }).meta()).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hosts).toEqual([]);
  });

  it("a host name with no DNS record: plain words, no error code, and nothing left (attack: never claims more)", async () => {
    const looked: string[] = [];
    const lookup = (hostname: string, _options: unknown, callback: (error: Error) => void): void => {
      looked.push(hostname);
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
    };
    const error: unknown = await createHttpCloud({ baseUrl: "https://no-dns-record.example", session, agentFactory: () => new HttpsAgent({ lookup } as never) })
      .meta()
      .catch((e: unknown) => e);
    expect(looked).toEqual(["no-dns-record.example"]);
    expect(error).toMatchObject({ name: "CloudNetworkError", reason: "network", neverLeft: true, failure: "DNS: not found" });
    expect((error as Error).message).toBe("Intent Cloud at no-dns-record.example cannot be reached (DNS: not found)");
  });

  it.each([
    ["ENOTFOUND", "DNS: not found", true],
    ["EAI_AGAIN", "DNS: lookup failed", true],
    ["ECONNREFUSED", "connection refused", true],
    ["ENETUNREACH", "network unreachable", true],
    ["ETIMEDOUT", "connection timed out", false],
    ["ECONNRESET", "connection reset", false],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "TLS: the certificate is not trusted or the handshake failed", false],
    ["EWHATEVER", "network error", false],
    [undefined, "network error", false],
  ])("error code %s reads %j; never left: %s", (code, words, left) => {
    expect(networkFailure(code)).toEqual({ words, neverLeft: left });
  });

  it("times out when the body stalls after the headers", async () => {
    const stub = await startStub((_req, _body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      return "handled";
    });
    await expect(cloudFor(stub, { timeoutMs: 100 }).meta()).rejects.toMatchObject({ name: "CloudNetworkError", reason: "timeout" });
  });

  it("refuses a response larger than the cap, declared or streamed", async () => {
    const big = Buffer.alloc(2048, 0x20);
    let declare = true;
    const stub = await startStub((_req, _body, res) => {
      if (declare) {
        res.writeHead(200, { "content-length": String(big.length) });
        res.end(big);
      } else {
        res.writeHead(200);
        res.write(big.subarray(0, 1000));
        res.end(big.subarray(1000));
      }
      return "handled";
    });
    const cloud = cloudFor(stub, { maxResponseBytes: 1024 });
    for (const d of [true, false]) {
      declare = d;
      const error = await cloud.meta().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(CloudResponseError);
      expect((error as CloudResponseError).reason).toBe("too_large");
      expect((error as CloudResponseError).raw.responseBytes).toHaveLength(0);
    }
  });

  it("a refused connection or a reset mid-response is a CloudNetworkError", async () => {
    const closed = await startStub();
    const port = closed.port;
    await new Promise<void>((resolve) => {
      for (const s of sockets.splice(0)) s.destroy();
      const server = servers.pop() as Server;
      server.close(() => {
        resolve();
      });
    });
    await expect(createHttpCloud({ baseUrl: `http://127.0.0.1:${String(port)}`, session }).meta()).rejects.toMatchObject({
      name: "CloudNetworkError",
      reason: "network",
      neverLeft: true,
      message: `Intent Cloud at 127.0.0.1:${String(port)} cannot be reached (connection refused)`,
    });

    const reset = await startStub((req, _body, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("{");
      setImmediate(() => req.socket.destroy());
      return "handled";
    });
    await expect(cloudFor(reset).meta()).rejects.toMatchObject({ name: "CloudNetworkError", reason: "network", neverLeft: false });
  });

  it("an https base URL speaks TLS (node:https), never plain HTTP", async () => {
    const first: Buffer[] = [];
    const server = createNetServer((socket) => {
      sockets.push(socket);
      socket.once("data", (c: Buffer) => {
        first.push(c);
        socket.destroy();
      });
    });
    const port = await listen(server);
    const cloud = createHttpCloud({ baseUrl: `https://127.0.0.1:${String(port)}`, session, timeoutMs: 2000 });
    await expect(cloud.meta()).rejects.toBeInstanceOf(CloudNetworkError);
    expect(first[0]?.[0]).toBe(0x16); // TLS handshake record
    expect(first[0]?.toString("latin1")).not.toContain("HTTP/1.1");
  });
});
