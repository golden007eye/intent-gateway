// The disclosure core: the one place a request to an outside destination is checked, logged and followed up
// (invariant 2: log before send; part of invariant 3). The destination wrappers (disclosure.ts) only say which
// adapter call to run and how its answer is acknowledged; the order of checks, appends and the stop rule live here.
//
// One core serves every destination (ADR-0014): Intent Cloud and each wallet destination share its gateway session
// and its stop, so a failed append around a send to any destination stops sends to all of them.
//
// Per call, through the adapter's beforeSend hook on the final request bytes:
// 1. findIdentity on the outbound JSON body: a finding appends a `block` entry and throws DisclosureBlockedError.
// 2. Credentials are digested in what is logged, never in what is sent: an `authorization` header, every body value
//    under a secret key (privacy's SECRET_KEYS) and every value at one of the caller's secretPaths becomes
//    `[redacted sha256:<hex>]`, and `redacted: [{at, sha256}]` lists them. A body with a redacted value is logged as
//    the JSON text of the redacted value; every other byte is logged exactly as sent.
// 3. The gateway session's `session` entry (once), then the `disclosure` entry; if either append throws, beforeSend
//    throws, the adapter sends nothing, and the core stops for good. A disclosure to a destination other than Intent
//    Cloud carries `destination`, and may carry the local field `purchase` (never sent).
// 4. After the exchange, the follow-up the caller's `answered` appends (or `unacknowledged` when no response came
//    back). If that append throws, the core stops for good.
import { randomUUID } from "node:crypto";
import { CloudNetworkError, CloudResponseError, type HeaderPair } from "../cloud/index.ts";
import {
  type Finding,
  findIdentity,
  formatPath,
  isCredentialHeader,
  isSecretKey,
  markerDigest,
  type PathSegment,
  redactionMarker,
  secretDigest,
} from "../privacy/index.ts";
import { NOT_SENT_REASON, type Store } from "../store/index.ts";

/** Where a request goes: `intent_cloud`, or a wallet destination such as `shop`. A disclosure without `destination` went to Intent Cloud. */
export type Destination = string;
export const INTENT_CLOUD = "intent_cloud";
/** A destination name: lower-case letters, digits and `_`, starting with a letter. */
export const DESTINATION_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** One digested credential in a logged request: where it sits (`headers.<name>` or `body.<path>`) and its sha256. */
export interface Redaction {
  readonly at: string;
  readonly sha256: string;
}

