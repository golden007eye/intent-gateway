// What the gateway reads back from its own chain: the spend history for the policy's daily and weekly caps, and
// the "Sent: … / Blocked: …" summary of one tool call. Pure; the chain is passed in.
import { destinationLabel, MCP_CLIENT_META, MCP_ENVELOPE } from "../activity/index.ts";
import { chargedNothing } from "../outcome/index.ts";
import type { Purchase } from "../policy/index.ts";
import { type Entry, neverLeft } from "../store/index.ts";

type Body = Record<string, unknown>;
const asBody = (value: unknown): Body => (typeof value === "object" && value !== null ? (value as Body) : {});

/**
 * The purchases that count against the spend caps, from the chain:
 * - every `approval` entry (a verified Approval), at its entry time, for the snapshot total in its proof;
 * - every `approval_pending` entry with no `approval` yet whose snapshot has not expired at `now`, so that several
 *   carts opened at once cannot each fit under a cap and together exceed it.
 * A malformed entry becomes a purchase with no valid total, which `evaluate` refuses (`history_invalid`) instead
 * of skipping it, so a damaged chain never turns a cap off.
 *
 * An approval stops counting only on local evidence that it charged nothing (outcome's chargedNothing: the gateway's
 * own precheck refusal before any `complete_checkout` was logged, or Shop's terminal not-completed checkout read by
 * the gateway). An outcome Intent Cloud states, verified or not, never frees cap room (contract §6, ADR-0015).
 */
export function spendHistory(chain: readonly Entry[], now: number): Purchase[] {
  const approved = new Set<unknown>();
  const purchases: Purchase[] = [];
  for (const entry of chain) {
    if (entry.kind !== "approval") continue;
    const body = asBody(entry.body);
    approved.add(body.handle);
    if (typeof body.handle === "string" && chargedNothing(chain, body.handle)) continue;
    const snapshot = asBody(asBody(body.proof).snapshot);
    // A v4 snapshot (contract 1.7.0) signs `totals.total` in `currency`, and counts against the caps in that currency
    // only (never converted); v1 to v3 totals are USD.
    const total = snapshot.v === 4 ? asBody(snapshot.totals).total : asBody(snapshot.total).amount_minor;
    const currency = snapshot.v === 4 ? snapshot.currency : "USD";
    purchases.push({ at: Date.parse(entry.ts), total_usd: typeof total === "number" ? total / 100 : Number.NaN, ...currencyOf(currency) });
  }
  for (const entry of chain) {
    if (entry.kind !== "approval_pending") continue;
    const body = asBody(entry.body);
    if (approved.has(body.handle)) continue;
    const expires = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    if (expires <= now) continue;
    const total = body.total_minor;
    const valid = typeof total === "number" && Number.isFinite(expires);
    // `currency` from contract 1.7.0 submits; an entry written before it is a USD cart.
    purchases.push({ at: Date.parse(entry.ts), total_usd: valid ? total / 100 : Number.NaN, ...currencyOf(body.currency ?? "USD") });
  }
  return purchases;
}

/** A purchase's currency: USD is left implicit; anything that is not a string makes the purchase invalid (`evaluate`). */
function currencyOf(value: unknown): { currency?: string } {
  if (value === "USD") return {};
  return { currency: typeof value === "string" ? value : "" };
}

/** What one tool call disclosed, read from the chain entries it appended. Field names only, never values. */
export interface Disclosed {
  /**
   * Each logged send: its destination (null for Intent Cloud), its operation, the body fields it carried, whether a
   * verified receipt acknowledged it, and whether any entry answers it (one that none does was logged and maybe
   * sent, with no answer recorded). A destination other than Intent Cloud signs no receipt: a `response` answers it.
   */
  readonly sends: readonly { destination: string | null; endpoint: string; fields: readonly string[]; acknowledged: boolean; answered: boolean }[];
  /** What was held back: `block` entries' items, then any the caller adds. */
  readonly blocked: readonly string[];
}

/**
 * The entries after `fromSeq` (the chain's head before the call), as a Disclosed. With `own` (the seqs this call
 * appended, store's appendedHere), only those: a request another process or call logged meanwhile is not this call's.
 */
