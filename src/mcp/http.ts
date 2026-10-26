// MCP over Streamable HTTP at /mcp, the way the Docker image runs (ADR-0005).
//
// - Off loopback a bearer token is mandatory: without one (or with one shorter than 32 characters) runHttp refuses
//   to start. Config validates the same rule; this is the second lock, so no caller can open the port bare.
// - With a token, a request without `Authorization: Bearer <token>`, or with a wrong one, gets 401. The compare is
//   constant-time over sha256 digests, so neither the token nor its length leaks through timing.
// - The Host and Origin headers must name this server (421 otherwise), so a web page that rebinds a DNS name to the
//   loopback address cannot drive the tools through the user's browser. Bound to a wildcard address in a container,
//   any Host is accepted (the name the outside uses is unknown here), and the token carries the protection.
// - A body over MAX_BODY_BYTES gets 413 before it is parsed.
//
// The server is stateless: each POST gets its own MCP server and transport. What must persist between calls (the
// offers searched, the chain) lives in the gateway, which every request shares.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Gateway } from "../gateway/index.ts";
import { SERVER_INFO } from "./info.ts";
import type { McpHandle } from "./stdio.ts";
import { registerTools } from "./tools.ts";

export const MCP_PATH = "/mcp";
export const MAX_BODY_BYTES = 256 * 1024;
const MIN_TOKEN_LENGTH = 32;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

export interface HttpOptions {
  /** A started gateway (call gateway.start() first). */
  gateway: Gateway;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Required unless host is 127.0.0.1 or ::1. */
  token: string | null;
  /** Defaults to stderr. */
  log?: (line: string) => void;
  /** A line put first in every tool result (demo mode's banner). */
  banner?: string;
}

export interface HttpHandle extends McpHandle {
  /** http://host:port/mcp, with the port actually bound. */
  url: string;
  port: number;
}

/** runHttp refused its options: nothing was bound. */
export class McpHttpError extends Error {
  override name = "McpHttpError";
}

export async function runHttp(options: HttpOptions): Promise<HttpHandle> {
  const { gateway, host, token } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (token !== null && (token.length < MIN_TOKEN_LENGTH || /\s/.test(token))) {
    throw new McpHttpError(`the HTTP token must be at least ${String(MIN_TOKEN_LENGTH)} characters with no spaces`);
  }
  if (token === null && !LOOPBACK.has(host)) {
    throw new McpHttpError(`refusing to serve MCP on ${host} without a token: off loopback a bearer token is required`);
  }
  const tokenDigest = token === null ? null : digest(token);

  let allowedHosts: ReadonlySet<string> | null = new Set();
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`intent: MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) plain(res, 500, "internal error");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req, allowedHosts)) {
      plain(res, 421, "misdirected request: unknown Host or Origin");
      return;
    }
    if (new URL(req.url ?? "/", "http://x").pathname !== MCP_PATH) {
      plain(res, 404, "not found");
      return;
    }
    if (tokenDigest !== null && !bearerMatches(req.headers.authorization, tokenDigest)) {
      res.setHeader("www-authenticate", 'Bearer realm="intent-gateway"');
      {
      plain(res, 401, "missing or wrong bearer token");
      return;
    }
    }
    // Stateless: there is no session to stream to (GET) or to end (DELETE).
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      {
      plain(res, 405, "method not allowed");
      return;
    }
    }
    const body = await readBody(req);
    if (body === "too_large") {
      plain(res, 413, `request body over ${String(MAX_BODY_BYTES)} bytes`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      {
      plain(res, 400, "request body is not JSON");
      return;
    }
    }

    const mcp = new McpServer(SERVER_INFO);
    registerTools(mcp, gateway, options.banner === undefined ? {} : { banner: options.banner });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    // The SDK's transport class declares its optional callbacks without `| undefined`, which exactOptionalPropertyTypes rejects.
    await mcp.connect(transport as Transport);
    await transport.handleRequest(req, res, parsed);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  allowedHosts = allowedHostsFor(host, port);
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${String(port)}${MCP_PATH}`;
  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

/** The Host values this server answers to, or null for any (a wildcard bind, where the token is required). */
function allowedHostsFor(host: string, port: number): ReadonlySet<string> | null {
  if (WILDCARD.has(host)) return null;
  const p = String(port);
  const bound = host.includes(":") ? `[${host}]:${p}` : `${host}:${p}`;
  return new Set([bound, `localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`].map((h) => h.toLowerCase()));
}

/** Host must be allowed; an Origin, when sent, must be http(s) on an allowed host (or, unrestricted, on Host itself). */
function hostAllowed(req: IncomingMessage, allowed: ReadonlySet<string> | null): boolean {
  const hostHeader = req.headers.host?.toLowerCase();
  if (hostHeader === undefined || hostHeader === "") return false;
  if (allowed !== null && !allowed.has(hostHeader)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let originHost: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    originHost = parsed.host.toLowerCase();
  } catch {
    return false; // includes the opaque origin "null"
  }
  return allowed === null ? originHost === hostHeader : allowed.has(originHost);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  const given = match?.[1];
  // Compare even when the header is missing, so a missing and a wrong token take the same path.
  const ok = timingSafeEqual(digest(given ?? ""), expected);
  return given !== undefined && ok;
}

/** The body, or "too_large" as soon as it passes the cap (the rest is drained unread, so the 413 can be sent). */
function readBody(req: IncomingMessage): Promise<Buffer | "too_large"> {
  if (Number(req.headers["content-length"] ?? "0") > MAX_BODY_BYTES) {
    req.resume();
    return Promise.resolve("too_large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      req.off("data", onData);
      req.resume();
      chunks.length = 0;
      resolve("too_large");
    };
    req.on("data", onData);
    req.once("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.once("error", reject);
  });
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(`${text}\n`);
}
