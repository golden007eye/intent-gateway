// `intent verify`: re-checks the local chain offline against the pinned root key, then runs the supply-chain
// self-check. It reports what the gateway sent and what Intent Cloud acknowledged receiving (invariant 5).
//
// Historical checks run at each entry's own `ts`: a key statement is checked at the time it was recorded, a receipt
// or an approval proof at the time it was chained. A statement that has expired since is still good evidence for
// what it covered then. `now` is the self-check's clock.
import { INTENT } from "../config/index.ts";
import { ReceiptRequest } from "../contract/index.ts";
import { observationProblem } from "../observation/index.ts";
import { bodyValue, findIdentity, isCredentialHeader, markerDigest, redactionHeld, secretQueryKeys, unredactedSecrets } from "../privacy/index.ts";
import { contentDigest } from "../signing/index.ts";
import { type Entry, GENESIS, neverLeft, readChain, verifyChain } from "../store/index.ts";
import { formatSelfCheck, type FailureReason, type SelfCheckOptions, type SelfCheckResult, verifyImage, verifyNpm } from "../supplychain/index.ts";
import { checkApprover, type KeySet, type PinnedRootKey, type ReceiptResponse, type SentRequest, verifyApprovalProof, verifyReceipt, verifyStatement } from "../trust/index.ts";
import { walletEntryProblem } from "../wallet/index.ts";

export type Install = { kind: "npm"; pkgDir: string } | { kind: "image"; ref: string; version: string };

export interface VerifyOptions {
  readonly dataDir: string;
  readonly pinnedRootKeys: readonly PinnedRootKey[];
  readonly now: Date;
  /** The installed artifact to self-check. Absent when running from source: there is no artifact to check. */
  readonly install?: Install;
  readonly skipSupplyChain?: boolean;
  /** Why the self-check was skipped, printed after "skipped on request" (e.g. the flag that asked for it). */
  readonly skipReason?: string;
  /** Transport and Sigstore trust root for the self-check; tests inject offline ones. */
  readonly selfCheck?: Omit<SelfCheckOptions, "now">;
}

export interface Check {
  name: "usage" | "chain" | "key statements" | "disclosures" | "approvals" | "approver flags" | "self-check";
  ok: boolean;
  details: string[];
}

export interface Report {
  ok: boolean;
  /** 0 all checks passed; 1 a check failed; 2 a usage or configuration error. */
  exitCode: 0 | 1 | 2;
  /** The last entry of the verified chain (seq -1 and the genesis hash for an empty one), for outside comparison. */
  head: { seq: number; hash: string };
  checks: Check[];
  /**
   * `unanswered`: disclosures with no follow-up entry (the gateway stopped before it recorded an answer, or is still
   * waiting). `responses`: follow-ups to destinations that sign no receipt. `redactions`: credentials digested in
   * logged requests.
   */
  counts: {
    disclosures: number;
    receipts: number;
    responses: number;
    unacknowledged: number;
    unanswered: number;
    discarded: number;
    redactions: number;
    approvals: number;
    flags: number;
  };
}

/** The chain line for a missing or empty chain; the same words as `intent log`. */
const EMPTY_CHAIN = `No entries yet: the gateway has sent nothing. Start it with ${INTENT} serve, or try ${INTENT} demo.`;

/** Self-check reasons that mean the install given to verify is wrong, not that the artifact failed its check. */
const USAGE_REASONS: ReadonlySet<FailureReason> = new Set(["package-unreadable", "ref-invalid"]);

