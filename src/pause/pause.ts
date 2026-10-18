// Pause (ADR-0023): stop every purchase through the gateway that is not paid yet, here at once and at Intent Cloud.
//
// 1. pauseLocally appends a `pause` entry. From that entry on, the gateway refuses create_cart and the completion's
//    complete_checkout (state.ts's pausedIn, read under the store lease), before anything is sent.
// 2. sendPause signs the pause with the account key and sends `POST /v1/pause` through the disclosed cloud (log before
//    send, invariant 2), with a counter the chain persists (state.ts's nextCounter). Each send ends in a `pause_sent`
//    entry: acknowledged (a 200 whose receipt verified), retrying, or failed (refused for good: 400 bad_request, 401).
//    A 409 counter_replayed carries on from Intent Cloud's last_counter at once.
// 3. startPauseRetry runs while `intent serve` runs: it sends again with backoff (5 s doubling to 5 min, or Retry-After)
//    until Intent Cloud acknowledges. The local pause holds whatever Intent Cloud answers.
// 4. Resume needs the buyer's passkey on the confirm page's /account; the gateway never resumes Intent Cloud. After the
//    developer confirms at a terminal, resumeLocally clears the local pause, unconfirmed; the next submit's answer
//    confirms it or pauses again (noteSubmitAnswer).
// The account key is a port: `intent init` makes it (the file and its format are its own); this module only signs.
import {
  answerError,
  type PauseAccepted,
  PauseError,
  type PauseRequest,
} from "../contract/index.ts";
// Types only: the panel reads this module's state and must reach no network module, so the disclosure errors are
// told apart by name (each sets its own `name`).
import type { DisclosedResult } from "../disclosure/index.ts";
import { pauseSigningBytes } from "../contract/index.ts";
import { type Entry, type Store, StoreConflictError } from "../store/index.ts";
import { nextCounter, nextSendAt, pausedIn, pauseState, type PauseSource, type SendReason, type SendResult } from "./state.ts";

/** What the pause needs from the account key `intent init` makes: its RFC 7638 thumbprint and an Ed25519 signature. */
export interface AccountKey {
  /** RFC 7638 SHA-256 thumbprint of {crv, kty, x}, base64url without padding (43 characters). */
  readonly thumbprint: string;
  /** Ed25519 signature (64 bytes) over `message`. */
  sign(message: Uint8Array): Uint8Array;
}

/** Reads the account key; null when this machine has none (the pause then holds locally only). */
export type AccountKeySource = () => Promise<AccountKey | null>;

/** Sends one pause through the disclosed cloud (DisclosedCloud.pause of a started gateway). */
export type PauseTransport = (request: PauseRequest) => Promise<DisclosedResult<PauseAccepted>>;

export interface SendDeps {
  readonly store: Store;
  readonly accountKey: AccountKeySource;
  /** Builds the transport (a started gateway); a throw means Intent Cloud cannot be reached now. */
  readonly connect: () => Promise<PauseTransport>;
  readonly now: () => number;
}

/** What one sendPause ended with: the last `pause_sent` it appended, or why it sent nothing. */
export type SendOutcome =
  | { readonly sent: true; readonly result: SendResult; readonly reason: SendReason }
  | { readonly sent: false; readonly why: "not_paused" | "acknowledged" | "no_account_key" };

/** Appends the local pause. It takes effect at once, before Intent Cloud is contacted. */
export async function pauseLocally(store: Store, from: PauseSource): Promise<Entry> {
  return store.append("pause", { from });
}

