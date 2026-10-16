// `intent verify`: re-checks the local chain offline against the pinned root key, then runs the supply-chain
// self-check. It reports what the gateway sent and what Intent Cloud acknowledged receiving (invariant 5).
//
// Historical checks run at each entry's own `ts`: a key statement is checked at the time it was recorded, a receipt
// or an approval proof at the time it was chained. A statement that has expired since is still good evidence for
// what it covered then. `now` is the self-check's clock.
import { ReceiptRequest } from "../contract/index.ts";
import { type Entry, GENESIS, readChain, verifyChain } from "../store/index.ts";
import { formatSelfCheck, type FailureReason, type SelfCheckOptions, type SelfCheckResult, verifyImage, verifyNpm } from "../supplychain/index.ts";
import { checkApprover, type KeySet, type PinnedRootKey, type ReceiptResponse, type SentRequest, verifyApprovalProof, verifyReceipt, verifyStatement } from "../trust/index.ts";

export type Install = { kind: "npm"; pkgDir: string } | { kind: "image"; ref: string; version: string };

export interface VerifyOptions {
  readonly dataDir: string;
  readonly pinnedRootKeys: readonly PinnedRootKey[];
  readonly now: Date;
  /** The installed artifact to self-check. Absent when running from source: there is no artifact to check. */
  readonly install?: Install;
  readonly skipSupplyChain?: boolean;
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
  counts: { disclosures: number; receipts: number; unacknowledged: number; discarded: number; approvals: number; flags: number };
}

/** Self-check reasons that mean the install given to verify is wrong, not that the artifact failed its check. */
const USAGE_REASONS: ReadonlySet<FailureReason> = new Set(["package-unreadable", "ref-invalid"]);

