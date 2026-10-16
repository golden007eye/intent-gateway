// The only network path to Intent Cloud (invariant 2: log before send; part of invariant 3).
//
// Every call goes through the cloud adapter's beforeSend hook, which sees the final request bytes:
// 1. findIdentity on the outbound JSON body. A finding appends a `block` entry (finding kinds and paths, never the
//    values) and throws DisclosureBlockedError, so nothing is sent.
// 2. A `disclosure` entry holding the exact body bytes and the full header set is appended; the store fsyncs before
//    append resolves. If the append throws, beforeSend throws and the adapter sends nothing.
// 3. After the exchange, exactly one of `receipt`, `unacknowledged` or `discarded` (ADR-0006):
//    - receipt: both receipt headers came back and verify (trust's verifyReceipt) against the logged request and the
//      verified key set. Before a key set exists only the three key-bootstrap reads may be sent; their receipts are
//      logged with `verified: false`. Once the key set has expired, the other calls are refused before anything is
//      logged (DisclosureKeysExpiredError).
//    - unacknowledged: no HTTP response, or a non-2xx response without Intent-Contract-Version and without a receipt.
//      When no connection was ever made (DNS failure, refused), its reason starts with NOT_SENT_REASON: the logged
//      request never left the machine, and `intent log` and `intent verify` report it as not sent.
//    - discarded: a 2xx without a valid receipt (its content is never returned: DisclosureDiscardedError), any
//      response with Intent-Contract-Version and no receipt, or any invalid receipt.
// 4. If any append around a send fails (the disclosure, or its follow-up), this disclosed cloud stops for good: every
//    later call throws DisclosureStoppedError before anything is logged or sent. A disclosure with no follow-up is
//    then the last one of its gateway session, which is what lets `intent verify` tell a stop from a cut answer.
//
// Gateway session: each disclosed cloud (one per gateway start) appends a `session` entry {id} with a random local
// id before its first disclosure, and every disclosure body carries `session: {id, n, open}`: n counts the session's
// disclosures from 0, and `open` lists the n of its earlier disclosures still awaiting their follow-up. The id is
// local only: it is in the chain, never in the request (the logged body_b64 is what is sent).
// Each result carries `disclosureSeq`, the seq of the disclosure that logged its request, so the gateway can name it
// in the `observed` entry it writes after a verified answer.
// Inbound bodies are never scanned here: an offer title is Cloud's content, not the buyer's. The gateway's
// observations of them are scanned (src/observation) before they are kept.
import { randomUUID } from "node:crypto";
import {
  CloudNetworkError,
  CloudResponseError,
  type CloudResult,
  createHttpCloud,
  type HeaderPair,
  type HttpCloudOptions,
  type IntentCloud,
  type PreparedRequest,
} from "../cloud/index.ts";
import type { ApprovalCreated, ApprovalStatus, Cart, CartRequest, Jwks, KeyStatement, Meta, SearchRequest, SearchResponse } from "../contract/index.ts";
import { type Finding, findIdentity } from "../privacy/index.ts";
import { NOT_SENT_REASON, type Store } from "../store/index.ts";
import { type KeySet, type SentRequest, verifyReceipt } from "../trust/index.ts";

/** A result as the adapter returned it, plus the seq of the `disclosure` entry that logged its request. */
export type DisclosedResult<T> = CloudResult<T> & { readonly disclosureSeq: number };

/** The same operations as IntentCloud; each call is logged before it is sent. */
export interface DisclosedCloud {
  meta(): Promise<DisclosedResult<Meta>>;
  signatureKeys(): Promise<DisclosedResult<Jwks>>;
  keyStatement(): Promise<DisclosedResult<KeyStatement>>;
  search(request: SearchRequest): Promise<DisclosedResult<SearchResponse>>;
  createCart(request: CartRequest): Promise<DisclosedResult<Cart>>;
  createApproval(cartHandle: string): Promise<DisclosedResult<ApprovalCreated>>;
  getApproval(approvalHandle: string): Promise<DisclosedResult<ApprovalStatus>>;
}

