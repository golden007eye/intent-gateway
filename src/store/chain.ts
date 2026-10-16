// The local hash chain: entry format, line parsing and verification. Pure; no I/O.

import { canonicalize, sha256Hex } from "../jcs/index.ts";

export const ENTRY_KINDS = [
  "session",
  "keys",
  "disclosure",
  "receipt",
  "unacknowledged",
  "discarded",
  "block",
  "approval_pending",
  "approval",
  "approver_pin",
  "approver_flag",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * How an `unacknowledged` entry's reason starts when no connection was ever made (DNS failure, connection refused):
 * the logged request never left the machine, so `intent log` and `intent verify` report it as not sent.
 */
export const NOT_SENT_REASON = "CloudNetworkError: not sent";

/** Whether an `unacknowledged` entry's body records a request that never left the machine (see NOT_SENT_REASON). */
export function neverLeft(body: unknown): boolean {
  const reason = typeof body === "object" && body !== null ? (body as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" && reason.startsWith(NOT_SENT_REASON);
}

/** One line of `audit.jsonl`. `hash` is the sha256 of the canonical JSON of the other five fields. */
export interface Entry {
  readonly seq: number;
  readonly prev: string;
  readonly ts: string;
  readonly kind: EntryKind;
  readonly body: unknown;
  readonly hash: string;
}

export type ChainResult = { ok: true } | { ok: false; brokenSeq: number; reason: string };

/** The `prev` of entry 0. */
export const GENESIS = "0".repeat(64);

const kinds: ReadonlySet<string> = new Set(ENTRY_KINDS);
const fields = ["body", "hash", "kind", "prev", "seq", "ts"];

export function isEntryKind(kind: unknown): kind is EntryKind {
  return typeof kind === "string" && kinds.has(kind);
}

export function entryHash(entry: Omit<Entry, "hash">): string {
  const { seq, prev, ts, kind, body } = entry;
  return sha256Hex(canonicalize({ seq, prev, ts, kind, body }));
}

/**
 * Splits log text into one item per line: the parsed entry when the line is the canonical JSON of an object,
 * otherwise the raw line text, which `verifyChain` reports as broken. A last line without its newline is torn
 * and is returned as raw text too.
 */
export function parseLines(text: string): unknown[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const last = lines.pop() as string;
  const items = lines.map(parseLine);
  if (last !== "") items.push(last);
  return items;
}

function parseLine(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && !Array.isArray(value) && canonicalize(value) === line) {
      return value;
    }
  } catch {
    // Not JSON, or outside the canonical profile: fall through to the raw text.
  }
  return line;
}

/**
 * Checks each item from `parseLines` in order and names the first entry (by expected seq) that breaks the chain.
 * `from` continues a chain already verified up to the entry with that seq and hash; omitted, the items start at
 * genesis. Only the file is checked: dropping whole entries from its end leaves a valid, shorter chain (ADR-0007).
 */
export function verifyChain(
  entries: readonly unknown[],
  from: { readonly seq: number; readonly hash: string } = { seq: -1, hash: GENESIS },
): ChainResult {
  let prev = from.hash;
  for (const [index, item] of entries.entries()) {
    const seq = from.seq + 1 + index;
    const reason = entryProblem(item) ?? linkProblem(item as Entry, seq, prev);
    if (reason !== null) return { ok: false, brokenSeq: seq, reason };
    prev = (item as Entry).hash;
  }
  return { ok: true };
}

/** What makes one item from `parseLines` not a well-formed entry on its own, or null. */
export function entryProblem(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return "line is not a canonical JSON entry";
  if (Object.keys(item).sort().join() !== fields.join()) return "entry fields are not seq, prev, ts, kind, body, hash";
  const entry = item as Entry;
  if (!Number.isSafeInteger(entry.seq)) return "seq is not an integer";
  if (!isEntryKind(entry.kind)) return "unknown kind";
  if (typeof entry.ts !== "string") return "ts is not a string";
  if (entry.hash !== entryHash(entry)) return "hash does not match the entry";
  return null;
}

function linkProblem(entry: Entry, seq: number, prev: string): string | null {
  if (entry.seq !== seq) return `seq is ${String(entry.seq)}, expected ${String(seq)}`;
  if (entry.prev !== prev) return "prev does not match the previous entry's hash";
  return null;
}
