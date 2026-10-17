// The wire to Shop: our own JSON-RPC MCP client over node:http(s) (plan D1 A), so the disclosure core logs the very
// bytes that are sent. Two transports, each a DestinationTransport in shape (src/disclosure wraps them; this module
// never imports it):
// - Shop's MCP server (destination `shop`): `tools/call` only, to the tools on SHOP_TOOLS and nothing else. Shop
//   speaks MCP 2026-07-28 statelessly: there is no `initialize` (Shop refuses it), and every request carries the
//   `Mcp-Method` header (plus `Mcp-Name` for a tool call) and a `params._meta` block naming the protocol version, the
//   client's capabilities and the client.
// - Shop's account server (destination `shop_accounts`): the RFC 7009 revocation, a form body with no client secret.
// Every request goes on a fresh connection that is closed afterwards, with a 30 s timeout and a 1 MiB answer cap, as
// for Intent Cloud.
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { MCP_CLIENT_NAME } from "../privacy/index.ts";

/** The MCP protocol version Shop speaks; it refuses `initialize`, so every request names it in `_meta`. */
export const MCP_PROTOCOL = "2026-07-28";
export const DEFAULT_SHOP_MCP_URL = "https://mcp.shop.com/";
export const DEFAULT_SHOP_AUTH_URL = "https://accounts.shop.app/";
/** The only Shop tools the gateway calls (plan G7a). Any other tool Shop advertises, a spend request included, is never called. */
export const SHOP_TOOLS = ["get_account", "create_checkout", "complete_checkout", "get_checkout", "search_orders"] as const;
export type ShopTool = (typeof SHOP_TOOLS)[number];
/** The account server's one operation in this module (sign-in comes with `intent wallet link`, plan G8). */
export const REVOKE = "revoke";
/** The client name the gateway gives in each request's `_meta`: exactly the one the identity check lets through. */
export const CLIENT_NAME = MCP_CLIENT_NAME;
export const TIMEOUT_MS = 30_000;
export const MAX_ANSWER_BYTES = 1024 * 1024;

export type HeaderPair = readonly [name: string, value: string];

/** One request as it goes on the wire (the shape of the disclosure core's OutboundRequest). */
export interface WireRequest {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

export interface WireResponse {
  readonly status: number;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

/** The shape of the disclosure core's DestinationTransport: prepare builds every byte, send writes exactly those. */
export interface ShopTransport {
  prepare(operation: string, payload: unknown): WireRequest;
  send(request: WireRequest): Promise<WireResponse>;
}

/** A request the gateway refuses to build: a tool off the allow-list, or an operation this transport does not have. Nothing is logged or sent. */
export class ShopRequestError extends Error {
  override name = "ShopRequestError";
}

/**
 * No complete answer came back. `neverLeft`: no connection was made, so nothing left the machine (the disclosure's
 * follow-up then says "not sent"). `reason` is in plain words and names no content.
 */
export class ShopTransportError extends Error {
  override name = "ShopTransportError";
  readonly neverLeft: boolean;
  readonly failure: string;
  readonly reason: string;
  constructor(host: string, failure: string, neverLeft: boolean, cause?: unknown) {
    super(`Shop at ${host} cannot be reached (${failure})`, cause === undefined ? undefined : { cause });
    this.neverLeft = neverLeft;
    this.failure = failure;
    this.reason = failure;
  }
}

export interface TransportOptions {
  /** An https URL, or http on a loopback host (the fake Shop in tests). */
  readonly url: string;
  readonly timeoutMs?: number;
  readonly maxAnswerBytes?: number;
}

export interface McpTransportOptions extends TransportOptions {
  /** The bearer token. It goes only into the `authorization` header, which the disclosure core digests in the log. */
  readonly accessToken: string;
  /** The gateway's version, for the client name in `_meta`. */
  readonly clientVersion: string;
}

/** The transport to Shop's MCP server. prepare(tool, arguments) builds one `tools/call`. */
export function createShopMcpTransport(options: McpTransportOptions): ShopTransport {
  const target = parseTarget(options.url);
  let id = 0;
  return {
    prepare(operation, payload) {
      if (!(SHOP_TOOLS as readonly string[]).includes(operation)) {
        throw new ShopRequestError(`the gateway never calls the Shop tool ${JSON.stringify(operation)}; it calls only ${SHOP_TOOLS.join(", ")}`);
      }
      const method = "tools/call";
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params: {
            name: operation,
            arguments: payload,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: CLIENT_NAME, version: options.clientVersion },
            },
          },
        }),
        "utf8",
      );
      const headers: HeaderPair[] = [
        ["host", target.host],
        ["content-type", "application/json"],
        ["accept", "application/json, text/event-stream"],
        ["mcp-protocol-version", MCP_PROTOCOL],
        ["mcp-method", method],
        ["mcp-name", operation],
        ["authorization", `Bearer ${options.accessToken}`],
        ["content-length", String(body.length)],
        ["connection", "close"],
      ];
      return { operation, method: "POST", path: target.path, headers, body };
    },
    send: (request) => exchange(target, request, options),
  };
}

