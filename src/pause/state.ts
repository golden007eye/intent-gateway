// Where the pause stands, read from the chain alone (ADR-0023). Pure; every process (serve, the CLI, the panel) reads
// the same answer from the same entries, so a pause written by one is honoured by all at their next read.
//
// Entries read (written by pause.ts and the gateway):
// - pause {from: "cli" | "panel" | "intent_cloud"}: purchases stop here. A pause while paused keeps the first `since`.
// - pause_sent {pause_seq, counter, disclosure_seq, result, reason, status?, last_counter?, retry_after_s?}: one send of
//   the pause to Intent Cloud and what came back (`acknowledged` only for a 200 whose receipt verified).
// - resume {from, confirmed: false, pending: "next submit"}: the developer said, at a terminal, that they resumed with
//   their passkey. The local pause is cleared, unconfirmed.
// - resume_check {resume_seq, result: "confirmed" | "repaused", disclosure_seq}: the next submit's answer; `repaused`
//   (Intent Cloud still answered `paused`) pauses again.
// - refused {step, reason: "paused", source: "gateway" | "intent_cloud", purchase?, disclosure_seq?}.

/** The parts of a chain entry this module reads. */
export interface PauseEntry {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly body: unknown;
}

export type PauseSource = "cli" | "panel" | "intent_cloud";
export type SendResult = "acknowledged" | "retrying" | "failed";

/** The reason codes a `pause_sent` entry records; pauseReasonWords says each one in plain words. */
export type SendReason =
  | "acknowledged"
  | "no_account_key"
  | "unreachable"
  | "not_found"
  | "rate_limited"
  | "clock_skew"
  | "counter_replayed"
  | "unauthorized"
  | "bad_request"
  | "discarded"
  | "no_keys"
  | "stopped"
  | "error";

export interface PauseState {
  /** The pause in effect, or null when purchases may go ahead. */
  readonly paused: { readonly since: string; readonly seq: number; readonly from: string } | null;
  /** The latest resume that no submit has confirmed yet, or null. */
  readonly unconfirmedResume: { readonly seq: number; readonly at: string } | null;
  /** The latest send of the pause in effect to Intent Cloud, or null when none was recorded yet. */
  readonly cloud: {
    readonly seq: number;
    readonly at: string;
    readonly result: SendResult;
    readonly reason: string;
    readonly retryAfterS: number | null;
  } | null;
  /** How many sends of the pause in effect were recorded as retrying (for the backoff). */
  readonly retries: number;
  /** The `refused` entries since the pause in effect began. */
  readonly refusals: number;
  /** An answer from Intent Cloud said `paused` since the pause in effect began (a `refused` entry from intent_cloud). */
  readonly cloudSaidPaused: boolean;
}

type Body = Record<string, unknown>;
const bodyOf = (e: PauseEntry): Body => (typeof e.body === "object" && e.body !== null && !Array.isArray(e.body) ? (e.body as Body) : {});

/** The pause state after every entry of `entries`, in order. */
export function pauseState(entries: readonly PauseEntry[]): PauseState {
  let paused: { since: string; seq: number; from: string } | null = null;
  let unconfirmed: { seq: number; at: string } | null = null;
  let cloud: PauseState["cloud"] = null;
  let retries = 0;
  let refusals = 0;
  let cloudSaidPaused = false;
  for (const e of entries) {
    const b = bodyOf(e);
    switch (e.kind) {
      case "pause":
        if (paused === null) {
          paused = { since: e.ts, seq: e.seq, from: typeof b.from === "string" ? b.from : "cli" };
          cloud = null;
          retries = 0;
          refusals = 0;
          cloudSaidPaused = false;
        } else if (cloud?.result === "failed") {
          // Pausing again after Intent Cloud refused the pause for good sends it again; the local pause keeps its start.
          cloud = null;
          retries = 0;
        }
        break;
      case "pause_sent":
        if (paused !== null && typeof b.pause_seq === "number" && b.pause_seq >= paused.seq) {
          const result = b.result === "acknowledged" || b.result === "failed" ? b.result : "retrying";
          cloud = { seq: e.seq, at: e.ts, result, reason: typeof b.reason === "string" ? b.reason : "error", retryAfterS: typeof b.retry_after_s === "number" ? b.retry_after_s : null };
          if (result === "retrying") retries += 1;
        }
        break;
      case "resume":
        if (paused !== null) {
          paused = null;
          unconfirmed = { seq: e.seq, at: e.ts };
        }
        break;
      case "resume_check":
        if (unconfirmed !== null && b.resume_seq === unconfirmed.seq) {
          unconfirmed = null;
          if (b.result === "repaused") {
            paused = { since: e.ts, seq: e.seq, from: "intent_cloud" };
            cloud = null;
            retries = 0;
            refusals = 0;
            cloudSaidPaused = false;
          }
        }
        break;
      case "refused":
        if (paused !== null) {
          refusals += 1;
          if (b.source === "intent_cloud") cloudSaidPaused = true;
        }
        break;
      default:
        break;
    }
  }
  return { paused, unconfirmedResume: unconfirmed, cloud, retries, refusals, cloudSaidPaused };
}

