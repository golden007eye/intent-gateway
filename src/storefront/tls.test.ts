// The production TLS connection (connectTls) against a local HTTPS server whose certificate a throwaway test CA
// issued. Only the test trusts that CA (tls.setDefaultCACertificates, restored afterwards) and only the port differs
// from production, so these cases prove that the storefront transport verifies the certificate against the host name
// it checked, sends that name as SNI, and refuses a certificate for another name or from a CA nobody trusts, before
// any request is written.
import { createServer, type Server } from "node:https";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCa } from "../../test/support/tls-ca.ts";
import { META_OPERATION, StorefrontTransportError } from "./index.ts";
import { connectTls, createStorefrontTransport } from "./transport.ts";

const HOST = "shop.example";
const PUBLIC = "93.184.215.14";
const ca = createTestCa();
const stranger = createTestCa("a CA nobody trusts");
const saved = getCACertificates("default");
const servers: Server[] = [];

beforeAll(() => {
  setDefaultCACertificates([ca.cert]);
});
afterAll(async () => {
  setDefaultCACertificates(saved);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => { resolve(); }))));
});

/** A local HTTPS server with `identity`; it records each request's path and the SNI it was reached with. */
async function serve(identity: { cert: string; key: string }): Promise<{ port: number; requests: string[]; sni: (string | false)[] }> {
  const requests: string[] = [];
  const sni: (string | false)[] = [];
  const server = createServer(identity, (req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"myshopify_domain":"test-shop.myshopify.com"}');
  });
  server.on("secureConnection", (socket: TLSSocket) => {
    sni.push((socket as TLSSocket & { servername: string | false }).servername);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, requests, sni };
}

function transportTo(port: number) {
  const dialed: string[] = [];
  const transport = createStorefrontTransport({
    resolve: () => Promise.resolve([PUBLIC]),
    // The production connection, to the local port instead of 443.
    connect: (address, servername) => {
      dialed.push(address);
      return connectTls("127.0.0.1", servername, port);
    },
    timeoutMs: 3000,
  });
  return { transport, dialed };
}

const get = (transport: ReturnType<typeof createStorefrontTransport>) =>
  transport.send(transport.prepare(META_OPERATION, { url: `https://${HOST}/meta.json` }));

describe("the storefront transport over real TLS", () => {
  it("verifies the certificate for the host name, sends it as SNI, and reads the answer", async () => {
    const local = await serve(ca.server(HOST));
    const { transport, dialed } = transportTo(local.port);
    const answer = await get(transport);
    expect(answer.status).toBe(200);
    expect(Buffer.from(answer.body).toString()).toBe('{"myshopify_domain":"test-shop.myshopify.com"}');
    expect(local.sni).toEqual([HOST]);
    expect(local.requests).toEqual(["/meta.json"]);
    expect(dialed).toEqual([PUBLIC]);
  });

  it.each([
    ["a trusted certificate for another name (the IP it connected to proves nothing)", () => ca.server("other.example")],
    ["a certificate for the name from a CA nobody trusts", () => stranger.server(HOST)],
  ])("attack: %s is refused before any request is written", async (_what, identity) => {
    const local = await serve(identity());
    const { transport } = transportTo(local.port);
    const error = await get(transport).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorefrontTransportError);
    expect(local.requests).toEqual([]);
  });
});