export async function runVerify(opts: VerifyOptions): Promise<Report> {
  const counts = { disclosures: 0, receipts: 0, responses: 0, unacknowledged: 0, unanswered: 0, discarded: 0, redactions: 0, approvals: 0, flags: 0 };
  const empty = { seq: -1, hash: GENESIS };
  if (opts.pinnedRootKeys.length === 0) {
    return usage(["no root key is pinned for this Intent Cloud host; pass --trust-keys"], empty, counts);
  }
  let items: unknown[];
  try {
    items = readChain(opts.dataDir);
  } catch (err) {
    // No chain file (or no data dir) yet: nothing has been sent, which is an empty chain, not an error.
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") items = [];
    else return usage([`cannot read the chain in ${opts.dataDir}: ${err instanceof Error ? err.message : String(err)}`], empty, counts);
  }

  const result = verifyChain(items);
  const entries = (result.ok ? items : items.slice(0, result.brokenSeq)) as Entry[];
  const last = entries.at(-1);
  const head = last === undefined ? empty : { seq: last.seq, hash: last.hash };
  const checks: Check[] = [];
  if (result.ok) {
    const details = entries.length === 0 ? [EMPTY_CHAIN] : [`${String(entries.length)} entries, every hash links`];
    checks.push({ name: "chain", ok: true, details });
    checks.push(...checkEntries(entries, opts.pinnedRootKeys, counts));
  } else {
    checks.push({
      name: "chain",
      ok: false,
      details: [`broken at seq ${String(result.brokenSeq)}: ${result.reason}`, "the entries after it were not checked"],
    });
  }

  const selfCheck = await runSelfCheck(opts);
  checks.push(selfCheck.check);
  if (selfCheck.usage) return { ok: false, exitCode: 2, head, checks, counts };
  const ok = checks.every((c) => c.ok);
  return { ok, exitCode: ok ? 0 : 1, head, checks, counts };
}

function usage(details: string[], head: Report["head"], counts: Report["counts"]): Report {
  return { ok: false, exitCode: 2, head, checks: [{ name: "usage", ok: false, details }], counts };
}

interface RecordedKeys {
  readonly seq: number;
  readonly keySet: KeySet | null;
}

/** A disclosure's `session` field: its gateway session's id, its number n in it, and the n still awaiting an answer. */
interface SessionMark {
  readonly id: string;
  readonly n: number;
  readonly open: readonly number[];
}

/** A disclosure entry without `destination` went to Intent Cloud, the only destination that signs receipts. */
const INTENT_CLOUD = "intent_cloud";

interface Disclosure {
  readonly entry: Entry;
  readonly destination: string;
  readonly followUps: number[];
  /** Null on a chain written before disclosures carried their session (see the unanswered check). */
  readonly session: SessionMark | null;
}

