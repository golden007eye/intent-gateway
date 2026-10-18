// The merchant storefront as an outside destination (contract 1.6.1, Appendix G "Store pair check"; ADR-0020): one
// request only, `GET <merchant_origin>/meta.json`, behind the disclosure core (src/disclosure's connectStorefront), so
// the URL is logged before the request leaves and the answer is kept as a status, a digest and a size.
//
// The request carries a fixed header set (host, accept, user-agent, connection) and nothing else: no cookie, no
// credential, no Authorization, no buyer data, no body. The send:
// - resolves the host once, and refuses it unless every address it resolves to is public (no loopback, private,
//   link-local, CGNAT, documentation, multicast or reserved range, IPv4-mapped forms included);
// - connects to the address it checked, with TLS verified for the host name (SNI), so a DNS answer that changes
//   between the check and the connection (rebinding) is never used;
// - follows no redirect (a 3xx comes back as it is), stops reading at maxBodyBytes + 1, and gives up after timeoutMs
//   in total (DNS, connect, headers and body).
// A refusal before any connection throws StorefrontTransportError with `neverLeft`, so the log says "not sent".
import { lookup } from "node:dns/promises";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { STORE_PAIR_LIMITS } from "../contract/index.ts";

type HeaderPair = readonly [string, string];

/** One request as it goes on the wire (the shape of the disclosure core's OutboundRequest). */
export interface StorefrontRequest {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

export interface StorefrontResponse {
  readonly status: number;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

/** The shape of the disclosure core's DestinationTransport. */
export interface StorefrontTransport {
  prepare(operation: string, payload: unknown): StorefrontRequest;
  send(request: StorefrontRequest): Promise<StorefrontResponse>;
}

/** The one operation: the store pair check's GET. Its payload is `{url}`, a URL metaUrl built. */
export const META_OPERATION = "meta_json";
/** What the request names itself as: the gateway, never the developer. */
export const STOREFRONT_USER_AGENT = "intent-gateway (store pair check)";

/** A request the gateway refuses to build: another operation, or a URL that is not `https://<host>/meta.json`. */
export class StorefrontRequestError extends Error {
  override name = "StorefrontRequestError";
}

/**
 * No complete answer came back. `neverLeft`: no connection was made (the name did not resolve, or resolved to a
 * non-public address), so nothing left the machine. `reason` is in plain words and names no content.
 */
export class StorefrontTransportError extends Error {
  override name = "StorefrontTransportError";
  readonly neverLeft: boolean;
  readonly failure: string;
  readonly reason: string;
  constructor(host: string, failure: string, neverLeft: boolean, cause?: unknown) {
    super(`the storefront at ${host} cannot be checked (${failure})`, cause === undefined ? undefined : { cause });
    this.neverLeft = neverLeft;
    this.failure = failure;
    this.reason = failure;
  }
}

export interface StorefrontTransportOptions {
  /** Every address a host name resolves to. Default: the system resolver (getaddrinfo), all addresses. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Opens the connection to the checked address. Default: TLS to port 443, verified for `servername`. */
  readonly connect?: (address: string, servername: string) => Duplex;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

// The ranges a storefront never sits in (IANA special-purpose registries, plus multicast and the reserved blocks).
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96], // IPv4-compatible (deprecated)
  ["64:ff9b::", 96], // NAT64: refused whole (fails closed; an IPv6-only DNS64 network gets no store pair check)
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking)
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv6");
}