export async function runVerify(opts: VerifyOptions): Promise<Report> {
  const counts = { disclosures: 0, receipts: 0, unacknowledged: 0, discarded: 0, approvals: 0, flags: 0 };
  const empty = { seq: -1, hash: GENESIS };
  if (opts.pinnedRootKeys.length === 0) {
    return usage(["no root key is pinned for this Intent Cloud host; pass --trust-keys"], empty, counts);
  }
  let items: unknown[];
  try {
    items = readChain(opts.dataDir);
  } catch (err) {
    return usage([`cannot read the chain in ${opts.dataDir}: ${err instanceof Error ? err.message : String(err)}`], empty, counts);
  }

  const result = verifyChain(items);
  const entries = (result.ok ? items : items.slice(0, result.brokenSeq)) as Entry[];
  const last = entries.at(-1);
  const head = last === undefined ? empty : { seq: last.seq, hash: last.hash };
  const checks: Check[] = [];
  if (result.ok) {
    checks.push({ name: "chain", ok: true, details: [`${String(entries.length)} entries, every hash links`] });
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

interface Disclosure {
  readonly entry: Entry;
  readonly followUps: number[];
}

/** Checks 2–5 over a chain whose links already verified. */
function checkEntries(entries: readonly Entry[], pinned: readonly PinnedRootKey[], counts: Report["counts"]): Check[] {
  const keyFailures: string[] = [];
  const disclosureFailures: string[] = [];
  const approvalFailures: string[] = [];
  const flags: string[] = [];
  const disclosures = new Map<number, Disclosure>();
  const pending = new Map<string, Entry>();
  // The latest recorded statement: its seq, and its KeySet when it verified.
  let keys: { seq: number; keySet: KeySet | null } | null = null;
  let statements = 0;

  for (const [index, entry] of entries.entries()) {
    const at = `seq ${String(entry.seq)}`;
    const ts = new Date(entry.ts);
    const body = record(entry.body);
    switch (entry.kind) {
      case "keys": {
        statements += 1;
        const verified = Number.isNaN(ts.getTime()) ? null : verifyStatement(body.statement, pinned, ts);
        if (verified?.ok === true) {
          keys = { seq: entry.seq, keySet: verified.keySet };
        } else {
          keys = { seq: entry.seq, keySet: null };
          const why = verified === null ? "the entry's ts is not a time" : `step ${String(verified.step)}: ${verified.reason}`;
          keyFailures.push(`${at}: the recorded key statement does not verify against the pinned root (${why})`);
        }
        break;
      }
      case "disclosure":
        counts.disclosures += 1;
        disclosures.set(entry.seq, { entry, followUps: [] });
        break;
      case "receipt":
      case "unacknowledged":
      case "discarded": {
        counts[entry.kind === "receipt" ? "receipts" : entry.kind] += 1;
        const target = typeof body.disclosure_seq === "number" ? disclosures.get(body.disclosure_seq) : undefined;
        if (target === undefined) {
          disclosureFailures.push(`${at}: ${entry.kind} names disclosure_seq ${String(body.disclosure_seq)}, which is not an earlier disclosure`);
          break;
        }
        target.followUps.push(entry.seq);
        const of = `the disclosure at seq ${String(target.entry.seq)}`;
        if (entry.kind === "discarded") {
          disclosureFailures.push(`${at}: discarded: a response to ${of} came without a valid receipt (${String(body.reason)})`);
        } else if (entry.kind === "receipt") {
          const problem = receiptProblem(body, target.entry, keys, ts);
          if (problem !== null) disclosureFailures.push(`${at}: the receipt for ${of} ${problem}`);
        }
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
        flags.push(`${at}: a passkey other than the pinned approver signed an approval, not counted as approved (fingerprint ${String(body.fingerprint)})`);
        break;
      default:
        break;
    }
  }

  for (const { entry, followUps } of disclosures.values()) {
    if (followUps.length === 0) {
      disclosureFailures.push(`seq ${String(entry.seq)}: the disclosure has no receipt, unacknowledged or discarded entry`);
    } else if (followUps.length > 1) {
      disclosureFailures.push(`seq ${String(entry.seq)}: the disclosure has ${String(followUps.length)} follow-up entries (seq ${followUps.join(", ")}); expected one`);
    }
  }

  return [
    {
      name: "key statements",
      ok: keyFailures.length === 0,
      details: [`${String(statements)} recorded, checked offline against the pinned root key`, ...keyFailures],
    },
    {
      name: "disclosures",
      ok: disclosureFailures.length === 0,
      details: [
        `sent: ${String(counts.disclosures)}`,
        `acknowledged by a receipt from Intent Cloud's public edge: ${String(counts.receipts)}`,
        `sent, not acknowledged: ${String(counts.unacknowledged)}`,
        `discarded: ${String(counts.discarded)}`,
        ...disclosureFailures,
      ],
    },
    { name: "approvals", ok: approvalFailures.length === 0, details: [`verified: ${String(counts.approvals)}`, ...approvalFailures] },
    { name: "approver flags", ok: true, details: [`flagged: ${String(counts.flags)}`, ...flags] },
  ];
}

/** Why a `receipt` entry does not acknowledge its disclosure, or null when it does. */
function receiptProblem(body: Record<string, unknown>, disclosure: Entry, keys: { seq: number; keySet: KeySet | null } | null, ts: Date): string | null {
  const sent = sentRequest(record(disclosure.body).request);
  if (sent === null) return "cannot be checked: the disclosure holds no logged request";
  const response = receiptResponse(body.response);
  if (response === null) return "holds no response {status, receipt, signature}";
  if (keys === null) return "cannot be checked: no key statement was recorded before it";
  if (keys.keySet === null) return `cannot be checked: the key statement at seq ${String(keys.seq)} did not verify`;
  const result = verifyReceipt(response, sent, keys.keySet, ts);
  return result.ok ? null : `does not verify (step ${String(result.step)}: ${result.reason})`;
}

/** Why an `approval` entry is not a verified approval by the pinned approver, or null when it is. */
function approvalProblem(
  body: Record<string, unknown>,
  pending: ReadonlyMap<string, Entry>,
  keys: { seq: number; keySet: KeySet | null } | null,
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
  if (approver.decision === "flag") return `is counted as approved, but its passkey is not the pinned approver (fingerprint ${approver.fingerprint})`;
  if (approver.decision === "pin") return "was chained before any approver pin";
  return null;
}

function sentRequest(value: unknown): SentRequest | null {
  const parsed = ReceiptRequest.safeParse(value);
  if (!parsed.success) return null;
  const { method, path, content_digest, keyid, nonce, created } = parsed.data;
  return {
    method,
    path,
    content_digest,
    ...(keyid === undefined ? {} : { keyid }),
    ...(nonce === undefined ? {} : { nonce }),
    ...(created === undefined ? {} : { created }),
  };
}

function receiptResponse(value: unknown): ReceiptResponse | null {
  const { status, receipt, signature } = record(value);
  if (typeof status !== "number") return null;
  return {
    status,
    receipt: typeof receipt === "string" ? receipt : undefined,
    signature: typeof signature === "string" ? signature : undefined,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function runSelfCheck(opts: VerifyOptions): Promise<{ check: Check; usage: boolean }> {
  if (opts.skipSupplyChain === true) {
    return { check: { name: "self-check", ok: true, details: ["self-check: skipped on request; npm provenance and the image signature were not checked"] }, usage: false };
  }
  const { install } = opts;
  if (install === undefined) {
    return { check: { name: "self-check", ok: true, details: ["self-check: not run: running from source, no installed artifact to check"] }, usage: false };
  }
  const options = { ...opts.selfCheck, now: () => opts.now };
  const result: SelfCheckResult =
    install.kind === "npm" ? await verifyNpm(install.pkgDir, options) : await verifyImage(install.ref, { ...options, version: install.version });
  const details = formatSelfCheck(result).trimEnd().split("\n");
  return { check: { name: "self-check", ok: result.ok, details }, usage: result.failures.some((f) => USAGE_REASONS.has(f.reason)) };
}