/** Checks 2–5 over a chain whose links already verified. */
function checkEntries(entries: readonly Entry[], pinned: readonly PinnedRootKey[], counts: Report["counts"]): Check[] {
  const keyFailures: string[] = [];
  const disclosureFailures: string[] = [];
  const approvalFailures: string[] = [];
  const flags: string[] = [];
  const disclosures = new Map<number, Disclosure>();
  const pending = new Map<string, Entry>();
  // Gateway session ids declared by a `session` entry, and the n of the last disclosure seen in each.
  const sessions = new Map<string, number>();
  // Logged requests that never left (no connection was made): reported as not sent, not as sent (invariant 5).
  let notSent = 0;
  // The status of each disclosure's receipt, and the disclosures an `observed` entry already summarises.
  const receiptStatus = new Map<number, number>();
  const observed = new Set<number>();
  // Every recorded statement, checked at the time it was recorded: its KeySet, or null when it did not verify.
  const statements = new Map<number, KeySet | null>();
  for (const entry of entries) {
    if (entry.kind !== "keys") continue;
    const ts = new Date(entry.ts);
    const verified = Number.isNaN(ts.getTime()) ? null : verifyStatement(record(entry.body).statement, pinned, ts);
    statements.set(entry.seq, verified?.ok === true ? verified.keySet : null);
    if (verified?.ok !== true) {
      const why = verified === null ? "the entry's ts is not a time" : `step ${String(verified.step)}: ${verified.reason}`;
      keyFailures.push(`seq ${String(entry.seq)}: the recorded key statement does not verify against the pinned root (${why})`);
    }
  }
  // The key-bootstrap reads (at start, and again when the statement has expired) are sent while no key set is
  // trusted; their receipts, logged `verified: false`, are checked against the next statement recorded after them.
  const recorded = [...statements].map(([seq, keySet]): RecordedKeys => ({ seq, keySet }));
  const nextKeys = (seq: number): RecordedKeys | null => recorded.find((k) => k.seq > seq) ?? null;
  // The latest statement recorded before the entry being checked.
  let keys: RecordedKeys | null = null;

  for (const [index, entry] of entries.entries()) {
    const at = `seq ${String(entry.seq)}`;
    const ts = new Date(entry.ts);
    const body = record(entry.body);
    switch (entry.kind) {
      case "keys":
        keys = { seq: entry.seq, keySet: statements.get(entry.seq) ?? null };
        break;
      case "session":
        if (typeof body.id === "string") {
          if (sessions.has(body.id)) disclosureFailures.push(`${at}: the session entry repeats the id of an earlier gateway session (${body.id})`);
          sessions.set(body.id, -1);
        }
        break;
      case "disclosure": {
        counts.disclosures += 1;
        const session = sessionMark(body.session);
        const destination = typeof body.destination === "string" ? body.destination : INTENT_CLOUD;
        disclosures.set(entry.seq, { entry, destination, followUps: [], session: session === "malformed" ? null : session });
        const problem = bodyProblem(body);
        if (problem !== null) disclosureFailures.push(`${at}: the disclosure ${problem}`);
        for (const where of credentialProblems(body)) disclosureFailures.push(`${at}: the disclosure holds a credential: ${where} is not redacted`);
        const redactions = redactionProblems(body);
        counts.redactions += redactions.count;
        for (const problem of redactions.problems) disclosureFailures.push(`${at}: the disclosure's ${problem}`);
        if (session === "malformed") {
          disclosureFailures.push(`${at}: the disclosure's session is not {id, n, open}`);
        } else if (session !== null) {
          const last = sessions.get(session.id);
          if (last === undefined) {
            disclosureFailures.push(`${at}: the disclosure names gateway session ${session.id}, which no earlier session entry starts`);
          } else if (session.n !== last + 1) {
            disclosureFailures.push(
              `${at}: the disclosure is number ${String(session.n)} of its gateway session, expected ${String(last + 1)}: a disclosure of that session is missing from the chain`,
            );
          }
          sessions.set(session.id, session.n);
        }
        break;
      }
      case "receipt":
      case "response":
      case "unacknowledged":
      case "discarded": {
        counts[entry.kind === "receipt" ? "receipts" : entry.kind === "response" ? "responses" : entry.kind] += 1;
        if (entry.kind === "unacknowledged" && neverLeft(entry.body)) notSent += 1;
        const target = typeof body.disclosure_seq === "number" ? disclosures.get(body.disclosure_seq) : undefined;
        if (target === undefined) {
          disclosureFailures.push(`${at}: ${entry.kind} names disclosure_seq ${String(body.disclosure_seq)}, which is not an earlier disclosure`);
          break;
        }
        target.followUps.push(entry.seq);
        const of = `the disclosure at seq ${String(target.entry.seq)}`;
        if (entry.kind === "response") {
          // A destination that signs no receipt is answered by a `response`; Intent Cloud never is.
          if (target.destination === INTENT_CLOUD) {
            disclosureFailures.push(`${at}: a response entry answers ${of}, which went to Intent Cloud: its answers are acknowledged by receipts`);
          }
        } else if (entry.kind === "receipt" && target.destination !== INTENT_CLOUD) {
          disclosureFailures.push(`${at}: a receipt entry answers ${of}, which went to ${target.destination}: only Intent Cloud signs receipts`);
        } else if (entry.kind === "discarded") {
          disclosureFailures.push(`${at}: discarded: a response to ${of} came without a valid receipt (${String(body.reason)})`);
        } else if (entry.kind === "receipt") {
          const problem = receiptProblem(body, target.entry, body.verified === false ? (nextKeys(entry.seq) ?? keys) : keys, ts);
          if (problem !== null) disclosureFailures.push(`${at}: the receipt for ${of} ${problem}`);
          else if (typeof body.status === "number") receiptStatus.set(target.entry.seq, body.status);
        }
        break;
      }
      case "observed": {
        // Never sent and never a follow-up: it only summarises an answer whose receipt verified, after that receipt.
        const problem = observedProblem(body, disclosures, receiptStatus, observed);
        if (problem !== null) disclosureFailures.push(`${at}: the observed entry ${problem}`);
        else observed.add(body.disclosure_seq as number);
        break;
      }
      case "block": {
        const found = findIdentity(body.held ?? null);
        if (found.length > 0) disclosureFailures.push(`${at}: the block entry keeps what looks like buyer identity in held (${found.map((f) => f.kind).join(", ")})`);
        break;
      }
      case "wallet": {
        // The token never enters the chain: a wallet entry holds exactly {rail, action, revoked}.
        const problem = walletEntryProblem(entry.body);
        if (problem !== null) disclosureFailures.push(`${at}: the wallet entry ${problem}`);
        break;
      }
      case "approval_pending":
        if (typeof body.handle === "string") pending.set(body.handle, entry);
        break;
      case "approval": {
        const problem = approvalProblem(body, pending, keys, entries.slice(0, index), ts);
        if (problem === null) counts.approvals += 1;
        else approvalFailures.push(`${at}: the approval ${typeof body.handle === "string" ? `for ${body.handle} ` : ""}${problem}`);
        break;
      }
      case "approver_flag":
        counts.flags += 1;
        flags.push(
          body.reason === "sign_count"
            ? `${at}: the pinned approver's passkey signed an approval with a signature counter that did not go up, not counted as approved (fingerprint ${String(body.fingerprint)})`
            : `${at}: a passkey other than the pinned approver signed an approval, not counted as approved (fingerprint ${String(body.fingerprint)})`,
        );
        break;
      default:
        break;
    }
  }

  // A disclosure with no follow-up: the gateway logged it and may have sent it, then stopped (a crash, a kill, or a
  // follow-up append that failed, after which the disclosure layer sends nothing more) before it recorded an answer,
  // or it is still waiting for one. That is normal life, not a broken chain: it is reported apart, and never counted
  // as sent or acknowledged (invariant 5). It is so only while no later disclosure of the same gateway session counts
  // it as answered (leaves its n out of `open`): then its answer was recorded and is missing, and verify fails.
  // A follow-up cut from inside the chain changes every later hash, and so the head: compare the head with a saved
  // copy. On a chain written before disclosures carried their session there is nothing to compare, and a disclosure
  // with no follow-up is always reported apart.
  const unanswered: number[] = [];
  const all = [...disclosures.values()];
  for (const { entry, followUps, session } of all) {
    if (followUps.length === 0) {
      unanswered.push(entry.seq);
      const answeredBy =
        session === null ? undefined : all.find((d) => d.entry.seq > entry.seq && d.session?.id === session.id && !d.session.open.includes(session.n));
      if (answeredBy !== undefined) {
        disclosureFailures.push(
          `seq ${String(entry.seq)}: the disclosure has no follow-up entry, but the disclosure at seq ${String(answeredBy.entry.seq)} of the same gateway session counts it as answered: its answer is missing from the chain`,
        );
      }
    } else if (followUps.length > 1) {
      disclosureFailures.push(`seq ${String(entry.seq)}: the disclosure has ${String(followUps.length)} follow-up entries (seq ${followUps.join(", ")}); expected one`);
    }
  }

  counts.unanswered = unanswered.length;
  return [
    {
      name: "key statements",
      ok: keyFailures.length === 0,
      details: [`${String(statements.size)} recorded, checked offline against the pinned root key`, ...keyFailures],
    },
    {
      name: "disclosures",
      ok: disclosureFailures.length === 0,
      details: [
        `sent: ${String(counts.disclosures - notSent - unanswered.length)}`,
        ...(notSent === 0 ? [] : [`logged but not sent (no connection was made): ${String(notSent)}`]),
        ...(unanswered.length === 0
          ? []
          : [`logged, maybe sent, no answer recorded (the gateway stopped before it finished, or is still waiting): ${String(unanswered.length)} (seq ${unanswered.join(", ")})`]),
        demoChain(entries)
          ? `acknowledged by a receipt from the local demo Intent Cloud (demo chain, test keys): ${String(counts.receipts)}`
          : `acknowledged by a receipt from Intent Cloud's public edge: ${String(counts.receipts)}`,
        ...(counts.responses === 0 ? [] : [`answered by a destination that signs no receipt (response recorded, unsigned): ${String(counts.responses)}`]),
        `sent, not acknowledged: ${String(counts.unacknowledged - notSent)}`,
        `discarded: ${String(counts.discarded)}`,
        ...(observed.size === 0 ? [] : [`answers summarised locally (observed, never sent): ${String(observed.size)}`]),
        ...(counts.redactions === 0 ? [] : [`credentials digested in the log (sent, kept only as sha256): ${String(counts.redactions)}`]),
        ...disclosureFailures,
      ],
    },
    { name: "approvals", ok: approvalFailures.length === 0, details: [`verified: ${String(counts.approvals)}`, ...approvalFailures] },
    { name: "approver flags", ok: true, details: [`flagged: ${String(counts.flags)}`, ...flags] },
  ];
}

