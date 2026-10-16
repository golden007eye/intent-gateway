// What the panel shows, computed from the chain items `readChain` returns. Pure; no I/O.
//
// Entry bodies are written by other modules (disclosure, trust, gateway). The panel reads only these keys and
// shows "" or [] when one is absent, so a body it does not understand is still listed, never hidden:
// - disclosure, block: `endpoint` (string), `fields` (string[]: field names sent), `blocked` (string[]).
// - receipt, unacknowledged, discarded: `disclosure_seq` (number), `reason` (string).
// - approval_pending, approval: `handle` (string); approval_pending also `approval_url` (string).
// - approver_pin, approver_flag: `fingerprint` (string).
import { type ChainResult, type Entry, neverLeft, verifyChain } from "../store/index.ts";

export interface Row {
  seq: number;
  ts: string;
  kind: string;
  endpoint: string;
  fields: string[];
  blocked: string[];
  note: string;
}

export interface PendingApproval {
  seq: number;
  ts: string;
  handle: string;
  approvalUrl: string;
}

export interface Fingerprint {
  seq: number;
  ts: string;
  fingerprint: string;
}

export interface View {
  chain: ChainResult;
  /** Disclosures, blocks and what came back for each, in chain order. */
  rows: Row[];
  /** approval_pending entries with no later approval for the same handle. */
  pending: PendingApproval[];
  /** The last approver_pin, or null before the first verified Approval. */
  pin: Fingerprint | null;
  /** approver_flag entries whose fingerprint is not the current pin. */
  flags: Fingerprint[];
  /** Items that are not entries (torn or non-canonical lines), by position. */
  unreadable: number[];
}

const ROW_KINDS = new Set(["disclosure", "block", "receipt", "unacknowledged", "discarded"]);
const FOLLOW_UPS = new Set(["receipt", "unacknowledged", "discarded"]);
/** The note on a disclosure no entry answers, in the words `intent log` uses: never "sent" (invariant 5). */
const UNANSWERED_NOTE = "logged, maybe sent; no answer recorded";
const NOT_SENT_NOTE = "logged, not sent: no connection was made";

export function buildView(items: readonly unknown[]): View {
  const rows: Row[] = [];
  const pending = new Map<string, PendingApproval>();
  const flagged: Fingerprint[] = [];
  const unreadable: number[] = [];
  let pin: Fingerprint | null = null;
  // Disclosures some entry answers, and those whose request never left.
  const answered = new Set<unknown>();
  const notSent = new Set<unknown>();
  for (const item of items) {
    if (!isEntry(item) || !FOLLOW_UPS.has(item.kind)) continue;
    const ref = record(item.body).disclosure_seq;
    answered.add(ref);
    if (item.kind === "unacknowledged" && neverLeft(item.body)) notSent.add(ref);
  }

  for (const [index, item] of items.entries()) {
    if (!isEntry(item)) {
      unreadable.push(index);
      continue;
    }
    const body = record(item.body);
    const { seq, ts, kind } = item;
    if (ROW_KINDS.has(kind)) {
      const ref = body.disclosure_seq;
      rows.push({
        seq,
        ts,
        kind,
        endpoint: text(body.endpoint),
        fields: strings(body.fields),
        blocked: strings(body.blocked),
        note:
          kind !== "disclosure"
            ? [typeof ref === "number" ? `for #${String(ref)}` : "", text(body.reason)].filter(Boolean).join(" ")
            : notSent.has(seq)
              ? NOT_SENT_NOTE
              : answered.has(seq)
                ? ""
                : UNANSWERED_NOTE,
      });
    } else if (kind === "approval_pending") {
      pending.set(text(body.handle), { seq, ts, handle: text(body.handle), approvalUrl: text(body.approval_url) });
    } else if (kind === "approval") {
      pending.delete(text(body.handle));
    } else if (kind === "approver_pin") {
      pin = { seq, ts, fingerprint: text(body.fingerprint) };
    } else if (kind === "approver_flag") {
      flagged.push({ seq, ts, fingerprint: text(body.fingerprint) });
    }
  }

  const current = pin?.fingerprint;
  return {
    chain: verifyChain(items),
    rows,
    pending: [...pending.values()],
    pin,
    flags: flagged.filter((flag) => flag.fingerprint !== current),
    unreadable,
  };
}

function isEntry(item: unknown): item is Entry {
  if (typeof item !== "object" || item === null) return false;
  const { seq, ts, kind } = item as Record<string, unknown>;
  return typeof seq === "number" && typeof ts === "string" && typeof kind === "string";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