/** The transport to Shop's account server: `revoke` with {token, token_type_hint, client_id}, as a form (RFC 7009). */
export function createShopAccountsTransport(options: TransportOptions): ShopTransport {
  const target = parseTarget(options.url);
  return {
    prepare(operation, payload) {
      if (operation !== REVOKE) throw new ShopRequestError(`the Shop account server has no operation ${JSON.stringify(operation)} here`);
      const fields = payload as Record<string, string>;
      const body = Buffer.from(new URLSearchParams(Object.entries(fields)).toString(), "utf8");
      const headers: HeaderPair[] = [
        ["host", target.host],
        ["content-type", "application/x-www-form-urlencoded"],
        ["accept", "application/json"],
        ["content-length", String(body.length)],
        ["connection", "close"],
      ];
      return { operation, method: "POST", path: `${target.path.replace(/\/$/, "")}/oauth/revoke`, headers, body };
    },
    send: (request) => exchange(target, request, options),
  };
}

interface Target {
  secure: boolean;
  hostname: string;
  port: number;
  host: string;
  path: string;
}

function parseTarget(raw: string): Target {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ShopRequestError("a Shop URL must use https (http only on a loopback host)");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ShopRequestError("a Shop URL must not carry credentials, a query or a fragment");
  }
  const secure = url.protocol === "https:";
  return {
    secure,
    hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
    host: url.host,
    path: url.pathname,
  };
}

function exchange(target: Target, request: WireRequest, options: TransportOptions): Promise<WireResponse> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = options.maxAnswerBytes ?? MAX_ANSWER_BYTES;
  return new Promise<WireResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response?: WireResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (error !== null) reject(error);
      else if (response !== undefined) resolve(response);
    };
    const fail = (failure: string, neverLeft = false, cause?: unknown): void => {
      finish(new ShopTransportError(target.host, failure, neverLeft, cause));
    };
    const req = (target.secure ? httpsRequest : httpRequest)(
      {
        method: request.method,
        hostname: target.hostname,
        port: target.port,
        path: request.path,
        headers: Object.fromEntries(request.headers),
        setHost: false,
        agent: false,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const headers: HeaderPair[] = [];
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i] ?? "", res.rawHeaders[i + 1] ?? ""]);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) fail(`the answer is larger than ${String(maxBytes)} bytes`);
          else chunks.push(chunk);
        });
        res.on("end", () => {
          finish(null, { status, headers, body: Buffer.concat(chunks) });
        });
        res.on("close", () => {
          if (!res.complete) fail("connection closed before the answer ended");
        });
        res.on("error", (error) => {
          fail("answer stream failed", false, error);
        });
      },
    );
    const timer = setTimeout(() => {
      fail(`no complete answer within ${String(timeoutMs / 1000)} s`);
    }, timeoutMs);
    req.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      const neverLeft = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH";
      fail(neverLeft ? `no connection (${code})` : "network error", neverLeft, error);
    });
    req.end(request.body.length > 0 ? request.body : undefined);
  });
}