/** Whether the chain was written in demo mode: its first entry is the demo `session` entry `{mode: "demo"}`. */
function demoChain(entries: readonly Entry[]): boolean {
  const [first] = entries;
  return first?.kind === "session" && record(first.body).mode === "demo";
}

/** A disclosure's `session` field; null when it has none (an older chain), "malformed" when it is not {id, n, open}. */
function sessionMark(value: unknown): SessionMark | null | "malformed" {
  if (value === undefined) return null;
  const { id, n, open } = record(value);
  const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
  if (typeof id !== "string" || !count(n) || !Array.isArray(open) || !open.every(count)) return "malformed";
  return { id, n, open };
}

/**
 * Why an `observed` entry is not a summary of one acknowledged answer, or null: its shape and buyer identity
 * (observationProblem), then its disclosure_seq must name an earlier disclosure of the same endpoint whose receipt
 * verified with a 2xx status before it, and no other observation may name that disclosure.
 */
function observedProblem(
  body: Record<string, unknown>,
  disclosures: ReadonlyMap<number, Disclosure>,
  receiptStatus: ReadonlyMap<number, number>,
  observed: ReadonlySet<number>,
): string | null {
  const shape = observationProblem(body);
  if (shape !== null) return shape;
  const seq = body.disclosure_seq as number;
  const target = disclosures.get(seq);
  if (target === undefined) return `names disclosure_seq ${String(seq)}, which is not an earlier disclosure`;
  const endpoint = record(target.entry.body).endpoint;
  if (endpoint !== body.endpoint) return `is for ${String(body.endpoint)}, but the disclosure at seq ${String(seq)} is ${String(endpoint)}`;
  const status = receiptStatus.get(seq);
  if (status === undefined) return `summarises the disclosure at seq ${String(seq)}, which has no verified receipt before it`;
  if (status < 200 || status >= 300) return `summarises the disclosure at seq ${String(seq)}, whose receipt is for status ${String(status)}, not a success`;
  if (observed.has(seq)) return `repeats an observation of the disclosure at seq ${String(seq)}`;
  return null;
}

