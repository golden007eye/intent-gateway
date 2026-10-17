// Which completer keys the gateway may delete now (ADR-0016), read from the chain alone. Pure; the gateway runs it on
// start and after each status call, and deletes what it returns.
//
// A key is named by the `approval_pending` entry of its purchase (`completer_keyid`). It is deleted:
// - with no such entry, an hour after it was made: the cart was refused, or the gateway stopped before chaining the
//   approval, so no chained purchase can ever need it (the hour spares a key whose cart is still on its way);
// - for a purchase never approved (no `approval` entry and no status that showed one), at `expires_at`;
// - for an approved hand-off purchase, once the gateway chained a terminal outcome from a verified outcome statement
//   (an `outcome` entry with `statement_verified` and a terminal `state_shown`, ADR-0015): nothing is left to read or
//   report. An outcome the gateway did not verify deletes nothing, so a forged terminal outcome cannot drop the key
//   early;
// - for an approved `shop_agent` purchase, once a terminal outcome report the key signed got a 201 with a verified
//   receipt, which is the last request the key signs; or once the gateway chained a terminal local outcome while no
//   report the key signed was ever accepted (a refusal before redemption is local only: nothing is left to report);
// - in every case, at `expires_at` + 48 h at the latest: never later than Intent Cloud's completer read window (R7,
//   48 h after the later of `expires_at` and a terminal outcome), after which it accepts nothing the key signs.
import { outcomesFor, TERMINAL_STATES } from "../outcome/index.ts";
import type { CompleterKey } from "../signing/index.ts";
import type { Entry } from "../store/index.ts";
import { PROOF_STATES } from "./status-state.ts";

export const ORPHAN_GRACE_MS = 3_600_000;
export const READ_WINDOW_MS = 48 * 3_600_000;

type Body = Record<string, unknown>;
const asBody = (value: unknown): Body => (typeof value === "object" && value !== null ? (value as Body) : {});
const TERMINAL_REPORTS = new Set(["ordered", "mismatch", "failed"]);

/** The keyids among `keys` that no purchase in `chain` needs any more at `now`. */
export function expiredCompleterKeys(chain: readonly Entry[], keys: readonly CompleterKey[], now: number): string[] {
  const pendingByKey = new Map<string, Entry>();
  for (const entry of chain) {
    const keyid = asBody(entry.body).completer_keyid;
    if (entry.kind === "approval_pending" && typeof keyid === "string") pendingByKey.set(keyid, entry);
  }
  return keys.filter((key) => {
    const pending = pendingByKey.get(key.keyid);
    if (pending === undefined) return !(now < key.createdAt + ORPHAN_GRACE_MS);
    return !keepFor(chain, pending, now);
  }).map((k) => k.keyid);
}

/** Whether the purchase of this `approval_pending` entry still needs its completer key at `now`. */
function keepFor(chain: readonly Entry[], entry: Entry, now: number): boolean {
  const pending = asBody(entry.body);
  const handle = pending.handle;
  const expiresAt = typeof pending.expires_at === "string" ? Date.parse(pending.expires_at) : Number.NaN;
  // A malformed entry cannot be judged: keep the key for the read window from the entry's own time.
  if (typeof handle !== "string" || !Number.isFinite(expiresAt)) return now < Date.parse(entry.ts) + READ_WINDOW_MS;
  const mode = pending.completion_mode === "shop_agent" ? "shop_agent" : "handoff";
  const approved = chain.some((e) => e.kind === "approval" && asBody(e.body).handle === handle);
  const seen = observedStatuses(chain, handle);

  if (!approved) {
    // A status that showed an approval the gateway did not chain (a flagged passkey) may still be accepted later.
    const shownApproved = seen.some((s) => PROOF_STATES.has(s.state as never));
    return now < expiresAt + (shownApproved ? READ_WINDOW_MS : 0);
  }

  const done = mode === "handoff" ? verifiedTerminal(chain, handle) : terminalReport(chain, handle) || refusedUnreported(chain, handle);
  if (done) return false;
  // Every terminal outcome the gateway knows of deletes the key above, so no known terminal ever extends the window:
  // the key goes at expires_at + 48 h, which is never later than Intent Cloud's R7 limit (amendment item 8). A
  // terminal report that never got its 201 is no outcome at Intent Cloud and extends nothing.
  return now < expiresAt + READ_WINDOW_MS;
}

/** Whether the gateway chained a terminal outcome for a handle from a verified outcome statement. */
function verifiedTerminal(chain: readonly Entry[], handle: string): boolean {
  return outcomesFor(chain, handle).some((o) => o.basis === "cloud" && o.statement_verified && o.state_shown !== null && TERMINAL_STATES.has(o.state_shown));
}

/** The `observed` getApproval entries for a handle: the approval state each returned. */
function observedStatuses(chain: readonly Entry[], handle: string): { state: unknown }[] {
  return chain
    .filter((e) => e.kind === "observed" && asBody(e.body).endpoint === "getApproval" && asBody(e.body).approval_handle === handle)
    .map((e) => ({ state: asBody(e.body).state }));
}

/** A terminal local outcome with no outcome report of the purchase ever accepted (201): nothing will be reported. */
function refusedUnreported(chain: readonly Entry[], handle: string): boolean {
  const latest = outcomesFor(chain, handle).filter((o) => o.basis === "local").at(-1);
  if (latest === undefined || !TERMINAL_STATES.has(latest.state)) return false;
  return reportStates(chain, handle).length === 0;
}

/** Whether a terminal outcome report the gateway logged for a handle got a 201 with a verified receipt. */
function terminalReport(chain: readonly Entry[], handle: string): boolean {
  return reportStates(chain, handle).some((state) => TERMINAL_REPORTS.has(state));
}

/** The states of the outcome reports the gateway logged for a handle that got a 201 with a verified receipt. */
function reportStates(chain: readonly Entry[], handle: string): string[] {
  const path = `/v1/approvals/${handle}/outcome-reports`;
  const accepted201 = new Set<number>();
  const states: string[] = [];
  for (const e of chain) {
    const b = asBody(e.body);
    if (e.kind === "receipt" && b.status === 201 && b.verified === true && typeof b.disclosure_seq === "number") accepted201.add(b.disclosure_seq);
  }
  for (const e of chain) {
    const b = asBody(e.body);
    if (e.kind !== "disclosure" || b.endpoint !== "reportOutcome" || b.path !== path || typeof b.body_b64 !== "string") continue;
    let state: unknown;
    try {
      state = asBody(JSON.parse(Buffer.from(b.body_b64, "base64").toString("utf8"))).state;
    } catch {
      continue;
    }
    if (typeof state === "string" && accepted201.has(e.seq)) states.push(state);
  }
  return states;
}
