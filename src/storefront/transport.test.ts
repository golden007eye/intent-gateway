// The real storefront transport against a local server: the resolver and the connection are the only seams (the
// server speaks plain HTTP on 127.0.0.1, so TLS is the one thing not exercised here). Attack cases: names resolving to
// non-public addresses, DNS rebinding, redirects, oversize bodies, slow answers, and requests other than the one GET.
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createStorefrontTransport, isPublicAddress, META_OPERATION, StorefrontRequestError, StorefrontTransportError } from "./index.ts";

/** Any public address: the connect seam never dials it, it only records that this is the address checked. */
const PUBLIC = "93.184.215.14";
const URL_OK = "https://shop.example/meta.json";

interface Local {
  readonly port: number;
  /** Every request's raw bytes, one entry per connection. */
  readonly raw: string[];
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => { resolve(); }))));
  servers = [];
});

/** A local server that reads one request per connection and answers with `reply` (raw HTTP), or never answers. */
async function serve(reply: string | Buffer | null): Promise<Local> {
  const raw: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (text.includes("\r\n\r\n")) {
        raw.push(text);
        if (reply !== null) socket.end(reply);
      }
    });
    socket.on("error", () => undefined);
  });
  server.on("close", () => {
    for (const s of sockets) s.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of sockets) s.destroy();
    return close(cb);
  });
  return { port: address.port, raw };
}

const json = (body: string, extra = ""): string => `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n${extra}\r\n${body}`;

