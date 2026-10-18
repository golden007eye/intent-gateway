// `intent verify --evidence <file>`: checks an evidence pack offline (ADR-0018), with nothing but the file and the
// verifier's own pinned root key. No data dir, no network, no install self-check.
//
// 1. evidence pack: the file is canonical JSON in the v1 shape; its root key is one this verifier pins; the skeleton
//    links from genesis to the head; every entry hashes to its own content and to its skeleton row. The rows outside
//    the pack, and which of the purchase's entries it holds, stay the exporter's account.
// 2. purchase: every entry belongs to the purchase the pack names (src/evidence's rule, run on the pack's entries
//    alone), it has its pending entry and its approval, and nothing it says was sent looks like buyer identity.
// 3. the chain checks of `intent verify` on those entries: key statements against the verifier's pin, receipts,
//    disclosures (no credential in clear), the approval proof (Appendix E, step 7 included), outcomes and binding-v1.
// The report says what the gateway sent and what Intent Cloud signed or acknowledged, nothing more (invariant 5).
import { purchaseEntries, readPack, type Role, skeletonProblems } from "../evidence/index.ts";
import { bodyValue, findIdentity, sentOrderRefAt } from "../privacy/index.ts";
import { type Entry, GENESIS } from "../store/index.ts";
import type { PinnedRootKey } from "../trust/index.ts";
import { type Check, checkEntries, type Report } from "./verify.ts";

export interface EvidenceVerifyOptions {
  /** The pack file's text. */
  readonly text: string;
  readonly pinnedRootKeys: readonly PinnedRootKey[];
}

const ROLE_ORDER: readonly Role[] = [
  "search",
  "cart request",
  "approval request",
  "approval pending",
  "approval",
  "status read",
  "outcome report",
  "completion",
  "complete attempt",
  "wallet request",
  "outcome",
  "answer",
  "observed",
  "key statement",
  "approver pin",
  "session",
];

/** Receipts cover one request each, never the head: only a head saved elsewhere can be compared with this one. */
const HEAD_NOTE = "Compare this head with one saved earlier, or with another pack from the same chain.";

export function runVerifyEvidence(opts: EvidenceVerifyOptions): Report {
  const counts = { disclosures: 0, receipts: 0, responses: 0, unacknowledged: 0, unanswered: 0, discarded: 0, redactions: 0, approvals: 0, outcomes: 0, flags: 0 };
  const none = { seq: -1, hash: GENESIS };
  const failed = (check: Check, head = none): Report => ({ ok: false, exitCode: 1, head, checks: [check], counts });
  if (opts.pinnedRootKeys.length === 0) {
    return { ...failed({ name: "usage", ok: false, details: ["no root key is pinned for this Intent Cloud host; pass --trust-keys"] }), exitCode: 2 };
  }
  const read = readPack(opts.text);
  if (!read.ok) return failed({ name: "evidence pack", ok: false, details: [read.problem] });
  const { pack } = read;

  const problems = skeletonProblems(pack);
  pack.pinned_root.forEach((key, i) => {
    if (!opts.pinnedRootKeys.some((p) => p.kid === key.kid && p.jwk.x === key.jwk.x)) {
      problems.push(`pinned_root[${String(i)}]: root key ${key.kid} is not one this verifier pins; pass --trust-keys with the root you trust for that host`);
    }
  });
  const details = [`purchase ${pack.purchase}: ${String(pack.entries.length)} of the ${String(pack.skeleton.length)} entries of the chain`];
  if (problems.length > 0) return failed({ name: "evidence pack", ok: false, details: [...details, ...problems, "the entries were not checked further"] }, pack.head);
  const packCheck: Check = { name: "evidence pack", ok: true, details: [...details, "every entry hashes to its row; rows outside the pack are the exporter's account"] };

  const entries = pack.entries as Entry[];
  const { roles, missing } = purchaseEntries(entries, pack.purchase);
  const purchaseFailures = [
    ...missing,
    ...entries.filter((e) => !roles.has(e.seq)).map((e) => `seq ${String(e.seq)}: the ${e.kind} entry is not part of purchase ${pack.purchase}`),
    ...sentIdentity(entries),
  ];
  const held = new Map<Role, number>();
  for (const role of roles.values()) held.set(role, (held.get(role) ?? 0) + 1);
  const holds = ROLE_ORDER.filter((r) => held.has(r)).map((r) => `${r}: ${String(held.get(r))}`);
  const purchaseCheck: Check = { name: "purchase", ok: purchaseFailures.length === 0, details: [`holds ${holds.join(", ")}`, "an entry of the purchase left out of the pack cannot be detected", ...purchaseFailures] };

  // A pack holds no approver_flag entry (they name no purchase), so the flags line would always say 0: left out.
  const checks = [packCheck, purchaseCheck, ...checkEntries(entries, opts.pinnedRootKeys, counts, true).filter((c) => c.name !== "approver flags")];
  const ok = checks.every((c) => c.ok);
  return { ok, exitCode: ok ? 0 : 1, head: pack.head, headNote: HEAD_NOTE, checks, counts };
}

/**
 * Invariant 3 over what the pack says was sent: each disclosure's logged body, read as the disclosure core read it
 * (an MCP envelope's two names exempt for a destination other than Intent Cloud, an outcome report's order gid for
 * Intent Cloud), and the CartRequest the pending
 * entry chained. Intent Cloud's own content (the snapshot's merchant name) is not buyer identity and is not scanned
 * with these rules, which are made for outbound bodies; observations and outcome statements have their own checks.
 */
function sentIdentity(entries: readonly Entry[]): string[] {
  const found: string[] = [];
  for (const e of entries) {
    const b = typeof e.body === "object" && e.body !== null ? (e.body as Record<string, unknown>) : {};
    let value: unknown = null;
    let mcpEnvelope = false;
    let orderRefAt: readonly string[] = [];
    if (e.kind === "disclosure" && typeof b.body_b64 === "string" && b.body_b64 !== "") {
      const headers = Array.isArray(b.headers) ? (b.headers as unknown[]).filter((h): h is [string, string] => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === "string")) : [];
      try {
        value = bodyValue(headers, Buffer.from(b.body_b64, "base64"));
      } catch {
        value = null; // an unreadable body fails the disclosure checks
      }
      mcpEnvelope = typeof b.destination === "string";
      orderRefAt = sentOrderRefAt(b.endpoint, !mcpEnvelope);
    } else if (e.kind === "approval_pending") {
      value = (b.sent as { cart_request?: unknown } | undefined)?.cart_request ?? null;
    }
    for (const f of findIdentity(value, { mcpEnvelope, orderRefAt })) found.push(`seq ${String(e.seq)}: the ${e.kind} entry holds what looks like buyer identity (${f.kind} at ${f.path})`);
  }
  return found;
}
