// The only network path to Intent Cloud (invariant 2: log before send; part of invariant 3).
//
// Every call goes through the cloud adapter's beforeSend hook, which sees the final request bytes:
// 1. findIdentity on the outbound JSON body. A finding appends a `block` entry (finding kinds and paths, never the
//    values) and throws DisclosureBlockedError, so nothing is sent.
// 2. A `disclosure` entry holding the exact body bytes and the full header set is appended; the store fsyncs before
//    append resolves. If the append throws, beforeSend throws and the adapter sends nothing.
// 3. After the exchange, exactly one of `receipt`, `unacknowledged` or `discarded` (ADR-0006):
//    - receipt: both receipt headers came back. They are stored as received and verified later against the key
//      statement (trust, by the gateway and `intent verify`); this module does not import trust.
//    - unacknowledged: no HTTP response, or a non-2xx response without Intent-Contract-Version.
//    - discarded: a 2xx without a receipt (its content is never returned: DisclosureDiscardedError), or any response
//      with Intent-Contract-Version and no receipt.
// Inbound bodies are never scanned: an offer title is Cloud's content, not the buyer's.
import {
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
import type { Store } from "../store/index.ts";

/** The same operations as IntentCloud; each call is logged before it is sent. */
export interface DisclosedCloud {
  meta(): Promise<CloudResult<Meta>>;
  signatureKeys(): Promise<CloudResult<Jwks>>;
  keyStatement(): Promise<CloudResult<KeyStatement>>;
  search(request: SearchRequest): Promise<CloudResult<SearchResponse>>;
  createCart(request: CartRequest): Promise<CloudResult<Cart>>;
  createApproval(cartHandle: string): Promise<CloudResult<ApprovalCreated>>;
  getApproval(approvalHandle: string): Promise<CloudResult<ApprovalStatus>>;
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

/** A 2xx arrived without a receipt; a `discarded` entry was written and its content is not returned. */
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

interface Acknowledgement {
  status: number;
  receipt: { header: string; signature: string } | null;
  contractVersion: string | null;
}

/** The HTTP adapter (base URL, session, clock) wrapped in the disclosure log: the one way to reach Intent Cloud. */
export function connectCloud(options: HttpCloudOptions, store: Store): DisclosedCloud {
  return createDisclosedCloud(createHttpCloud(options), store);
}

export function createDisclosedCloud(cloud: IntentCloud, store: Store): DisclosedCloud {
  async function disclosed<T>(run: (beforeSend: (request: PreparedRequest) => Promise<void>) => Promise<CloudResult<T>>): Promise<CloudResult<T>> {
    // A holder, not a local, because beforeSend sets it inside the adapter's call.
    const logged: { seq: number | null } = { seq: null };
    const beforeSend = async (request: PreparedRequest): Promise<void> => {
      const json = parseBody(request.body);
      const fields = fieldNames(json);
      const findings = findIdentity(json);
      if (findings.length > 0) {
        await store.append("block", { endpoint: request.operation, fields, blocked: findings.map(describe) });
        throw new DisclosureBlockedError(request.operation, findings);
      }
      const entry = await store.append("disclosure", disclosureBody(request, fields));
      logged.seq = entry.seq;
    };

    let result: CloudResult<T>;
    try {
      result = await run(beforeSend);
    } catch (error) {
      // seq is null when the request never got past beforeSend: nothing was sent, so nothing follows the log.
      const { seq } = logged;
      if (seq !== null) {
        if (error instanceof CloudResponseError) await acknowledge(seq, error);
        else await store.append("unacknowledged", { disclosure_seq: seq, reason: noResponseReason(error) });
      }
      throw error;
    }
    const { seq } = logged;
    if (seq === null) throw new Error("the cloud adapter returned without calling beforeSend");
    const discarded = await acknowledge(seq, result);
    if (discarded !== null) throw new DisclosureDiscardedError(seq, result.status, discarded);
    return result;
  }

  /** Appends the entry that answers disclosure `seq`; returns the reason when a 2xx's content must be discarded. */
  async function acknowledge(seq: number, ack: Acknowledgement): Promise<string | null> {
    const { status, receipt, contractVersion } = ack;
    if (receipt !== null) {
      await store.append("receipt", {
        disclosure_seq: seq,
        receipt_header: receipt.header,
        receipt_signature: receipt.signature,
        status,
        contract_version: contractVersion,
      });
      return null;
    }
    const success = status >= 200 && status < 300;
    if (success || contractVersion !== null) {
      const reason = success
        ? `${String(status)} without a receipt`
        : `${String(status)} with Intent-Contract-Version but without a receipt`;
      await store.append("discarded", { disclosure_seq: seq, reason });
      return success ? reason : null;
    }
    await store.append("unacknowledged", { disclosure_seq: seq, reason: `${String(status)} without Intent-Contract-Version` });
    return null;
  }

  return {
    meta: () => disclosed((beforeSend) => cloud.meta({ beforeSend })),
    signatureKeys: () => disclosed((beforeSend) => cloud.signatureKeys({ beforeSend })),
    keyStatement: () => disclosed((beforeSend) => cloud.keyStatement({ beforeSend })),
    search: (request) => disclosed((beforeSend) => cloud.search(request, { beforeSend })),
    createCart: (request) => disclosed((beforeSend) => cloud.createCart(request, { beforeSend })),
    createApproval: (handle) => disclosed((beforeSend) => cloud.createApproval(handle, { beforeSend })),
    getApproval: (handle) => disclosed((beforeSend) => cloud.getApproval(handle, { beforeSend })),
  };
}

function describe(finding: Finding): string {
  return `${finding.kind} at ${finding.path}`;
}

function noResponseReason(error: unknown): string {
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

function header(headers: readonly HeaderPair[], name: string): string | null {
  return headers.find(([key]) => key === name)?.[1] ?? null;
}