export function disclosedSince(chain: readonly Entry[], fromSeq: number, own: ReadonlySet<number> | null = null): Disclosed {
  const sends: { destination: string | null; endpoint: string; fields: string[]; acknowledged: boolean; answered: boolean }[] = [];
  const bySeq = new Map<number, (typeof sends)[number]>();
  const blocked: string[] = [];
  for (const entry of chain) {
    if (entry.seq <= fromSeq || (own !== null && !own.has(entry.seq))) continue;
    const body = asBody(entry.body);
    if (entry.kind === "disclosure") {
      const destination = typeof body.destination === "string" && body.destination !== "intent_cloud" ? body.destination : null;
      const send = { destination, endpoint: String(body.endpoint), fields: leafFields(strings(body.fields)), acknowledged: false, answered: false };
      sends.push(send);
      bySeq.set(entry.seq, send);
    } else if (
      (entry.kind === "receipt" || entry.kind === "response" || entry.kind === "unacknowledged" || entry.kind === "discarded") &&
      typeof body.disclosure_seq === "number"
    ) {
      const send = bySeq.get(body.disclosure_seq);
      if (send !== undefined) {
        send.answered = true;
        if (entry.kind === "receipt" && body.verified === true) send.acknowledged = true;
      }
    }
    if (entry.kind === "unacknowledged" && neverLeft(entry.body) && typeof body.disclosure_seq === "number") {
      // No connection was made, so the logged request never left: it is not listed as sent (invariant 5).
      const send = bySeq.get(body.disclosure_seq);
      if (send !== undefined) sends.splice(sends.indexOf(send), 1);
    } else if (entry.kind === "block") {
      blocked.push(...strings(body.blocked));
    }
  }
  return { sends, blocked };
}

/**
 * "Sent: … / Blocked: …", the last line of every tool result (invariant 5: what was sent, nothing more). A send no
 * entry answers is listed apart, as `intent log` does: "Logged, maybe sent; no answer recorded: …".
 */
export function summaryLine(disclosed: Disclosed, extraBlocked: readonly string[] = []): string {
  const fieldsOf = (s: Disclosed["sends"][number]) => {
    const fields = s.destination === null ? s.fields : mcpFields(s.fields);
    return fields.length === 0 ? "no body fields" : fields.join(", ");
  };
  const nameOf = (s: Disclosed["sends"][number]) => (s.destination === null ? s.endpoint : `${destinationLabel(s.destination)} ${s.endpoint}`);
  const answer = (s: Disclosed["sends"][number]) =>
    s.destination !== null ? "; answered, no signed receipt" : s.acknowledged ? "; receipt verified" : "; no verified receipt";
  const sent = disclosed.sends.filter((s) => s.answered).map((s) => `${nameOf(s)} (${fieldsOf(s)}${answer(s)})`);
  const unanswered = disclosed.sends.filter((s) => !s.answered).map((s) => `${nameOf(s)} (${fieldsOf(s)})`);
  const blocked = [...disclosed.blocked, ...extraBlocked];
  return [
    `Sent: ${sent.length === 0 ? "nothing" : sent.join("; ")}`,
    ...(unanswered.length === 0 ? [] : [`Logged, maybe sent; no answer recorded: ${unanswered.join("; ")}`]),
    `Blocked: ${blocked.length === 0 ? "nothing" : blocked.join("; ")}`,
  ].join(" / ");
}

/**
 * A wallet's MCP request fields, as the agent reads them: the tool's arguments by name (`params.arguments.` dropped),
 * then any other field, then the protocol fields every MCP request carries, counted. Every logged field is still
 * named or counted (invariant 5); `intent log -v` lists each one.
 */
function mcpFields(fields: readonly string[]): string[] {
  const args: string[] = [];
  const other: string[] = [];
  let protocol = 0;
  for (const field of fields) {
    if (field.startsWith("params.arguments.")) args.push(field.slice("params.arguments.".length));
    else if (MCP_ENVELOPE.has(field) || MCP_CLIENT_META.has(field)) protocol++;
    else other.push(field);
  }
  return [...args, ...other, ...(protocol === 0 ? [] : [`${String(protocol)} MCP protocol field${protocol === 1 ? "" : "s"}`])];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Drops a field when a deeper one names it as its parent: `ship_to` goes, `ship_to.postal_code` stays. */
function leafFields(fields: readonly string[]): string[] {
  return fields.filter((f) => !fields.some((g) => g.startsWith(`${f}.`) || g.startsWith(`${f}[]`)));
}