/** Whether purchases are paused after `entries`: the one test create_cart and complete_checkout read. */
export function pausedIn(entries: readonly PauseEntry[]): boolean {
  return pauseState(entries).paused !== null;
}

/**
 * The next pause counter: one more than every counter this chain ever sent (read from the logged request bytes, so a
 * send cut short by a crash still counts) or learned from Intent Cloud (`last_counter` on 409 counter_replayed). The
 * chain persists it, so it strictly grows across restarts.
 */
export function nextCounter(entries: readonly PauseEntry[]): number {
  let highest = 0;
  for (const e of entries) {
    const b = bodyOf(e);
    if (e.kind === "pause_sent") {
      for (const n of [b.counter, b.last_counter]) if (typeof n === "number" && Number.isSafeInteger(n) && n > highest) highest = n;
    } else if (e.kind === "disclosure" && b.endpoint === "pause" && typeof b.body_b64 === "string") {
      try {
        const sent = JSON.parse(Buffer.from(b.body_b64, "base64").toString("utf8")) as { counter?: unknown };
        if (typeof sent.counter === "number" && Number.isSafeInteger(sent.counter) && sent.counter > highest) highest = sent.counter;
      } catch {
        // Not JSON: it carries no counter.
      }
    }
  }
  return highest + 1;
}

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
/** The longest Retry-After honoured: a larger one (an answer from anyone on the path) cannot put the pause off for days. */
const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * When the pause in effect should next be sent to Intent Cloud (milliseconds since the epoch), or null when it needs no
 * send: not paused, acknowledged, or refused for good. Backoff from 5 s doubling to 5 min, or Retry-After when longer
 * (1 hour at most).
 */
export function nextSendAt(state: PauseState): number | null {
  if (state.paused === null) return null;
  const last = state.cloud;
  // Intent Cloud itself answered `paused`: there is nothing to tell it.
  if (last === null && state.paused.from === "intent_cloud") return null;
  if (last === null) return Date.parse(state.paused.since);
  if (last.result !== "retrying") return null;
  const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, state.retries - 1));
  const delay = Math.max(backoff, Math.min(MAX_RETRY_AFTER_MS, (last.retryAfterS ?? 0) * 1000));
  return Date.parse(last.at) + delay;
}

/** A send's reason code in plain words, for `intent log`, `intent status` and the panel. */
export function pauseReasonWords(reason: string): string {
  switch (reason) {
    case "acknowledged":
      return "Intent Cloud acknowledged the pause";
    case "no_account_key":
      return "no account key on this machine, so the pause holds here only";
    case "unreachable":
      return "the send to Intent Cloud got no answer";
    case "not_found":
      return "a not_found answer was received from Intent Cloud: it does not know this machine's account key yet";
    case "rate_limited":
      return "rate limited: a 429 was received from Intent Cloud";
    case "clock_skew":
      return "a clock_skew answer was received from Intent Cloud: check this machine's clock";
    case "counter_replayed":
      return "a counter_replayed answer was received from Intent Cloud; the gateway carries on from its last counter";
    case "unauthorized":
      return "an unauthorized answer was received from Intent Cloud (the signature)";
    case "bad_request":
      return "a bad_request answer was received from Intent Cloud";
    case "discarded":
      return "the answer carried no valid receipt, so the gateway did not use it";
    case "no_keys":
      return "no verified key statement yet";
    case "stopped":
      return "the gateway stopped sending after a log failure; restart it";
    default:
      return "the send failed";
  }
}

/** One purchase a pause stops: asked for approval, not expired, and not settled (not paid through intent yet). */
export interface StoppedPurchase {
  readonly handle: string;
  readonly totalMinor: number | null;
}

const SETTLED = new Set(["ordered", "mismatch", "failed"]);

/** The purchases the pause in effect stops, in chain order; [] when not paused. */
export function stoppedPurchases(entries: readonly PauseEntry[], nowMs: number): StoppedPurchase[] {
  if (!pausedIn(entries)) return [];
  const settled = new Set<unknown>();
  for (const e of entries) {
    const b = bodyOf(e);
    if (e.kind === "outcome" && typeof b.state_shown === "string" && SETTLED.has(b.state_shown)) settled.add(b.handle);
  }
  const out: StoppedPurchase[] = [];
  for (const e of entries) {
    const b = bodyOf(e);
    if (e.kind !== "approval_pending" || typeof b.handle !== "string" || settled.has(b.handle)) continue;
    const expires = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : Number.NaN;
    if (Number.isFinite(expires) && expires <= nowMs) continue;
    out.push({ handle: b.handle, totalMinor: typeof b.total_minor === "number" ? b.total_minor : null });
  }
  return out;
}

