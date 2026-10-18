// The one HTTP adapter to Intent Cloud. Every request carries exactly the fixed header set of plan §3.1, plus
// `intent-contract-version: 1.6.1` (contract 1.6.1), in a fixed order, on a fresh connection that is closed
// afterwards, so what the disclosure log records is byte for byte what left the machine. A caller's beforeSend hook
// sees the final request before any byte is written; when it throws, nothing is sent (invariant 2 is kept by
// src/disclosure through that hook).
import { type Agent, type IncomingMessage, request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { z } from "zod";
import {
  approvalPath,
  approvalsPath,
  type ApprovalCreated,
  type ApprovalStatus,
  type Cart,
  type CartRequest,
  type CheckoutRequest,
  CONTRACT_VERSION,
  ENDPOINTS,
  errorBody,
  type ErrorBody,
  HEADERS,
  type Jwks,
  type KeyStatement,
  type Meta,
  type OperationId,
  outcomeReportsPath,
  type OutcomeReport,
  type OutcomeReportAccepted,
  type RateLimited,
  type SearchRequest,
  type SearchResponse,
} from "../contract/index.ts";
import { canonicalize, nonIntegerToken } from "../jcs/index.ts";
import { contentDigest, type Session, signRequest } from "../signing/index.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;
/** The request header that names the caller's contract version, as sent (lowercase, like every header here). */
export const CONTRACT_VERSION_HEADER = "intent-contract-version";
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export type HeaderPair = readonly [name: string, value: string];

/** One request exactly as it goes on the wire: the header pairs in send order and the body bytes. */
export interface PreparedRequest {
  readonly operation: OperationId;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

export interface CallOptions {
  /** Runs once the request is final and before any byte is sent. If it throws or rejects, nothing is sent. */
  beforeSend?: (request: PreparedRequest) => void | Promise<void>;
  /**
   * Signs this one request with another key than the adapter's session: an approval's completer key (contract 1.6.0,
   * Appendix G R1/R7), which Intent Cloud accepts for reads and reports of that approval only.
   */
  session?: Session;
}

/** The two appendix-D headers as received; trust (G15) verifies them. */
export interface ReceiptHeaders {
  header: string;
  signature: string;
}

export interface RawExchange {
  request: PreparedRequest;
  /** The response headers as received, in order (Node's rawHeaders, paired). */
  responseHeaders: readonly HeaderPair[];
  responseBytes: Uint8Array;
}

interface ResultCommon {
  /** Both receipt headers, each present once and well formed; otherwise null. */
  receipt: ReceiptHeaders | null;
  /** `Intent-Contract-Version` when present once and well formed; otherwise null. */
  contractVersion: string | null;
  /** `Retry-After` in seconds on a 429, through Number(); null when absent, malformed or not a 429. */
  retryAfter: number | null;
  raw: RawExchange;
}

/**
 * A response. `ok` is the endpoint's success status with a body that passed its schema. Otherwise the body passed
 * the schema the spec gives that status (ErrorBody, or RateLimited for 429), or is null for a status the spec does
 * not list for the endpoint (a 5xx, a 3xx, an edge error page).
 */
export type CloudResult<T> = ResultCommon &
  ({ ok: true; status: number; body: T } | { ok: false; status: number; body: ErrorBody | RateLimited | null });

export interface IntentCloud {
  meta(options?: CallOptions): Promise<CloudResult<Meta>>;
  signatureKeys(options?: CallOptions): Promise<CloudResult<Jwks>>;
  keyStatement(options?: CallOptions): Promise<CloudResult<KeyStatement>>;
  search(request: SearchRequest, options?: CallOptions): Promise<CloudResult<SearchResponse>>;
  createCart(request: CartRequest, options?: CallOptions): Promise<CloudResult<Cart>>;
  createApproval(cartHandle: string, options?: CallOptions): Promise<CloudResult<ApprovalCreated>>;
  /** 1.7.0: submits a Shop checkout the gateway created and read back; the answer is its pending approval. */
  createCheckout(request: CheckoutRequest, options?: CallOptions): Promise<CloudResult<ApprovalCreated>>;
  getApproval(approvalHandle: string, options?: CallOptions): Promise<CloudResult<ApprovalStatus>>;
  reportOutcome(approvalHandle: string, report: OutcomeReport, options?: CallOptions): Promise<CloudResult<OutcomeReportAccepted>>;
}

export interface HttpCloudOptions {
  /** `https://host[:port]`, or `http://127.0.0.1:port` / `http://[::1]:port` for a local fake. No path. */
  baseUrl: string;
  session: Session;
  /** A fresh agent per request (for example one with a test CA). Defaults to `agent: false`. Keep-alive is refused. */
  agentFactory?: () => Agent;
  /** Milliseconds since the epoch, for the signature's `created`. Defaults to Date.now. */
  now?: () => number;
  /** Whole-exchange deadline. Defaults to 30 s. */
  timeoutMs?: number;
  /** Largest response body accepted. Defaults to 1 MiB. */
  maxResponseBytes?: number;
  /**
   * Called with the host when a request sent `afterMs` ago has no complete response yet, once per request, so a
   * command can say it is still waiting instead of hanging silently until the deadline. Its timer starts when the
   * request is sent, after beforeSend, so time spent logging it is not counted. `timeoutMs` is this adapter's
   * deadline, so the notice can say when the wait ends.
   */
  slow?: { afterMs: number; notify: (host: string, timeoutMs: number) => void };
}

/** The request was refused before anything was sent: a bad base URL, request body or handle. */
export class CloudRequestError extends Error {
  override name = "CloudRequestError";
}

/**
 * No complete response arrived: connection failure, reset or timeout. The request may have reached Cloud, unless
 * `neverLeft`: the host name did not resolve, or no connection could be opened, so no byte of the request was sent.
 */
export class CloudNetworkError extends Error {
  override name = "CloudNetworkError";
  readonly reason: "network" | "timeout";
  readonly request: PreparedRequest;
  /** True only when no connection was ever made (DNS failure, refused, unreachable): nothing left the machine. */
  readonly neverLeft: boolean;
  /** What failed, in plain words with no error code: `DNS: not found`, `connection refused`, … */
  readonly failure: string;
  constructor(
    reason: "network" | "timeout",
    request: PreparedRequest,
    message: string,
    options?: ErrorOptions & { neverLeft?: boolean; failure?: string },
  ) {
    super(message, options);
    this.reason = reason;
    this.request = request;
    this.neverLeft = options?.neverLeft ?? false;
    this.failure = options?.failure ?? reason;
  }
}

/**
 * A failed connection's error code in plain words, and whether it proves that no connection was made. Only a failed
 * lookup or a connection that was never opened counts as never sent; anything else may have reached Cloud.
 */
export function networkFailure(code: unknown): { words: string; neverLeft: boolean } {
  switch (code) {
    case "ENOTFOUND":
      return { words: "DNS: not found", neverLeft: true };
    case "EAI_AGAIN":
    case "EAI_FAIL":
      return { words: "DNS: lookup failed", neverLeft: true };
    case "ECONNREFUSED":
      return { words: "connection refused", neverLeft: true };
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ENETDOWN":
      return { words: "network unreachable", neverLeft: true };
    case "ETIMEDOUT":
      return { words: "connection timed out", neverLeft: false };
    case "ECONNRESET":
    case "EPIPE":
      return { words: "connection reset", neverLeft: false };
    default:
      return {
        words: typeof code === "string" && /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ? "TLS: the certificate is not trusted or the handshake failed" : "network error",
        neverLeft: false,
      };
  }
}

/** A response arrived but is unusable: too large, not JSON, or not the schema the spec gives its status. */
export class CloudResponseError extends Error {
  override name = "CloudResponseError";
  readonly reason: "too_large" | "not_json" | "schema";
  readonly status: number;
  readonly receipt: ReceiptHeaders | null;
  readonly contractVersion: string | null;
  /** responseBytes is empty for too_large: the body was not kept. */
  readonly raw: RawExchange;
  constructor(
    reason: "too_large" | "not_json" | "schema",
    status: number,
    meta: { receipt: ReceiptHeaders | null; contractVersion: string | null; raw: RawExchange },
    message: string,
  ) {
    super(message);
    this.reason = reason;
    this.status = status;
    this.receipt = meta.receipt;
    this.contractVersion = meta.contractVersion;
    this.raw = meta.raw;
  }
}

interface Target {
  secure: boolean;
  hostname: string;
  port: number;
  host: string;
}

function parseBaseUrl(baseUrl: string): Target {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CloudRequestError(`base URL is not a URL: ${JSON.stringify(baseUrl)}`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new CloudRequestError("base URL must be scheme://host[:port] only");
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]"))) {
    throw new CloudRequestError("base URL must be https, or http on 127.0.0.1 or [::1]");
  }
  return {
    secure,
    hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
    host: url.host,
  };
}

function pairs(raw: readonly string[]): HeaderPair[] {
  const out: HeaderPair[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i] ?? "", raw[i + 1] ?? ""]);
  return out;
}