export interface DisclosureOptions {
  /**
   * The key set of a verified key statement (trust's verifyStatement), read on every call. Null until the statement
   * is verified: then only meta, signatureKeys and keyStatement may be sent, and their receipts are logged with
   * `verified: false`, for `intent verify` to check once the statement is in the chain.
   */
  keySet: () => KeySet | null;
  /** Milliseconds since the epoch, for the key set's expiry. Defaults to Date.now. */
  now?: () => number;
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

/** A 2xx arrived without a valid receipt; a `discarded` entry was written and its content is not returned. */
export class DisclosureDiscardedError extends Error {
  override name = "DisclosureDiscardedError";
  readonly disclosureSeq: number;
  readonly status: number;
  constructor(disclosureSeq: number, status: number, reason: string) {
    super(`response to disclosure #${String(disclosureSeq)} discarded: ${reason}`);
    this.disclosureSeq = disclosureSeq;
    this.status = status;
  }
}

/**
 * An append around an earlier send failed, so this disclosed cloud sends nothing more: a send whose answer could not
 * be recorded must stay the last one of its gateway session (invariant 2). Restarting the gateway starts a new one.
 */
export class DisclosureStoppedError extends Error {
  override name = "DisclosureStoppedError";
}

/** A search, cart or approval call before a verified key statement: its receipt could not be checked, so nothing is sent. */
export class DisclosureNoKeysError extends Error {
  override name = "DisclosureNoKeysError";
}

/** A search, cart or approval call after the key statement expired: no key of it is trusted, so nothing is sent. */
export class DisclosureKeysExpiredError extends DisclosureNoKeysError {
  override name = "DisclosureKeysExpiredError";
  readonly expiresAt: Date;
  constructor(expiresAt: Date) {
    super(`the key statement expired on ${expiresAt.toISOString()}: fetch a fresh one (restart the gateway) before sending`);
    this.expiresAt = expiresAt;
  }
}

interface Acknowledgement {
  status: number;
  receipt: { header: string; signature: string } | null;
  contractVersion: string | null;
}

/** The HTTP adapter (base URL, session, clock) wrapped in the disclosure log: the one way to reach Intent Cloud. */
export function connectCloud(http: HttpCloudOptions, store: Store, options: DisclosureOptions): DisclosedCloud {
  return createDisclosedCloud(createHttpCloud(http), store, options);
}

export function createDisclosedCloud(cloud: IntentCloud, store: Store, options: DisclosureOptions): DisclosedCloud {
  const now = options.now ?? Date.now;
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

  async function disclosed<T>(
    needsKeys: boolean,
    run: (beforeSend: (request: PreparedRequest) => Promise<void>) => Promise<CloudResult<T>>,
  ): Promise<DisclosedResult<T>> {
    if (stopped !== null) throw stoppedError();
    if (needsKeys) {
      const keySet = options.keySet();
      if (keySet === null) {
        throw new DisclosureNoKeysError("no verified key statement yet: only meta, signatureKeys and keyStatement may be sent");
      }
      // Fail closed before anything is logged: every receipt of a send made now would be discarded anyway.
      if (now() >= keySet.expiresAt.getTime()) throw new DisclosureKeysExpiredError(keySet.expiresAt);
    }
    // A holder, not locals, because beforeSend fills it inside the adapter's call.
    const logged: { seq: number | null; n: number; sent: SentRequest | null } = { seq: null, n: -1, sent: null };
    const beforeSend = async (request: PreparedRequest): Promise<void> => {
      if (stopped !== null) throw stoppedError();
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
      const body = { ...disclosureBody(request, fields), session: { id: session.id, n, open: [...session.open].sort((a, b) => a - b) } };
      session.open.add(n);
      let entry;
      try {
        entry = await store.append("disclosure", body);
      } catch (error) {
        stop(`a request to ${request.operation} could not be logged, so it was not sent`, error);
        throw error;
      }
      logged.seq = entry.seq;
      logged.n = n;
      logged.sent = sentRequest(body);
    };

    /** Appends the follow-up; if that fails, nothing is sent again (the disclosure must stay last in its session). */
    async function answer<R>(seq: number, append: () => Promise<R>): Promise<R> {
      let value: R;
      try {
        value = await append();
      } catch (error) {
        throw stop(`the answer to disclosure #${String(seq)} could not be logged`, error);
      }
      session.open.delete(logged.n);
      return value;
    }

    let result: CloudResult<T>;
    try {
      result = await run(beforeSend);
    } catch (error) {
      // seq is null when the request never got past beforeSend: nothing was sent, so nothing follows the log.
      const { seq, sent } = logged;
      if (seq !== null && sent !== null) {
        await answer<unknown>(seq, () =>
          error instanceof CloudResponseError
            ? acknowledge(seq, sent, error)
            : store.append("unacknowledged", { disclosure_seq: seq, reason: noResponseReason(error) }),
        );
      }
      throw error;
    }
    const { seq, sent } = logged;
    if (seq === null || sent === null) throw new Error("the cloud adapter returned without calling beforeSend");
    const discarded = await answer(seq, () => acknowledge(seq, sent, result));
    if (discarded !== null) throw new DisclosureDiscardedError(seq, result.status, discarded);
    return { ...result, disclosureSeq: seq };
  }

  /** Appends the entry that answers disclosure `seq`; returns the reason when a 2xx's content must be discarded. */
  async function acknowledge(seq: number, sent: SentRequest, ack: Acknowledgement): Promise<string | null> {
    const { status, receipt, contractVersion } = ack;
    const success = status >= 200 && status < 300;
    let reason: string;
    if (receipt !== null) {
      const keySet = options.keySet();
      const checked =
        keySet === null
          ? null
          : verifyReceipt({ status, receipt: receipt.header, signature: receipt.signature }, sent, keySet, new Date(now()));
      if (checked === null || checked.ok) {
        await store.append("receipt", {
          disclosure_seq: seq,
          receipt_header: receipt.header,
          receipt_signature: receipt.signature,
          status,
          contract_version: contractVersion,
          verified: checked !== null,
        });
        return null;
      }
      // An invalid receipt counts as a missing one, and it shows the edge answered, so it is never unacknowledged.
      reason = `${String(status)} with an invalid receipt (step ${String(checked.step)}: ${checked.reason})`;
    } else if (success) {
      reason = `${String(status)} without a receipt`;
    } else if (contractVersion !== null) {
      reason = `${String(status)} with Intent-Contract-Version but without a receipt`;
    } else {
      await store.append("unacknowledged", { disclosure_seq: seq, reason: `${String(status)} without Intent-Contract-Version` });
      return null;
    }
    await store.append("discarded", { disclosure_seq: seq, reason });
    return success ? reason : null;
  }

  return {
    meta: () => disclosed(false, (beforeSend) => cloud.meta({ beforeSend })),
    signatureKeys: () => disclosed(false, (beforeSend) => cloud.signatureKeys({ beforeSend })),
    keyStatement: () => disclosed(false, (beforeSend) => cloud.keyStatement({ beforeSend })),
    search: (request) => disclosed(true, (beforeSend) => cloud.search(request, { beforeSend })),
    createCart: (request) => disclosed(true, (beforeSend) => cloud.createCart(request, { beforeSend })),
    createApproval: (handle) => disclosed(true, (beforeSend) => cloud.createApproval(handle, { beforeSend })),
    getApproval: (handle) => disclosed(true, (beforeSend) => cloud.getApproval(handle, { beforeSend })),
  };
}

function describe(finding: Finding): string {
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

function disclosureBody(request: PreparedRequest, fields: string[]) {
  const signatureInput = header(request.headers, "signature-input");
  const param = (name: string): string | null => {
    const match = signatureInput === null ? null : new RegExp(`;${name}=("?)([^";]*)\\1(?:;|$)`).exec(signatureInput);
    return match?.[2] ?? null;
  };
  const created = param("created");
  return {
    endpoint: request.operation,
    method: request.method,
    path: request.path,
    fields,
    body_b64: Buffer.from(request.body).toString("base64"),
    headers: request.headers.map(([name, value]) => [name, value]),
    content_digest: header(request.headers, "content-digest"),
    keyid: param("keyid"),
    nonce: param("nonce"),
    created: created === null ? null : Number(created),
  };
}

/** The logged request in the receipt's field names; keyid, nonce and created are absent for an unsigned request. */
function sentRequest(body: ReturnType<typeof disclosureBody>): SentRequest {
  return {
    method: body.method,
    path: body.path,
    content_digest: body.content_digest ?? "",
    ...(body.keyid === null ? {} : { keyid: body.keyid }),
    ...(body.nonce === null ? {} : { nonce: body.nonce }),
    ...(body.created === null ? {} : { created: body.created }),
  };
}

function header(headers: readonly HeaderPair[], name: string): string | null {
  return headers.find(([key]) => key === name)?.[1] ?? null;
}
