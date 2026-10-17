// The disclosure core: the one place a request to an outside destination is checked, logged and followed up
// (invariant 2: log before send; part of invariant 3). The destination wrappers (disclosure.ts) only say which
// adapter call to run and how its answer is acknowledged; the order of checks, appends and the stop rule live here.
//
// Per call, through the adapter's beforeSend hook on the final request bytes:
// 1. findIdentity on the outbound JSON body: a finding appends a `block` entry and throws DisclosureBlockedError.
// 2. The gateway session's `session` entry (once), then the `disclosure` entry; if either append throws, beforeSend
//    throws, the adapter sends nothing, and the core stops for good.
// 3. After the exchange, the follow-up the caller's `acknowledge` appends (or `unacknowledged` when no response
//    came back). If that append throws, the core stops for good.
import { randomUUID } from "node:crypto";
import { CloudNetworkError, CloudResponseError, type HeaderPair } from "../cloud/index.ts";
import { type Finding, findIdentity } from "../privacy/index.ts";
import { NOT_SENT_REASON, type Store } from "../store/index.ts";

/** Where a request goes. Today only Intent Cloud; a disclosure body without `destination` means Intent Cloud. */
export type Destination = "intent_cloud";

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
  answeredError: (logged: Logged<B>, error: CloudResponseError) => Promise<unknown>;
  /** Builds the error thrown when `answered` returns a reason. */
  discard: (logged: Logged<B>, result: R, reason: string) => Error;
}

export interface DisclosureCore {
  /** Logs, sends (through `steps.run`) and follows up one request to `destination`. */
  disclose<R, B extends object>(destination: Destination, steps: DiscloseSteps<R, B>): Promise<{ result: R; seq: number }>;
  /** Throws DisclosureStoppedError once an append around a send has failed. */
  assertOpen(): void;
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

  async function disclose<R, B extends object>(_destination: Destination, steps: DiscloseSteps<R, B>): Promise<{ result: R; seq: number }> {
    assertOpen();
    // A holder, not locals, because beforeSend fills it inside the adapter's call.
    const logged: { entry: Logged<B> | null; n: number } = { entry: null, n: -1 };
    const beforeSend = async (request: OutboundRequest): Promise<void> => {
      assertOpen();
      const json = parseBody(request.body);
      const fields = fieldNames(json);
      const findings = findIdentity(json);
      if (findings.length > 0) {
        await store.append("block", { endpoint: request.operation, fields, blocked: findings.map(describe) });
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
      const body = { ...steps.body(request, fields), session: { id: session.id, n, open: [...session.open].sort((a, b) => a - b) } };
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
          error instanceof CloudResponseError
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

  return { disclose, assertOpen };
}

export function describe(finding: Finding): string {
  return `${finding.kind} at ${finding.path}`;
}

function noResponseReason(error: unknown): string {
  if (error instanceof CloudNetworkError && error.neverLeft) return `${NOT_SENT_REASON} (${error.failure})`;
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