/** The value of a header present exactly once (case-insensitive), or null. */
function single(headers: readonly HeaderPair[], name: string): string | null {
  const found = headers.filter(([key]) => key.toLowerCase() === name.toLowerCase());
  return found.length === 1 ? (found[0]?.[1] ?? null) : null;
}

function readHeaders(status: number, headers: readonly HeaderPair[]): Omit<ResultCommon, "raw"> {
  const valid = (spec: { name: string; schema: z.ZodType }, value: unknown): boolean =>
    value !== null && spec.schema.safeParse(value).success;
  const header = single(headers, HEADERS.IntentReceipt.name);
  const signature = single(headers, HEADERS.IntentReceiptSignature.name);
  const version = single(headers, HEADERS.IntentContractVersion.name);
  const retryText = single(headers, HEADERS.RetryAfter.name);
  const retry = retryText === null || retryText.trim() === "" ? null : Number(retryText);
  return {
    receipt:
      header !== null && signature !== null && valid(HEADERS.IntentReceipt, header) && valid(HEADERS.IntentReceiptSignature, signature)
        ? { header, signature }
        : null,
    contractVersion: version !== null && valid(HEADERS.IntentContractVersion, version) ? version : null,
    retryAfter: status === 429 && retry !== null && valid(HEADERS.RetryAfter, retry) ? retry : null,
  };
}