/** Why a `receipt` entry does not acknowledge its disclosure, or null when it does. */
function receiptProblem(body: Record<string, unknown>, disclosure: Entry, keys: RecordedKeys | null, ts: Date): string | null {
  const sent = sentRequest(record(disclosure.body));
  if (sent === null) return "cannot be checked: the disclosure holds no logged request";
  const response = receiptResponse(body);
  if (response === null) return "holds no status";
  if (keys === null) return "cannot be checked: the chain records no key statement";
  if (keys.keySet === null) return `cannot be checked: the key statement at seq ${String(keys.seq)} did not verify`;
  const result = verifyReceipt(response, sent, keys.keySet, ts);
  return result.ok ? null : `does not verify (step ${String(result.step)}: ${result.reason})`;
}

/** Why an `approval` entry is not a verified approval by the pinned approver, or null when it is. */
function approvalProblem(
  body: Record<string, unknown>,
  pending: ReadonlyMap<string, Entry>,
  keys: RecordedKeys | null,
  before: readonly Entry[],
  ts: Date,
): string | null {
  if (typeof body.handle !== "string") return "has no handle";
  if (body.proof === undefined) return "holds no proof (expected body {handle, proof})";
  const pendingEntry = pending.get(body.handle);
  if (pendingEntry === undefined) return "has no approval_pending entry before it";
  if (keys === null) return "cannot be checked: no key statement was recorded before it";
  if (keys.keySet === null) return `cannot be checked: the key statement at seq ${String(keys.seq)} did not verify`;
  const verified = verifyApprovalProof({ state: "approved", proof: body.proof }, pendingEntry, keys.keySet, before, ts);
  if (!verified.ok) return `does not verify (step ${String(verified.step)}: ${verified.reason})`;
  const approver = checkApprover(verified.credential, before);
  if (approver.decision === "flag" && approver.reason === "sign_count") {
    return `is counted as approved, but its passkey's signature counter did not go up since the last approval (fingerprint ${approver.fingerprint})`;
  }
  if (approver.decision === "flag") return `is counted as approved, but its passkey is not the pinned approver (fingerprint ${approver.fingerprint})`;
  if (approver.decision === "pin") return "was chained before any approver pin";
  return null;
}