/** RFC 3339 UTC with seconds and Z. */
function issuedAt(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** The signed pause body for one counter: the exact request sent. */
export function signPause(key: AccountKey, counter: number, at: string): PauseRequest {
  const fields = { account_key_thumbprint: key.thumbprint, counter, issued_at: at };
  const signature = Buffer.from(key.sign(pauseSigningBytes(fields))).toString("base64url");
  return { ...fields, signature };
}

const MAX_REPLAYS = 3;

/**
 * Sends the pause in effect to Intent Cloud once (and again at once after a 409 counter_replayed, up to 3 times), and
 * chains each send's result as `pause_sent`. Never throws for a network or Intent Cloud failure: those are results.
 */
export async function sendPause(deps: SendDeps): Promise<SendOutcome> {
  const { store, now } = deps;
  for (let round = 0; ; round++) {
    const state = pauseState(store.entries());
    if (state.paused === null) return { sent: false, why: "not_paused" };
    // Acknowledged, or paused by Intent Cloud's own answer: there is nothing to tell it.
    if (state.cloud?.result === "acknowledged" || (state.cloud === null && state.paused.from === "intent_cloud")) return { sent: false, why: "acknowledged" };
    const pauseSeq = state.paused.seq;
    const key = await deps.accountKey().catch(() => null);
    if (key === null) {
      // Said once per pause: a key that is still missing adds no line on each retry.
      if (state.cloud?.reason !== "no_account_key") await store.append("pause_sent", { pause_seq: pauseSeq, counter: null, disclosure_seq: null, result: "retrying", reason: "no_account_key" });
      return { sent: false, why: "no_account_key" };
    }
    const counter = nextCounter(store.entries());
    const head = store.entries().at(-1)?.seq ?? -1;
    const attempt = await attemptOnce(deps, signPause(key, counter, issuedAt(now())));
    const disclosure = store.entries().find((e) => e.seq > head && e.kind === "disclosure" && (e.body as { endpoint?: unknown }).endpoint === "pause");
    await store.append("pause_sent", {
      pause_seq: pauseSeq,
      counter,
      disclosure_seq: disclosure?.seq ?? null,
      result: attempt.result,
      reason: attempt.reason,
      ...(attempt.status === undefined ? {} : { status: attempt.status }),
      ...(attempt.lastCounter === undefined ? {} : { last_counter: attempt.lastCounter }),
      ...(attempt.retryAfterS === undefined ? {} : { retry_after_s: attempt.retryAfterS }),
    });
    if (attempt.reason !== "counter_replayed" || round + 1 >= MAX_REPLAYS) return { sent: true, result: attempt.result, reason: attempt.reason };
  }
}

interface Attempt {
  result: SendResult;
  reason: SendReason;
  status?: number;
  lastCounter?: number;
  retryAfterS?: number;
}

async function attemptOnce(deps: SendDeps, request: PauseRequest): Promise<Attempt> {
  let transport: PauseTransport;
  try {
    transport = await deps.connect();
  } catch {
    return { result: "retrying", reason: "unreachable" };
  }
  let answer: DisclosedResult<PauseAccepted>;
  try {
    answer = await transport(request);
  } catch (error) {
    const status = typeof (error as { status?: unknown } | null)?.status === "number" ? { status: (error as { status: number }).status } : {};
    if (named(error, "CloudNetworkError")) return { result: "retrying", reason: "unreachable" };
    if (named(error, "DisclosureDiscardedError")) return { result: "retrying", reason: "discarded", ...status };
    if (named(error, "DisclosureNoKeysError", "DisclosureKeysExpiredError")) return { result: "retrying", reason: "no_keys" };
    if (named(error, "DisclosureStoppedError")) return { result: "retrying", reason: "stopped" };
    return { result: "retrying", reason: "error", ...status };
  }
  if (answer.ok) return { result: "acknowledged", reason: "acknowledged", status: answer.status };
  const status = answer.status;
  const body = PauseError.safeParse(answer.body);
  const code = body.success ? body.data.error : null;
  const retryAfterS = answer.retryAfter ?? undefined;
  if (status === 409 && code === "counter_replayed" && body.success && body.data.last_counter !== undefined) {
    return { result: "retrying", reason: "counter_replayed", status, lastCounter: body.data.last_counter };
  }
  if (status === 404) return { result: "retrying", reason: "not_found", status };
  if (status === 429) return { result: "retrying", reason: "rate_limited", status, ...(retryAfterS === undefined ? {} : { retryAfterS }) };
  if (status === 400 && code === "clock_skew") return { result: "retrying", reason: "clock_skew", status };
  if (status === 401) return { result: "failed", reason: "unauthorized", status };
  if (status === 400) return { result: "failed", reason: "bad_request", status };
  return { result: "retrying", reason: "error", status };
}

export interface PauseRetry {
  /** One check: sends when the pause in effect is due (state.ts's nextSendAt). */
  tick(): Promise<void>;
  stop(): void;
}

/**
 * Retries the pause while `intent serve` runs: every `pollMs` (default 5 s) it reads the chain and sends when the pause
 * in effect is due. A pause written by another process (the CLI, the panel) is picked up the same way.
 */
export function startPauseRetry(deps: SendDeps, options: { pollMs?: number; onError?: (error: unknown) => void } = {}): PauseRetry {
  let running: Promise<void> | null = null;
  let noKeyUntil = 0;
  const tick = async (): Promise<void> => {
    if (running !== null) return running;
    running = (async () => {
      const due = nextSendAt(pauseState(deps.store.entries()));
      if (due === null || deps.now() < due || deps.now() < noKeyUntil) return;
      const outcome = await sendPause(deps);
      // A missing key appends nothing on each retry, so the chain cannot pace these: once a minute.
      noKeyUntil = !outcome.sent && outcome.why === "no_account_key" ? deps.now() + 60_000 : 0;
    })()
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void tick(), options.pollMs ?? 5_000);
  timer.unref();
  return {
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
}

/** Clears the local pause, unconfirmed: the next submit confirms it or pauses again. False when nothing was paused. */
export async function resumeLocally(store: Store, from: "cli"): Promise<boolean> {
  try {
    await store.appendUnless("resume", { from, confirmed: false, pending: "next submit" }, (chain) => !pausedIn(chain));
    return true;
  } catch (error) {
    if (error instanceof StoreConflictError) return false;
    throw error;
  }
}

/**
 * Chains one refusal because of a pause. A gateway refusal is compare-and-appended: it is written only while the chain
 * says paused, so a resume chained meanwhile wins (false: not refused, go ahead). Intent Cloud's refusals always are.
 */
export async function refuseForPause(
  store: Store,
  refusal: { step: "create_cart" | "complete_checkout" | "create_approval" | "report_outcome"; source: "gateway" | "intent_cloud"; purchase?: string; disclosureSeq?: number },
): Promise<boolean> {
  const body = {
    step: refusal.step,
    reason: "paused",
    source: refusal.source,
    ...(refusal.purchase === undefined ? {} : { purchase: refusal.purchase }),
    ...(refusal.disclosureSeq === undefined ? {} : { disclosure_seq: refusal.disclosureSeq }),
  };
  if (refusal.source === "intent_cloud") {
    await store.append("refused", body);
    return true;
  }
  try {
    await store.appendUnless("refused", body, (chain) => !pausedIn(chain));
    return true;
  } catch (error) {
    if (error instanceof StoreConflictError) return false;
    throw error;
  }
}

/** Whether `error` is an Error whose `name` is one of `names`. */
function named(error: unknown, ...names: string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}

/** Whether a thrown cloud error, or an answer, is Intent Cloud's `paused` refusal. */
export function isPausedAnswer(answer: unknown): boolean {
  if (named(answer, "CloudResponseError")) {
    const bytes = (answer as { raw?: { responseBytes?: unknown } }).raw?.responseBytes;
    return bytes instanceof Uint8Array && answerError(bytes) === "paused";
  }
  if (typeof answer === "object" && answer !== null && (answer as { ok?: unknown }).ok === false) {
    const { body, raw } = answer as { body?: unknown; raw?: { responseBytes?: unknown } };
    if (typeof body === "object" && body !== null && (body as { error?: unknown }).error === "paused") return true;
    // A status the 1.6.1 contract does not list for the call: its body was not parsed, so it is read here.
    return raw?.responseBytes instanceof Uint8Array && answerError(raw.responseBytes) === "paused";
  }
  return false;
}

/**
 * Records what a submit (create_cart) learned about the pause at Intent Cloud. `paused`: after an unconfirmed resume,
 * a `resume_check` repaused; with no pause recorded, a `pause` from intent_cloud (paused from another device). Not
 * paused: an unconfirmed resume is confirmed.
 */
export async function noteSubmitAnswer(store: Store, answer: { paused: boolean; disclosureSeq: number | null }): Promise<void> {
  const state = pauseState(store.entries());
  const seq = answer.disclosureSeq;
  if (state.unconfirmedResume !== null) {
    await store.append("resume_check", { resume_seq: state.unconfirmedResume.seq, result: answer.paused ? "repaused" : "confirmed", disclosure_seq: seq });
    return;
  }
  if (answer.paused && state.paused === null) await store.append("pause", { from: "intent_cloud", disclosure_seq: seq });
}