interface Exchange {
  status: number;
  headers: HeaderPair[];
  body: Buffer | null; // null when the body exceeded the cap
}

/** Creates the adapter. Throws CloudRequestError for a base URL that is not https or loopback http. */
export function createHttpCloud(options: HttpCloudOptions): IntentCloud {
  const target = parseBaseUrl(options.baseUrl);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  function prepare(operation: OperationId, path: string, payload: unknown, session: Session): PreparedRequest {
    const endpoint = ENDPOINTS[operation];
    let body: Uint8Array = new Uint8Array(0);
    if (endpoint.request !== null) {
      const checked = endpoint.request.safeParse(payload);
      if (!checked.success) throw new CloudRequestError(`${operation} request does not match the contract: ${checked.error.message}`);
      body = Buffer.from(canonicalize(payload), "utf8");
    }
    const headers: HeaderPair[] = [["host", target.host]];
    if (endpoint.request !== null) headers.push(["content-type", "application/json"]);
    // The caller's contract version (contract 1.6.1): unsigned, logged with the rest of the header set.
    headers.push(["accept", "application/json"], [CONTRACT_VERSION_HEADER, CONTRACT_VERSION]);
    if (endpoint.signed) {
      const signed = signRequest(session, { method: endpoint.method, path, body, created: Math.floor(now() / 1000) });
      headers.push(
        ["content-digest", signed["content-digest"]],
        ["signature-input", signed["signature-input"]],
        ["signature", signed.signature],
      );
    } else {
      headers.push(["content-digest", contentDigest(body)]);
    }
    headers.push(["content-length", String(body.length)], ["connection", "close"]);
    return { operation, method: endpoint.method, path, headers, body };
  }

  /** The caller's agent for one request, refused when it keeps connections alive. Called before beforeSend. */
  function requestAgent(): Agent | undefined {
    const agent = options.agentFactory?.();
    // Node sets Agent#keepAlive at runtime; @types/node does not declare it.
    if (agent !== undefined && (agent as Agent & { keepAlive?: boolean }).keepAlive === true) {
      agent.destroy();
      throw new CloudRequestError("agentFactory returned a keep-alive agent");
    }
    return agent;
  }

  function send(request: PreparedRequest, agent: Agent | undefined): Promise<Exchange> {
    const requestOptions: RequestOptions = {
      method: request.method,
      hostname: target.hostname,
      port: target.port,
      path: request.path,
      headers: Object.fromEntries(request.headers),
      setHost: false,
      agent: agent ?? false,
    };
    return new Promise<Exchange>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, exchange?: Exchange): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(slowTimer);
        req.destroy();
        agent?.destroy();
        if (error !== null) reject(error);
        else if (exchange !== undefined) resolve(exchange);
      };
      const fail = (reason: "network" | "timeout", words: string, cause?: unknown, neverLeft = false): void => {
        const message = `Intent Cloud at ${target.host} cannot be reached (${words})`;
        finish(new CloudNetworkError(reason, request, message, { neverLeft, failure: words, ...(cause === undefined ? {} : { cause }) }));
      };
      const req = (target.secure ? httpsRequest : httpRequest)(requestOptions, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const headers = pairs(res.rawHeaders);
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > maxBytes) {
          finish(null, { status, headers, body: null });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) finish(null, { status, headers, body: null });
          else chunks.push(chunk);
        });
        res.on("end", () => {
          finish(null, { status, headers, body: Buffer.concat(chunks) });
        });
        res.on("close", () => {
          if (!res.complete) fail("network", "connection closed before the response ended");
        });
        res.on("error", (error) => {
          fail("network", "response stream failed", error);
        });
      });
      const timer = setTimeout(() => {
        const within = timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)} s` : `${String(timeoutMs)} ms`;
        fail("timeout", `no complete response within ${within}`);
      }, timeoutMs);
      const { slow } = options;
      const slowTimer =
        slow === undefined
          ? undefined
          : setTimeout(() => {
              slow.notify(target.host, timeoutMs);
            }, slow.afterMs);
      req.on("error", (error) => {
        const { words, neverLeft } = networkFailure((error as NodeJS.ErrnoException).code);
        fail("network", words, error, neverLeft);
      });
      req.end(request.body.length > 0 ? request.body : undefined);
    });
  }

  async function call<T>(operation: OperationId, path: string, payload: unknown, callOptions?: CallOptions): Promise<CloudResult<T>> {
    const request = prepare(operation, path, payload, callOptions?.session ?? options.session);
    // Every refusal comes before beforeSend, so a request that never leaves is never logged as sent.
    const agent = requestAgent();
    try {
      await callOptions?.beforeSend?.(request);
    } catch (error) {
      agent?.destroy();
      throw error;
    }
    const exchange = await send(request, agent);
    const { status, headers } = exchange;
    const meta = readHeaders(status, headers);
    const raw: RawExchange = { request, responseHeaders: headers, responseBytes: exchange.body ?? new Uint8Array(0) };
    const common: ResultCommon = { ...meta, raw };
    if (exchange.body === null) {
      throw new CloudResponseError("too_large", status, common, `${operation} response is larger than ${String(maxBytes)} bytes`);
    }
    const endpoint = ENDPOINTS[operation];
    const listed = endpoint.errors as readonly number[];
    let schema: z.ZodType;
    if (status === endpoint.status) schema = endpoint.response;
    else if (listed.includes(status)) schema = errorBody(status);
    else return { ...common, ok: false, status, body: null };

    let json: unknown;
    const text = exchange.body.toString("utf8");
    try {
      json = JSON.parse(text);
    } catch {
      throw new CloudResponseError("not_json", status, common, `${operation} ${String(status)} body is not JSON`);
    }
    // Amendment item 9: JSON.parse cannot tell 1.0 from 1, so a non-integer number token anywhere is refused.
    if (nonIntegerToken(text) !== null) {
      throw new CloudResponseError("schema", status, common, `${operation} ${String(status)} body has a number that is not an integer`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CloudResponseError("schema", status, common, `${operation} ${String(status)} body does not match the contract`);
    }
    if (status === endpoint.status) return { ...common, ok: true, status, body: parsed.data as T };
    return { ...common, ok: false, status, body: parsed.data as ErrorBody | RateLimited };
  }

  function handlePath(build: (handle: string) => string, handle: string): string {
    try {
      return build(handle);
    } catch {
      throw new CloudRequestError(`malformed handle ${JSON.stringify(handle)}`);
    }
  }

  return {
    meta: (o) => call<Meta>("getMeta", ENDPOINTS.getMeta.path, undefined, o),
    signatureKeys: (o) => call<Jwks>("getSignatureKeys", ENDPOINTS.getSignatureKeys.path, undefined, o),
    keyStatement: (o) => call<KeyStatement>("getKeyStatement", ENDPOINTS.getKeyStatement.path, undefined, o),
    search: (r, o) => call<SearchResponse>("searchCatalog", ENDPOINTS.searchCatalog.path, r, o),
    createCart: (r, o) => call<Cart>("createCart", ENDPOINTS.createCart.path, r, o),
    createCheckout: (r, o) => call<ApprovalCreated>("createCheckout", ENDPOINTS.createCheckout.path, r, o),
    createApproval: async (h, o) => call<ApprovalCreated>("createApproval", handlePath(approvalsPath, h), undefined, o),
    getApproval: async (h, o) => call<ApprovalStatus>("getApproval", handlePath(approvalPath, h), undefined, o),
    reportOutcome: async (h, r, o) => call<OutcomeReportAccepted>("reportOutcome", handlePath(outcomeReportsPath, h), r, o),
  };
}