/** Why a disclosure's logged body bytes are not the bytes its content_digest names, or null when they are. */
function bodyProblem(body: Record<string, unknown>): string | null {
  const { body_b64, content_digest } = body;
  if (typeof body_b64 !== "string" || typeof content_digest !== "string") return "holds no body_b64 and content_digest";
  const bytes = Buffer.from(body_b64, "base64");
  if (bytes.toString("base64") !== body_b64) return "body_b64 is not base64";
  return contentDigest(bytes) === content_digest ? null : "body does not match its content_digest";
}

/** The logged body bytes as a value (JSON, or a form by its logged content-type); null when there are none or they do not parse. */
function loggedJson(body: Record<string, unknown>): unknown {
  if (typeof body.body_b64 !== "string" || body.body_b64 === "") return null;
  try {
    return bodyValue(loggedHeaders(body), Buffer.from(body.body_b64, "base64"));
  } catch {
    return null;
  }
}

/** The logged header pairs; malformed ones left out. */
function loggedHeaders(body: Record<string, unknown>): [string, string][] {
  if (!Array.isArray(body.headers)) return [];
  return (body.headers as unknown[]).filter(
    (pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string",
  );
}

/**
 * Where a disclosure to any destination holds a credential in clear (ADR-0014): a credential header, or a body value
 * under a secret key, that is not a redaction marker, or a query parameter named as a secret key. The same rules as
 * the disclosure core's (privacy's credential helpers).
 */
function credentialProblems(body: Record<string, unknown>): string[] {
  const headers = loggedHeaders(body)
    .filter(([name, value]) => isCredentialHeader(name) && markerDigest(value) === null)
    .map(([name]) => `the ${name} header`);
  const query = typeof body.path === "string" ? secretQueryKeys(body.path).map((name) => `the query parameter ${name}`) : [];
  return [...headers, ...query, ...unredactedSecrets(loggedJson(body))];
}

/** Each `redacted[]` item must name a path of the logged request that holds the marker for its sha256. */
function redactionProblems(body: Record<string, unknown>): { count: number; problems: string[] } {
  const { redacted } = body;
  if (redacted === undefined) return { count: 0, problems: [] };
  const items = Array.isArray(redacted) ? (redacted as unknown[]) : null;
  const well = items?.every((r) => typeof record(r).at === "string" && /^[0-9a-f]{64}$/.test(String(record(r).sha256))) ?? false;
  if (items === null || !well) return { count: 0, problems: ["redacted is not a list of {at, sha256}"] };
  const logged = { headers: loggedHeaders(body), body: loggedJson(body) };
  const problems = items
    .map((r) => record(r) as { at: string; sha256: string })
    .filter((r) => !redactionHeld(logged, r.at, r.sha256))
    .map((r) => `redacted names ${JSON.stringify(r.at)}, which holds no redacted value with that sha256 in the logged request`);
  return { count: items.length, problems };
}

/** The request a disclosure logged, in the receipt's field names; keyid, nonce and created are null when unsigned. */
function sentRequest(body: Record<string, unknown>): SentRequest | null {
  const { method, path, content_digest, keyid, nonce, created } = body;
  const signed = keyid === null && nonce === null && created === null ? {} : { keyid, nonce, created };
  const parsed = ReceiptRequest.safeParse({ method, path, content_digest, ...signed });
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    method: r.method,
    path: r.path,
    content_digest: r.content_digest,
    ...(r.keyid === undefined ? {} : { keyid: r.keyid }),
    ...(r.nonce === undefined ? {} : { nonce: r.nonce }),
    ...(r.created === undefined ? {} : { created: r.created }),
  };
}