function transportTo(local: Local, resolved: () => readonly string[] = () => [PUBLIC], timeoutMs?: number) {
  const dialed: { address: string; servername: string }[] = [];
  let lookups = 0;
  const transport = createStorefrontTransport({
    resolve: () => {
      lookups += 1;
      return Promise.resolve(resolved());
    },
    connect: (address, servername) => {
      dialed.push({ address, servername });
      return createConnectionTo(local.port);
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { transport, dialed, lookups: () => lookups };
}

const createConnectionTo = (port: number) => netConnect({ host: "127.0.0.1", port });

describe("the storefront transport", () => {
  it("sends one GET /meta.json with exactly the fixed header set and no body, to the address it checked", async () => {
    const local = await serve(json('{"myshopify_domain":"test-shop.myshopify.com"}'));
    const { transport, dialed } = transportTo(local);
    const request = transport.prepare(META_OPERATION, { url: URL_OK });
    expect(request).toMatchObject({ method: "GET", path: URL_OK, body: new Uint8Array(0) });
    const answer = await transport.send(request);
    expect(answer.status).toBe(200);
    expect(Buffer.from(answer.body).toString("utf8")).toBe('{"myshopify_domain":"test-shop.myshopify.com"}');
    expect(dialed).toEqual([{ address: PUBLIC, servername: "shop.example" }]);
    // No cookie, credential, Authorization or buyer data: these four headers, in this order, and nothing else.
    expect(local.raw).toEqual(["GET /meta.json HTTP/1.1\r\nhost: shop.example\r\naccept: application/json\r\nuser-agent: intent-gateway (store pair check)\r\nconnection: close\r\n\r\n"]);
  });

  it("reads a chunked answer", async () => {
    const body = '{"myshopify_domain":"test-shop.myshopify.com"}';
    const local = await serve(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
    const answer = await transportTo(local).transport.send(transportTo(local).transport.prepare(META_OPERATION, { url: URL_OK }));
    expect(Buffer.from(answer.body).toString("utf8")).toBe(body);
  });

  it("attack: a redirect comes back as it is and is never followed (one connection, one request)", async () => {
    const local = await serve("HTTP/1.1 301 Moved Permanently\r\nlocation: http://127.0.0.1/meta.json\r\ncontent-length: 0\r\n\r\n");
    const { transport, dialed } = transportTo(local);
    const answer = await transport.send(transport.prepare(META_OPERATION, { url: URL_OK }));
    expect(answer.status).toBe(301);
    expect([dialed.length, local.raw.length]).toEqual([1, 1]);
  });

  it("attack: an oversize body is read to 64 KiB + 1 bytes and no further", async () => {
    const big = Buffer.alloc(1024 * 1024, 0x20);
    const local = await serve(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(big.length)}\r\n\r\n`), big]));
    const { transport } = transportTo(local);
    const answer = await transport.send(transport.prepare(META_OPERATION, { url: URL_OK }));
    expect(answer.body.length).toBe(64 * 1024 + 1);
  });

  it("attack: a storefront that never answers is given up on within the time limit (sent, unanswered)", async () => {
    const local = await serve(null);
    const { transport } = transportTo(local, undefined, 300);
    const started = Date.now();
    const error = await transport.send(transport.prepare(META_OPERATION, { url: URL_OK })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorefrontTransportError);
    expect((error as StorefrontTransportError).neverLeft).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.each([
    ["a private address", ["10.0.0.5"]],
    ["loopback", ["127.0.0.1"]],
    ["link-local (cloud metadata)", ["169.254.169.254"]],
    ["IPv6 loopback", ["::1"]],
    ["an IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["a hex IPv4-mapped loopback", ["::ffff:7f00:1"]],
    ["IPv6 unique-local", ["fd00::1"]],
    ["a public address beside a private one", [PUBLIC, "192.168.1.1"]],
    ["no address at all", []],
  ] as const)("attack: a name resolving to %s is refused before any connection (never left)", async (_what, addresses) => {
    const local = await serve(json("{}"));
    const { transport, dialed } = transportTo(local, () => addresses);
    const error = await transport.send(transport.prepare(META_OPERATION, { url: URL_OK })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorefrontTransportError);
    expect((error as StorefrontTransportError).neverLeft).toBe(true);
    expect(dialed).toEqual([]);
    expect(local.raw).toEqual([]);
  });

  it("attack (DNS rebinding): the name is resolved once, and the connection goes to the address that was checked", async () => {
    const local = await serve(json("{}"));
    let calls = 0;
    const { transport, dialed, lookups } = transportTo(local, () => (calls++ === 0 ? [PUBLIC] : ["127.0.0.1"]));
    await transport.send(transport.prepare(META_OPERATION, { url: URL_OK }));
    expect(lookups()).toBe(1);
    expect(dialed.map((d) => d.address)).toEqual([PUBLIC]);
  });

  it("a name that does not resolve is never sent", async () => {
    const transport = createStorefrontTransport({ resolve: () => Promise.reject(new Error("ENOTFOUND")), connect: () => createConnectionTo(1) });
    const error = await transport.send(transport.prepare(META_OPERATION, { url: URL_OK })).catch((e: unknown) => e);
    expect((error as StorefrontTransportError).neverLeft).toBe(true);
  });

  it("builds no other request: another operation, an IP literal host, another path, a query or http", () => {
    const transport = createStorefrontTransport();
    expect(() => transport.prepare("get_checkout", { url: URL_OK })).toThrow(StorefrontRequestError);
    for (const url of ["https://127.0.0.1/meta.json", "https://shop.example/other.json", "https://shop.example/meta.json?x=1", "http://shop.example/meta.json", "https://shop.example:8443/meta.json"]) {
      expect(() => transport.prepare(META_OPERATION, { url }), url).toThrow(StorefrontRequestError);
    }
  });

  it("isPublicAddress: public addresses pass, every special-purpose range fails", () => {
    for (const ok of [PUBLIC, "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ok), ok).toBe(true);
    for (const bad of ["0.0.0.0", "100.64.0.1", "172.16.0.1", "192.0.2.1", "198.18.0.1", "203.0.113.9", "224.0.0.1", "255.255.255.255", "fe80::1", "ff02::1", "2001:db8::1", "64:ff9b::7f00:1", "2002:7f00:1::1", "not an ip"]) {
      expect(isPublicAddress(bad), bad).toBe(false);
    }
  });
});