/** One request exactly as it goes on the wire to an outside destination: header pairs in send order, body bytes. */
export interface OutboundRequest {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

/** The answer of an outside destination, as received. */
export interface TransportResponse {
  readonly status: number;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

/**
 * The port every adapter to an outside destination implements. `prepare` builds the final request (every header and
 * body byte) without sending anything; `send` writes exactly those bytes and returns the answer. The disclosure core
 * logs the prepared request between the two, the role the Intent Cloud adapter's beforeSend hook plays: when the log
 * fails, `send` is never called.
 */
export interface DestinationTransport {
  prepare(operation: string, payload: unknown): OutboundRequest;
  /**
   * Sends the prepared request. When no connection was ever made (nothing left the machine), it throws an error
   * with `neverLeft: true` and `failure` in plain words, so the follow-up says "not sent".
   */
  send(request: OutboundRequest): Promise<TransportResponse>;
}

/** The outbound body looked like buyer identity; a `block` entry was written and nothing was sent. */
export class DisclosureBlockedError extends Error {
  override name = "DisclosureBlockedError";
  readonly endpoint: string;
  readonly findings: readonly Finding[];
  constructor(endpoint: string, findings: readonly Finding[]) {
    super(`${endpoint} not sent: the request body looks like buyer identity (${findings.map(describe).join(", ")})`);
    this.endpoint = endpoint;
    this.findings = findings;
  }
}

/**
 * An append around an earlier send failed, so this disclosure core sends nothing more: a send whose answer could not
 * be recorded must stay the last one of its gateway session (invariant 2). Restarting the gateway starts a new one.
 */
export class DisclosureStoppedError extends Error {
  override name = "DisclosureStoppedError";
}

/** What the core logged for one request: its seq and the body of its `disclosure` entry. */
export interface Logged<B> {
  readonly seq: number;
  readonly body: B;
}

export interface DiscloseSteps<R, B> {
  /** Runs the adapter call, handing it the core's beforeSend. */
  run: (beforeSend: (request: OutboundRequest) => Promise<void>) => Promise<R>;
  /** The `disclosure` entry's body (without `session`, which the core adds) for the final request. */
  body: (request: OutboundRequest, fields: string[]) => B;
  /** Appends the follow-up to a returned result; returns a reason when the result's content must not be returned. */
  answered: (logged: Logged<B>, result: R) => Promise<string | null>;
  /** Appends the follow-up to a thrown adapter error that still carries a response (CloudResponseError). */
  answeredError?: (logged: Logged<B>, error: CloudResponseError) => Promise<unknown>;
  /** Builds the error thrown when `answered` returns a reason. */
  discard: (logged: Logged<B>, result: R, reason: string) => Error;
}

export interface DiscloseOptions {
  /** Body paths whose values are digested in the log, besides the secret keys found anywhere. */
  readonly secretPaths?: readonly (readonly PathSegment[])[];
  /** The approval handle a wallet send belongs to, kept in the disclosure entry only; never sent. */
  readonly purchase?: string;
}

export interface DisclosureCore {
  /** Logs, sends (through `steps.run`) and follows up one request to `destination`. */
  disclose<R, B extends object>(
    destination: Destination,
    steps: DiscloseSteps<R, B>,
    options?: DiscloseOptions,
  ): Promise<{ result: R; seq: number }>;
  /** Throws DisclosureStoppedError once an append around a send has failed. */
  assertOpen(): void;
  /** The chain the core appends to, for a destination's own follow-up entries. */
  readonly store: Store;
}

// The core behind each disclosed cloud, so a wallet destination shares its gateway session and its stop.
const cores = new WeakMap<object, DisclosureCore>();

/** Records `core` as the one behind `owner` (a disclosed cloud). */
export function registerCore(owner: object, core: DisclosureCore): void {
  cores.set(owner, core);
}

/** The core behind a disclosed cloud built by createDisclosedCloud. */
export function coreOf(owner: object): DisclosureCore {
  const core = cores.get(owner);
  if (core === undefined) throw new TypeError("not a disclosed cloud: build it with connectCloud or createDisclosedCloud");
  return core;
}

export function createDisclosureCore(store: Store): DisclosureCore {
  const session = { id: randomUUID(), next: 0, open: new Set<number>() };
  let sessionEntry: Promise<unknown> | null = null;
  let stopped: string | null = null;

  /** Stops every later send, for good (the first reason is kept), and returns the error that says so. */
  function stop(reason: string, cause: unknown): DisclosureStoppedError {
    stopped ??= `${reason}: ${cause instanceof Error ? cause.message : String(cause)}`;
    return stoppedError(cause);
  }
  function stoppedError(cause?: unknown): DisclosureStoppedError {
    const message = `the gateway sends nothing more: ${String(stopped)}`;
    return new DisclosureStoppedError(message, cause === undefined ? undefined : { cause });
  }
  function assertOpen(): void {
    if (stopped !== null) throw stoppedError();
  }

  async function disclose<R, B extends object>(
    destination: Destination,
    steps: DiscloseSteps<R, B>,
    options: DiscloseOptions = {},
  ): Promise<{ result: R; seq: number }> {
    assertOpen();
    const elsewhere = destination === INTENT_CLOUD ? {} : { destination };
    // A holder, not locals, because beforeSend fills it inside the adapter's call.
    const logged: { entry: Logged<B> | null; n: number } = { entry: null, n: -1 };
    const beforeSend = async (request: OutboundRequest): Promise<void> => {
      assertOpen();
      const json = parseBody(request.body);
      const fields = fieldNames(json);
      const findings = findIdentity(json);
      if (findings.length > 0) {
        await store.append("block", { endpoint: request.operation, ...elsewhere, fields, blocked: findings.map(describe) });
        throw new DisclosureBlockedError(request.operation, findings);
      }
      try {
        sessionEntry ??= store.append("session", { id: session.id });
        await sessionEntry;
      } catch (error) {
        // The store's own error is what this call reports (it names a fence or a disk failure); later calls are refused.
        stop("the session entry could not be logged", error);
        throw error;
      }
      // From here to the append call nothing awaits, so the store's FIFO queue keeps n in chain order.
      const n = session.next++;
      const { request: kept, redacted } = redact(request, json, options.secretPaths ?? []);
      const body = {
        ...steps.body(kept, fields),
        ...elsewhere,
        ...(redacted.length === 0 ? {} : { redacted }),
        ...(options.purchase === undefined ? {} : { purchase: options.purchase }),
        session: { id: session.id, n, open: [...session.open].sort((a, b) => a - b) },
      };
      session.open.add(n);
      let entry;
      try {
        entry = await store.append("disclosure", body);
      } catch (error) {
        stop(`a request to ${request.operation} could not be logged, so it was not sent`, error);
        throw error;
      }
      logged.entry = { seq: entry.seq, body };
      logged.n = n;
    };

    /** Appends the follow-up; if that fails, nothing is sent again (the disclosure must stay last in its session). */
    async function answer<V>(seq: number, append: () => Promise<V>): Promise<V> {
      let value: V;
      try {
        value = await append();
      } catch (error) {
        throw stop(`the answer to disclosure #${String(seq)} could not be logged`, error);
      }
      session.open.delete(logged.n);
      return value;
    }

    let result: R;
    try {
      result = await steps.run(beforeSend);
    } catch (error) {
      // entry is null when the request never got past beforeSend: nothing was sent, so nothing follows the log.
      const entry = logged.entry;
      if (entry !== null) {
        await answer<unknown>(entry.seq, () =>
          error instanceof CloudResponseError && steps.answeredError !== undefined
            ? steps.answeredError(entry, error)
            : store.append("unacknowledged", { disclosure_seq: entry.seq, reason: noResponseReason(error) }),
        );
      }
      throw error;
    }
    const entry = logged.entry;
    if (entry === null) throw new Error("the cloud adapter returned without calling beforeSend");
    const discarded = await answer(entry.seq, () => steps.answered(entry, result));
    if (discarded !== null) throw steps.discard(entry, result, discarded);
    return { result, seq: entry.seq };
  }

  return { disclose, assertOpen, store };
}

export function describe(finding: Finding): string {
  return `${finding.kind} at ${finding.path}`;
}

/**
 * The request as it is logged: credential headers and secret body values replaced by their redaction markers, and
 * where each sat. With nothing to redact it is the request itself, byte for byte.
 */
function redact(
  request: OutboundRequest,
  json: unknown,
  secretPaths: readonly (readonly PathSegment[])[],
): { request: OutboundRequest; redacted: Redaction[] } {
  const redacted: Redaction[] = [];
  const headers = request.headers.map(([name, value]): HeaderPair => {
    if (!isCredentialHeader(name) || markerDigest(value) !== null) return [name, value];
    const sha256 = secretDigest(value);
    redacted.push({ at: `headers.${name}`, sha256 });
    return [name, redactionMarker(sha256)];
  });
  let body = request.body;
  const before = redacted.length;
  const kept = redactValues(json, [], secretPaths, redacted);
  if (redacted.length > before) body = Buffer.from(JSON.stringify(kept), "utf8");
  return redacted.length === 0 ? { request, redacted } : { request: { ...request, headers, body }, redacted };
}

/** A copy of `value` with every secret key's value, and every value at a secret path, replaced by its marker. */
function redactValues(value: unknown, at: PathSegment[], secretPaths: readonly (readonly PathSegment[])[], out: Redaction[]): unknown {
  const secretPath = at.length > 0 && secretPaths.some((p) => p.length === at.length && p.every((s, i) => s === at[i]));
  const secretKey = typeof at.at(-1) === "string" && isSecretKey(at.at(-1) as string);
  if ((secretPath || secretKey) && value !== null && value !== undefined && markerDigest(value) === null) {
    const sha256 = secretDigest(value);
    out.push({ at: formatPath("body", at), sha256 });
    return redactionMarker(sha256);
  }
  if (Array.isArray(value)) return (value as unknown[]).map((item, i) => redactValues(item, [...at, i], secretPaths, out));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item, [...at, key], secretPaths, out)]));
  }
  return value;
}

function noResponseReason(error: unknown): string {
  if (error instanceof CloudNetworkError && error.neverLeft) return `${NOT_SENT_REASON} (${error.failure})`;
  // A destination transport's error for a connection never made (DestinationTransport.send).
  if (error instanceof Error && (error as { neverLeft?: unknown }).neverLeft === true) {
    const failure = (error as { failure?: unknown }).failure;
    return `${NOT_SENT_REASON} (${typeof failure === "string" ? failure : "no connection"})`;
  }
  if (error instanceof Error) {
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === "string" ? `${error.name}: ${reason}` : error.name;
  }
  return "unknown failure";
}

/** The outbound body as JSON; an empty body (a GET, or a POST without one) is null. */
function parseBody(body: Uint8Array): unknown {
  return body.length === 0 ? null : (JSON.parse(Buffer.from(body).toString("utf8")) as unknown);
}

/** Every object key in the body as a dotted path, arrays written as `[]`: `ship_to`, `ship_to.postal_code`. */
function fieldNames(value: unknown, prefix = "", out = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) fieldNames(item, `${prefix}[]`, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix === "" ? key : `${prefix}.${key}`;
      out.add(name);
      fieldNames(item, name, out);
    }
  }
  return [...out].sort();
}