/** The response a receipt entry logged: its status and the raw receipt header values. */
function receiptResponse(body: Record<string, unknown>): ReceiptResponse | null {
  const { status, receipt_header, receipt_signature } = body;
  if (typeof status !== "number") return null;
  return {
    status,
    receipt: typeof receipt_header === "string" ? receipt_header : undefined,
    signature: typeof receipt_signature === "string" ? receipt_signature : undefined,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function notPublished(reason: string): { check: Check; usage: boolean } {
  return { check: { name: "self-check", ok: true, details: [`self-check: not run: this install is not a published release (${reason})`] }, usage: false };
}

async function runSelfCheck(opts: VerifyOptions): Promise<{ check: Check; usage: boolean }> {
  if (opts.skipSupplyChain === true) {
    const why = opts.skipReason === undefined ? "" : ` (${opts.skipReason})`;
    return { check: { name: "self-check", ok: true, details: [`self-check: skipped on request${why}; npm provenance and the image signature were not checked`] }, usage: false };
  }
  const { install } = opts;
  if (install === undefined) return notPublished("no build-info.json: running from source");
  const options = { ...opts.selfCheck, now: () => opts.now };
  const result: SelfCheckResult =
    install.kind === "npm" ? await verifyNpm(install.pkgDir, options) : await verifyImage(install.ref, { ...options, version: install.version });
  // A local or pre-release build the registry has never heard of has nothing published to check against. Any other
  // failure, including a registry that knows the version but disagrees with the install, still fails.
  const only = result.failures.length === 1 ? result.failures[0] : undefined;
  if (only?.reason === "not-published") return notPublished(`${result.subject}: ${only.detail}`);
  const details = formatSelfCheck(result).trimEnd().split("\n");
  return { check: { name: "self-check", ok: result.ok, details }, usage: result.failures.some((f) => USAGE_REASONS.has(f.reason)) };
}
