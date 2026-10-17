// The evidence pack, format v1 (ADR-0018): one purchase's chain entries, the skeleton of the whole chain they sit in,
// and the root key the gateway pinned, as one canonical JSON (JCS) file. Pure; no I/O.
//
// {format, v, purchase, head: {seq, hash}, pinned_root: [{kid, jwk}], skeleton: [{seq, prev, hash}] (every entry of
// the chain, from genesis to the head), entries: [the purchase's entries, whole, in seq order]}
//
// Every byte is checked: an entry must hash to its own skeleton row, the skeleton must link from genesis to the head,
// and the verifier checks the pinned root against its own pin. Nothing in the pack is the exporter's word alone,
// so the pack carries no export time and no gateway version.
import { z } from "zod";
import { canonicalize } from "../jcs/index.ts";
import { type Entry, entryProblem, GENESIS, verifyChain } from "../store/index.ts";
import type { PinnedRootKey } from "../trust/index.ts";
import { purchaseEntries } from "./select.ts";

export const EVIDENCE_FORMAT = "intent-gateway-evidence";
export const EVIDENCE_VERSION = 1;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Seq = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const SkeletonRow = z.strictObject({ seq: Seq, prev: Hex64, hash: Hex64 });
export const PackRootKey = z.strictObject({
  kid: z.string().min(1).max(200),
  jwk: z.strictObject({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
});

export const EvidencePack = z.strictObject({
  format: z.literal(EVIDENCE_FORMAT),
  v: z.literal(EVIDENCE_VERSION),
  /** The approval handle. */
  purchase: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  head: z.strictObject({ seq: Seq, hash: Hex64 }),
  pinned_root: z.array(PackRootKey).min(1).max(8),
  skeleton: z.array(SkeletonRow).min(1),
  /** Chain entries, checked one by one (entryProblem), so typed loosely here. */
  entries: z.array(z.unknown()).min(1),
});
export type EvidencePack = z.infer<typeof EvidencePack>;

export class EvidenceError extends Error {
  override name = "EvidenceError";
}

/**
 * The pack for purchase `handle` from a whole chain that verified, under the root keys the gateway pins. Throws
 * EvidenceError when the chain is broken or holds no verified approval for the handle.
 */
export function buildEvidence(chain: readonly unknown[], handle: string, pinnedRootKeys: readonly PinnedRootKey[]): EvidencePack {
  const linked = verifyChain(chain);
  if (!linked.ok) throw new EvidenceError(`the chain is broken at seq ${String(linked.brokenSeq)} (${linked.reason})`);
  const entries = chain as Entry[];
  const { roles, missing } = purchaseEntries(entries, handle);
  if (missing.length > 0) throw new EvidenceError(`no purchase ${handle} to export: ${missing.join("; ")}`);
  const roots = pinnedRootKeys.map((k) => PackRootKey.safeParse(k));
  if (roots.length === 0 || roots.some((r) => !r.success)) throw new EvidenceError("the pinned root keys are not Ed25519 keys {kid, jwk}");
  const last = entries.at(-1) as Entry;
  return {
    format: EVIDENCE_FORMAT,
    v: EVIDENCE_VERSION,
    purchase: handle,
    head: { seq: last.seq, hash: last.hash },
    pinned_root: roots.map((r) => r.data as z.infer<typeof PackRootKey>),
    skeleton: entries.map(({ seq, prev, hash }) => ({ seq, prev, hash })),
    entries: entries.filter((e) => roles.has(e.seq)),
  };
}

/** The pack as its file holds it: canonical JSON and a newline. */
export function packText(pack: EvidencePack): string {
  return `${canonicalize(pack)}\n`;
}

/** A pack read from its file text, or why it is not one (not JSON, not canonical, not the v1 shape). */
export function readPack(text: string): { ok: true; pack: EvidencePack } | { ok: false; problem: string } {
  const json = text.endsWith("\n") ? text.slice(0, -1) : text;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, problem: "the file is not JSON" };
  }
  let canonical: string | null;
  try {
    canonical = canonicalize(value);
  } catch {
    canonical = null;
  }
  if (canonical !== json) return { ok: false, problem: "the file is not canonical JSON (RFC 8785): it was changed after export" };
  const parsed = EvidencePack.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problem: `not an evidence pack v1 (${parsed.error.issues.map((i) => `${i.path.join(".") || "pack"}: ${i.message}`).join("; ")})` };
  }
  return { ok: true, pack: parsed.data };
}

/**
 * Why the pack's entries are not in the chain its skeleton describes, one line each naming the field: the skeleton
 * must run from genesis to the head with every prev the previous hash; each entry must be a well-formed entry whose
 * hash is its content's, in seq order, and match its skeleton row.
 */
export function skeletonProblems(pack: EvidencePack): string[] {
  const problems: string[] = [];
  let prev = GENESIS;
  for (const [i, row] of pack.skeleton.entries()) {
    if (row.seq !== i) problems.push(`skeleton[${String(i)}].seq is ${String(row.seq)}, expected ${String(i)}`);
    if (row.prev !== prev) problems.push(`skeleton[${String(i)}].prev is not the hash of the row before it${i === 0 ? " (genesis)" : ""}`);
    prev = row.hash;
  }
  const last = pack.skeleton.at(-1);
  if (last !== undefined && (pack.head.seq !== last.seq || pack.head.hash !== last.hash)) problems.push("head is not the skeleton's last row");
  let after = -1;
  for (const [i, item] of pack.entries.entries()) {
    const at = `entries[${String(i)}]`;
    const problem = entryProblem(item);
    if (problem !== null) {
      problems.push(`${at}: ${problem}`);
      continue;
    }
    const entry = item as Entry;
    if (entry.seq <= after) problems.push(`${at}: seq ${String(entry.seq)} is not after the entry before it`);
    after = Math.max(after, entry.seq);
    const row = pack.skeleton[entry.seq];
    if (row === undefined) problems.push(`${at}: seq ${String(entry.seq)} is past the head`);
    else if (row.hash !== entry.hash || row.prev !== entry.prev) problems.push(`${at}: seq ${String(entry.seq)} does not match skeleton[${String(entry.seq)}]`);
  }
  return problems;
}