/** Whether an IP address is public: not in any non-public range, an IPv4-mapped IPv6 address judged as its IPv4. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, "").toLowerCase();
  const family = isIP(bare);
  if (family === 4) return !NON_PUBLIC.check(bare, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(?:0:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)?.[1] ?? hexMapped(bare);
  if (mapped !== null) return isPublicAddress(mapped);
  return !NON_PUBLIC.check(bare, "ipv6");
}

/** `::ffff:7f00:1` → `127.0.0.1`; null for any other form. */
function hexMapped(address: string): string | null {
  const m = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (m === null) return null;
  const hi = Number.parseInt(m[1] ?? "0", 16);
  const lo = Number.parseInt(m[2] ?? "0", 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

const defaultResolve = async (host: string): Promise<readonly string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
/**
 * The production connection: TLS to `address`, the certificate verified against the system CAs for `servername` (sent
 * as SNI). `port` is 443 in production; only the TLS test passes another, to reach a local server.
 */
export const connectTls = (address: string, servername: string, port = 443): Duplex =>
  tlsConnect({ host: address, port, servername, ALPNProtocols: ["http/1.1"], rejectUnauthorized: true });
const defaultConnect = (address: string, servername: string): Duplex => connectTls(address, servername);

const META_URL = /^https:\/\/([a-z0-9.-]{1,253})\/meta\.json$/;

/** The storefront transport. Every send is one `GET https://<host>/meta.json`. */
export function createStorefrontTransport(options: StorefrontTransportOptions = {}): StorefrontTransport {
  const resolve = options.resolve ?? defaultResolve;
  const connect = options.connect ?? defaultConnect;
  const timeoutMs = options.timeoutMs ?? STORE_PAIR_LIMITS.timeoutMs;
  const maxBodyBytes = options.maxBodyBytes ?? STORE_PAIR_LIMITS.maxBodyBytes;
  return {
    prepare(operation, payload) {
      if (operation !== META_OPERATION) throw new StorefrontRequestError(`the storefront transport has no operation ${JSON.stringify(operation)}`);
      const url = typeof payload === "object" && payload !== null ? (payload as { url?: unknown }).url : undefined;
      const host = typeof url === "string" ? META_URL.exec(url)?.[1] : undefined;
      if (typeof url !== "string" || host === undefined || isIP(host) !== 0) throw new StorefrontRequestError("a storefront request is GET https://<host>/meta.json");
      return {
        operation,
        method: "GET",
        path: url,
        headers: [
          ["host", host],
          ["accept", "application/json"],
          ["user-agent", STOREFRONT_USER_AGENT],
          ["connection", "close"],
        ],
        body: new Uint8Array(0),
      };
    },
    async send(request) {
      const host = META_URL.exec(request.path)?.[1];
      if (host === undefined || request.method !== "GET" || request.body.length > 0) throw new StorefrontRequestError("a storefront request is GET https://<host>/meta.json");
      const deadline = Date.now() + timeoutMs;
      let addresses: readonly string[];
      try {
        addresses = await withDeadline(resolve(host), deadline);
      } catch (error) {
        throw new StorefrontTransportError(host, "the name did not resolve", true, error);
      }
      // Every address, not only the one used: a name with a private address beside a public one is refused.
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new StorefrontTransportError(host, "the name resolves to a non-public address", true);
      const address = addresses[0] as string;
      return exchange(host, address, request, { connect, deadline, maxBodyBytes });
    },
  };
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout"));
    }, Math.max(0, deadline - Date.now()));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** One exchange over a connection to the checked address; the answer's body is cut at maxBodyBytes + 1. */
function exchange(
  host: string,
  address: string,
  request: StorefrontRequest,
  options: { connect: (address: string, servername: string) => Duplex; deadline: number; maxBodyBytes: number },
): Promise<StorefrontResponse> {
  return new Promise<StorefrontResponse>((resolve, reject) => {
    let settled = false;
    let connected = false;
    const finish = (error: Error | null, response?: StorefrontResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (error !== null) reject(error);
      else if (response !== undefined) resolve(response);
    };
    const fail = (failure: string, cause?: unknown): void => {
      finish(new StorefrontTransportError(host, failure, !connected, cause));
    };
    // A one-request agent whose only connection is to the checked address (`agent: false` would ignore
    // createConnection and let Node dial the host itself).
    const agent = new Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => {
      const socket = options.connect(address, host);
      socket.once("connect", () => {
        connected = true;
      });
      socket.once("secureConnect", () => {
        connected = true;
      });
      return socket;
    };
    const req = httpRequest(
      {
        method: "GET",
        host: address,
        port: 443,
        path: "/meta.json",
        headers: Object.fromEntries(request.headers),
        setHost: false,
        agent,
      },
      (res: IncomingMessage) => {
        connected = true;
        const status = res.statusCode ?? 0;
        const headers: HeaderPair[] = [];
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i] ?? "", res.rawHeaders[i + 1] ?? ""]);
        const chunks: Buffer[] = [];
        let size = 0;
        const limit = options.maxBodyBytes + 1;
        res.on("data", (chunk: Buffer) => {
          const room = limit - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          // Enough read to know it is too large: stop reading, and answer with what was read.
          if (size >= limit) finish(null, { status, headers, body: Buffer.concat(chunks) });
        });
        res.on("end", () => {
          finish(null, { status, headers, body: Buffer.concat(chunks) });
        });
        res.on("close", () => {
          if (!res.complete) fail("connection closed before the answer ended");
        });
        res.on("error", (error) => {
          fail("answer stream failed", error);
        });
      },
    );
    const timer = setTimeout(
      () => {
        fail("no complete answer within the time limit");
      },
      Math.max(0, options.deadline - Date.now()),
    );
    req.on("error", (error) => {
      fail(connected ? "network error" : `no connection (${(error as NodeJS.ErrnoException).code ?? "error"})`, error);
    });
    req.end();
  });
}