/** The confirm origin of the latest chained key statement, or null: where `intent resume` sends the developer. */
export function confirmOrigin(entries: readonly PauseEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as PauseEntry;
    if (e.kind !== "keys") continue;
    const statement = bodyOf(e).statement;
    const origin = typeof statement === "object" && statement !== null ? (statement as Body).confirm_origin : undefined;
    if (typeof origin === "string" && /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin)) return origin;
  }
  return null;
}

const SOURCES = new Set(["cli", "panel", "intent_cloud"]);
const RESULTS = new Set(["acknowledged", "retrying", "failed"]);

/** The counter a logged pause request carried, read from its body bytes; undefined when there is none. */
function loggedCounter(disclosure: PauseEntry): unknown {
  try {
    return (JSON.parse(Buffer.from(String(bodyOf(disclosure).body_b64), "base64").toString("utf8")) as { counter?: unknown }).counter;
  } catch {
    return undefined;
  }
}

/**
 * What `intent verify` finds wrong with the pause entries of a chain (ADR-0023), one line per problem: each must come
 * in an order the gateway can write. A resume only while paused; a resume_check only for the unconfirmed resume in
 * effect; a gateway refusal only while paused; a pause_sent only after its pause, naming a `pause` disclosure whose
 * logged counter it repeats, acknowledged only with a 200 receipt; and every logged pause counter above all earlier ones.
 */
export function pauseProblems(entries: readonly PauseEntry[]): string[] {
  const problems: string[] = [];
  let highest = 0;
  for (const [index, e] of entries.entries()) {
    const at = `seq ${String(e.seq)}`;
    const b = bodyOf(e);
    const before = entries.slice(0, index);
    switch (e.kind) {
      case "pause":
        if (!SOURCES.has(String(b.from))) problems.push(`${at}: the pause names no known source (cli, panel or intent_cloud)`);
        break;
      case "resume":
        if (!pausedIn(before)) problems.push(`${at}: a resume with no pause in effect before it`);
        break;
      case "resume_check": {
        const open = pauseState(before).unconfirmedResume;
        if (open === null || b.resume_seq !== open.seq) problems.push(`${at}: the resume_check names no unconfirmed resume in effect before it`);
        else if (b.result !== "confirmed" && b.result !== "repaused") problems.push(`${at}: the resume_check result is neither confirmed nor repaused`);
        break;
      }
      case "refused":
        if (b.reason !== "paused") problems.push(`${at}: the refusal names no known reason`);
        else if (b.source !== "gateway" && b.source !== "intent_cloud") problems.push(`${at}: the refusal names no known source`);
        else if (b.source === "gateway" && !pausedIn(before)) problems.push(`${at}: the gateway refused as paused with no pause in effect before it`);
        break;
      case "disclosure":
        if (b.endpoint === "pause") {
          const counter = loggedCounter(e);
          if (typeof counter !== "number" || !Number.isSafeInteger(counter)) problems.push(`${at}: the pause disclosure carries no integer counter`);
          else if (counter <= highest) problems.push(`${at}: the pause counter ${String(counter)} does not grow (an earlier pause sent ${String(highest)})`);
          else highest = counter;
        }
        break;
      case "pause_sent": {
        const pause = before.find((p) => p.seq === b.pause_seq && p.kind === "pause");
        if (pause === undefined) {
          problems.push(`${at}: the pause_sent names no earlier pause`);
          break;
        }
        if (!RESULTS.has(String(b.result))) problems.push(`${at}: the pause_sent result is not acknowledged, retrying or failed`);
        if (b.disclosure_seq === null) {
          if (b.result === "acknowledged") problems.push(`${at}: the pause_sent is acknowledged with no disclosure`);
          break;
        }
        const sent = before.find((d) => d.seq === b.disclosure_seq && d.kind === "disclosure" && bodyOf(d).endpoint === "pause" && d.seq > pause.seq);
        if (sent === undefined) {
          problems.push(`${at}: the pause_sent names no pause disclosure after its pause`);
          break;
        }
        if (loggedCounter(sent) !== b.counter) problems.push(`${at}: the pause_sent counter is not the one its disclosure logged`);
        if (b.result === "acknowledged" && !before.some((r) => r.kind === "receipt" && bodyOf(r).disclosure_seq === sent.seq && bodyOf(r).status === 200)) {
          problems.push(`${at}: the pause_sent is acknowledged without a 200 receipt for its disclosure`);
        }
        break;
      }
      default:
        break;
    }
  }
  return problems;
}
