// One-tap completion (plan G7b; contract 1.6.0 Appendix G; ADR-0018): the step machine that redeems a verified
// `shop_agent` approval with the developer's linked wallet. It runs inside get_approval_status, never in the
// background, and resumes from the chain on every later call, in this process or a restarted one.
//
// Steps, each chained before its outside effect (record before effect):
// 1. Preconditions: the policy allows one_tap, a wallet is usable, `now < S.expires_at`.
// 2. Account: effective per-order cap = min(policy per_order_usd, the wallet's budget left); A above it is refused.
// 3. Quote and precheck: create the wallet checkout; binding-v1 checks 1, 3, 4 and 5 against it (check 2 is the
//    checkout's own hash). A title is advisory only.
// 4. Redeem: compare-and-append `completion` {handle, checkout_ref, report_id, idempotency_key, …} unless one exists
//    for the handle. A conflict means another process owns the purchase: stop.
// 5. Report `completing` (its body is fixed by the completion entry, so every retry is byte-identical). A 409/410
//    before acceptance is a local outcome only, and frees the reservation (no complete_attempt exists).
// 6. Complete, only before S.expires_at: 6a compare-and-append `complete_attempt` {handle, owner} with an owner token
//    held in memory only; 6b the completer precheck on a fresh get_checkout (Appendix G), then complete_checkout,
//    whose disclosure is itself compare-and-appended: only the attempt's owner, only once, only with no outcome yet.
// 7. Reconcile: an attempt with no complete_checkout disclosure was never sent (log before send) → failed
//    (gateway_precheck, not_sent). One with a disclosure may have been sent: get_checkout only, never a second
//    complete_checkout; open, not found or an error → indeterminate, reservation held.
// 8. Report the latest outcome; a report that got no answer is retried on later calls from its logged bytes.
//
// Cap room comes back only from local evidence (outcome's chargedNothing); nothing Intent Cloud says frees it.
// Buyer identity never enters the chain: the wallet port returns projections only, and the binding inputs keep the
// checkout ref hash, never the raw id.
import { randomBytes, randomUUID } from "node:crypto";
import type { ApprovalProof, Binding, OutcomeReport, SnapshotV2 } from "../contract/index.ts";
import { type DisclosedCloud, DisclosureConflictError } from "../disclosure/index.ts";
import { bindingV1, type LocalOutcomeEntry, outcomesFor, shipToOptional } from "../outcome/index.ts";
import type { Session } from "../signing/index.ts";
import { type Entry, type Store, StoreConflictError } from "../store/index.ts";
import { type ChainEntry, type KeySet, verifyApprovalProof } from "../trust/index.ts";
import { AddressFieldsRequiredError, CompletionRefusedError, type WalletAdapter, type WalletCheckout, WalletRailError } from "../wallet/index.ts";

/** What the step machine needs from the gateway. */
export interface CompletionContext {
  readonly store: Store;
  readonly cloud: DisclosedCloud;
  /** The usable wallet, or null when none is linked or it cannot be opened. */
  readonly wallet: WalletAdapter | null;
  /** The rail's name for the merchant at this storefront origin (Shop: its myshopify domain), or null when unknown. */
  readonly storeFor: (merchantOrigin: string) => string | null;
  /** Whether the policy, met with Intent Cloud's baseline, allows one_tap. */
  readonly oneTapAllowed: boolean;
  /** The policy's per-order cap in cents, or null when it sets none. */
  readonly perOrderCapMinor: number | null;
  /** The approval's completer key: every Intent Cloud call of the completion is signed with it (R1). */
  readonly signer: Session | undefined;
  readonly keys: KeySet;
  readonly now: () => number;
  /** Test seams: random report ids, idempotency keys and owner tokens; a step hook that may throw (a crash). */
  readonly newReportId?: () => string;
  readonly newKey?: () => string;
  readonly newOwner?: () => string;
  readonly hook?: (step: CompletionStep) => void | Promise<void>;
}

/** The points a test can stop the machine at, as a crash would: each is after the named entry is chained. */
export type CompletionStep = "completion" | "completing_reported" | "attempt" | "complete_answered";

export interface CompletionInput {
  readonly handle: string;
  /** The chained `approval_pending` entry (step 7's `sent` is re-checked from it). */
  readonly pending: Entry;
  /** The chained, verified approval proof. */
  readonly proof: ApprovalProof;
}

/** Where the completion stands, for the tool result: never more than the gateway's own evidence. */
export interface CompletionView {
  readonly state: "completing" | "indeterminate" | "ordered" | "mismatch" | "failed";
  readonly source?: "shop_api" | "gateway_precheck";
  readonly reason?: string;
  readonly order_ref?: string;
  readonly final_total_minor?: number;
  /** Title differences and similar notes that do not change the result. */
  readonly advisory?: readonly string[];
}

type Body = Record<string, unknown>;
const asBody = (value: unknown): Body => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Body) : {});
const TERMINAL = new Set(["ordered", "mismatch", "failed"]);
const REPORT_PATH = (handle: string): string => `/v1/approvals/${handle}/outcome-reports`;
const COMPLETE = "complete_checkout";
/** The whole run is bounded (plan D2): a slow wallet answer ends the call in a wait state, resumed on the next one. */
export const COMPLETION_BUDGET_MS = 20_000;

/** `or_` + 22 base64url characters: 132 bits from the CSPRNG (Appendix G R4). */
export function newReportId(): string {
  return `or_${randomBytes(17).toString("base64url").slice(0, 22)}`;
}

/** The `completion` entry for a handle (the first: there is only ever one, compare-and-append). */
function completionOf(entries: readonly Entry[], handle: string): Body | null {
  const found = entries.find((e) => e.kind === "completion" && asBody(e.body).handle === handle);
  return found === undefined ? null : asBody(found.body);
}

const attemptsOf = (entries: readonly ChainEntry[], handle: string): Body[] =>
  entries.filter((e) => e.kind === "complete_attempt" && asBody(e.body).handle === handle).map((e) => asBody(e.body));

/** Whether a complete_checkout disclosure for this purchase (its local `purchase` field) is logged: the send's own uniqueness. */
function completeLogged(entries: readonly ChainEntry[], handle: string): boolean {
  return entries.some((e) => e.kind === "disclosure" && asBody(e.body).purchase === handle && asBody(e.body).endpoint === COMPLETE);
}

/**
 * Whether this purchase may have been sent to the wallet, fail closed as outcome's chargedNothing and `intent verify`:
 * any complete_checkout logged after its approval, whichever purchase it names, means it is not provably unsent.
 */
export function maybeSent(entries: readonly ChainEntry[], handle: string): boolean {
  const approvedAt = entries.findIndex((e) => e.kind === "approval" && asBody(e.body).handle === handle);
  return entries.some((e, i) => i > approvedAt && e.kind === "disclosure" && asBody(e.body).endpoint === COMPLETE);
}

const localOutcomes = (entries: readonly ChainEntry[], handle: string): LocalOutcomeEntry[] =>
  outcomesFor(entries, handle).filter((o): o is LocalOutcomeEntry => o.basis === "local");

/** One logged outcome report of this purchase: its body as sent, and the answer its receipt verified (null: none yet). */
interface LoggedReport {
  readonly seq: number;
  readonly report: Body;
  readonly status: number | null;
}

function reportsOf(entries: readonly Entry[], handle: string): LoggedReport[] {
  const statusBySeq = new Map<number, number>();
  for (const e of entries) {
    const b = asBody(e.body);
    if (e.kind === "receipt" && b.verified === true && typeof b.disclosure_seq === "number" && typeof b.status === "number") statusBySeq.set(b.disclosure_seq, b.status);
  }
  const found: LoggedReport[] = [];
  for (const e of entries) {
    const b = asBody(e.body);
    if (e.kind !== "disclosure" || b.endpoint !== "reportOutcome" || b.path !== REPORT_PATH(handle) || typeof b.body_b64 !== "string") continue;
    let report: Body;
    try {
      report = asBody(JSON.parse(Buffer.from(b.body_b64, "base64").toString("utf8")));
    } catch {
      continue;
    }
    found.push({ seq: e.seq, report, status: statusBySeq.get(e.seq) ?? null });
  }
  return found;
}

/** A report with this id that Intent Cloud accepted (201, receipt verified); or refused with a 4xx; or neither yet. */
function reportFate(reports: readonly LoggedReport[], reportId: unknown): "accepted" | "refused" | "open" {
  const mine = reports.filter((r) => r.report.report_id === reportId);
  if (mine.some((r) => r.status === 201)) return "accepted";
  if (mine.some((r) => r.status !== null && r.status >= 400 && r.status < 500)) return "refused";
  return "open";
}

const timestamp = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

/** The observed order binding-v1 reads from a wallet checkout, as the chain may hold it (the checkout ref as its hash). */
function observedOf(checkout: WalletCheckout, zip: string): Body {
  return {
    ...(checkout.merchantOrigin === null ? {} : { merchant_origin: checkout.merchantOrigin }),
    checkout_ref_hash: checkout.checkoutRef,
    lines: checkout.lines.map((l) => ({ variant_ref: l.variantRef, quantity: l.quantity })),
    // The ZIP never crosses the wallet port: a match is the snapshot's own ZIP, a difference an empty string.
    ...(checkout.shipTo === "unknown" ? {} : { ship_to_postal_code: checkout.shipTo === "match" ? zip : "" }),
    ...(checkout.total === null ? {} : { final_total: { amount_minor: checkout.total.amountMinor, currency: checkout.total.currency } }),
  };
}

function bind(snapshot: SnapshotV2, checkout: WalletCheckout, recordedRef: string): { observed: Body; context: Body; verdict: Binding } {
  const observed = observedOf(checkout, snapshot.ship_to.postal_code);
  const context = { mode: "shop_agent", recorded_checkout_ref_hash: recordedRef, ship_to_optional: shipToOptional("shop_api") };
  return { observed, context, verdict: bindingV1(snapshot, observed, { ...context, mode: "shop_agent" }) };
}

/** The completer precheck's verdict on checks 1, 3, 4 and 5: the first that is not `match`, or null. */
function precheckProblem(binding: Binding): string | null {
  const checks = binding.checks;
  for (const name of ["total", "line", "merchant_origin", "ship_to"] as const) {
    if (checks[name] !== "match" && !(name === "ship_to" && checks.ship_to === "unknown" && shipToOptional("shop_api"))) return `precheck:${name}`;
  }
  return null;
}

/** Case- and space-folded containment either way: a title that fails it is advisory only. */
function titleDiffers(snapshot: SnapshotV2, checkout: WalletCheckout): boolean {
  const fold = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();
  const want = fold(snapshot.item.title);
  return checkout.lines.some((l) => {
    const got = fold(l.title);
    return got !== "" && !got.includes(want) && !want.includes(got);
  });
}

/**
 * Advances one `shop_agent` purchase as far as it can go now, and says where it stands. Never throws for a wallet or
 * Intent Cloud failure (those are states); a store failure or a test hook's error propagates.
 */
export async function advanceCompletion(ctx: CompletionContext, input: CompletionInput): Promise<CompletionView> {
  const { store, now } = ctx;
  const { handle, proof } = input;
  const snapshot: SnapshotV2 = proof.snapshot;
  const expiresAt = Date.parse(snapshot.expires_at);
  const totalMinor = snapshot.total.amount_minor;
  const zip = snapshot.ship_to.postal_code;
  const deadline = now() + COMPLETION_BUDGET_MS;

  /** Chains a local outcome (once per state in a row), optionally only unless `conflict` holds. */
  async function local(
    body: Omit<LocalOutcomeEntry, "handle" | "basis" | "state_shown">,
    conflict?: (entries: readonly Entry[]) => boolean,
  ): Promise<boolean> {
    const latest = localOutcomes(store.entries(), handle).at(-1);
    if (latest?.state === body.state) return true;
    const entry = { handle, basis: "local", ...body, state_shown: body.state };
    try {
      if (conflict === undefined) await store.append("outcome", entry);
      else await store.appendUnless("outcome", entry, conflict);
      return true;
    } catch (error) {
      if (error instanceof StoreConflictError) return false;
      throw error;
    }
  }

  const view = (o: LocalOutcomeEntry, advisory: readonly string[] = []): CompletionView => ({
    state: o.state as CompletionView["state"],
    source: o.source,
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    ...(o.order_ref === undefined ? {} : { order_ref: o.order_ref }),
    ...(o.final_total_minor === undefined ? {} : { final_total_minor: o.final_total_minor }),
    ...(advisory.length === 0 ? {} : { advisory }),
  });

  /** Sends one report; the answer is in the chain (receipt) for later calls to read. False when it was not accepted. */
  async function send(report: Body): Promise<boolean> {
    try {
      const result = await ctx.cloud.reportOutcome(handle, report as OutcomeReport, ctx.signer);
      return result.ok && result.status === 201 && asBody(result.body).accepted === true;
    } catch {
      // A refusal before the send, no answer, or a discarded answer: retried on a later call.
      return false;
    }
  }

  /**
   * Step 8: reports the latest local outcome after an accepted `completing`, once accepted; an earlier attempt that
   * got no answer is resent byte for byte (R2). A refusal (4xx) is not resent.
   */
  async function reportLatest(completion: Body): Promise<void> {
    const entries = store.entries();
    const latest = localOutcomes(entries, handle).at(-1);
    if (latest === undefined || latest.state === "completing") return;
    const reports = reportsOf(entries, handle);
    if (reportFate(reports, completion.report_id) !== "accepted") return;
    const same = reports.filter((r) => r.report.state === latest.state && r.report.completing_report_id === completion.report_id);
    if (same.some((r) => r.status !== null && r.status >= 200 && r.status < 500)) return;
    // Once a terminal state was accepted no other report may follow (R4).
    if (reports.some((r) => r.status === 201 && TERMINAL.has(String(r.report.state)))) return;
    const first = same[0];
    if (first !== undefined) {
      await send(first.report);
      return;
    }
    const body: Body = {
      report_id: (ctx.newReportId ?? newReportId)(),
      completing_report_id: completion.report_id,
      state: latest.state,
      source: latest.source,
      ...(latest.state === "ordered" || latest.state === "mismatch"
        ? {
            ...(latest.order_ref === undefined ? {} : { order_ref: latest.order_ref }),
            ...(latest.final_total_minor === undefined ? {} : { final_total: { amount_minor: latest.final_total_minor, currency: "USD" } }),
            ...(latest.local_binding === undefined ? {} : { binding: latest.local_binding }),
          }
        : {}),
      observed_at: timestamp(now()),
    };
    await send(body);
  }

  /** Steps 6c and 7: what a wallet checkout read says, chained as a local outcome; null for a wait (buyer review). */
  async function settle(checkout: WalletCheckout, completion: Body): Promise<LocalOutcomeEntry | null> {
    const recorded = String(completion.checkout_ref);
    if (checkout.status === "completed" && checkout.orderRef !== null) {
      const { observed, context, verdict: binding } = bind(snapshot, checkout, recorded);
      if (binding.result !== "incomplete") {
        await local({
          state: binding.result === "ok" ? "ordered" : "mismatch",
          source: "shop_api",
          order_ref: checkout.orderRef,
          ...(checkout.total === null ? {} : { final_total_minor: checkout.total.amountMinor }),
          binding_inputs: { observed, context },
          local_binding: binding,
        });
        return localOutcomes(store.entries(), handle).at(-1) ?? null;
      }
    } else if (checkout.status === "failed") {
      await local({ state: "failed", source: "shop_api", reason: "checkout_not_completed" });
      return localOutcomes(store.entries(), handle).at(-1) ?? null;
    } else if (checkout.status === "buyer_review" && now() < expiresAt) {
      return null;
    }
    await local({ state: "indeterminate", source: "shop_api", reason: checkout.status === "buyer_review" ? "buyer_review_expired" : checkout.status });
    return localOutcomes(store.entries(), handle).at(-1) ?? null;
  }

  async function finish(completion: Body | null, advisory: readonly string[] = []): Promise<CompletionView> {
    if (completion !== null) await reportLatest(completion);
    const latest = localOutcomes(store.entries(), handle).at(-1);
    if (latest !== undefined && TERMINAL.has(latest.state) && completion !== null && ctx.wallet !== null) {
      await ctx.wallet.release({ storeDomain: String(completion.store), checkoutRef: String(completion.checkout_ref) }).catch(() => undefined);
    }
    return latest === undefined ? { state: "completing", ...(advisory.length === 0 ? {} : { advisory }) } : view(latest, advisory);
  }

  let entries = store.entries();
  let completion = completionOf(entries, handle);
  const terminal = localOutcomes(entries, handle).at(-1);
  // A terminal outcome (a local refusal before redemption included): nothing more happens but reporting it.
  if (terminal !== undefined && TERMINAL.has(terminal.state)) return finish(completion);

  // ---- Steps 1 to 4: before the purchase is redeemed ------------------------------------------------------------
  const advisory: string[] = [];
  if (completion === null) {
    const refuse = async (reason: string, source: "gateway_precheck" | "shop_api" = "gateway_precheck", extra: Partial<LocalOutcomeEntry> = {}) => {
      await local({ state: "failed", source, reason, ...extra });
      return finish(null);
    };
    if (!ctx.oneTapAllowed) return refuse("policy");
    if (ctx.wallet === null) return refuse("no_wallet");
    if (!(now() < expiresAt)) return refuse("expired");
    const wallet = ctx.wallet;
    let budget;
    try {
      budget = (await wallet.account()).budgetRemaining;
    } catch {
      return finish(null); // nothing chained: the next call tries again
    }
    const caps = [ctx.perOrderCapMinor, budget === null ? null : budget.currency === "USD" ? budget.amountMinor : 0].filter((c): c is number => c !== null);
    if (caps.length > 0 && totalMinor > Math.min(...caps)) return refuse("budget");
    const storeDomain = ctx.storeFor(snapshot.merchant_origin);
    if (storeDomain === null) return refuse("store_unknown");
    let quote: WalletCheckout;
    try {
      quote = await wallet.createCheckout({ purchase: handle, storeDomain, lines: [{ variantRef: snapshot.variant_ref, quantity: snapshot.quantity }], shipToPostalCode: zip });
    } catch (error) {
      if (error instanceof AddressFieldsRequiredError) return refuse("address_fields");
      if (error instanceof WalletRailError && error.httpStatus === 200) return refuse("ineligible", "shop_api");
      return finish(null); // no answer: nothing was completed, and the next call tries again
    }
    const { observed, context, verdict: binding } = bind(snapshot, quote, quote.checkoutRef);
    if (titleDiffers(snapshot, quote)) advisory.push("title_differs");
    const problem = precheckProblem(binding);
    if (problem !== null) return refuse(problem, "gateway_precheck", { binding_inputs: { observed, context }, local_binding: binding });
    const body = {
      handle,
      checkout_ref: quote.checkoutRef,
      store: quote.storeDomain,
      report_id: (ctx.newReportId ?? newReportId)(),
      idempotency_key: (ctx.newKey ?? randomUUID)(),
      total_minor: totalMinor,
      observed_at: timestamp(now()),
    };
    try {
      await store.appendUnless("completion", body, (chain) => completionOf(chain, handle) !== null);
    } catch (error) {
      // Another process redeemed this purchase first: it owns it.
      if (error instanceof StoreConflictError) return { state: "completing", ...(advisory.length === 0 ? {} : { advisory }) };
      throw error;
    }
    await ctx.hook?.("completion");
    entries = store.entries();
    completion = completionOf(entries, handle);
    if (completion === null) throw new Error("the completion entry is missing right after its append");
  }

  // ---- Step 5: report completing ----------------------------------------------------------------------------------
  const completing: Body = {
    report_id: completion.report_id,
    state: "completing",
    source: "shop_api",
    checkout_ref_hash: completion.checkout_ref,
    observed_at: completion.observed_at,
  };
  let fate = reportFate(reportsOf(entries, handle), completion.report_id);
  if (fate === "open") {
    await send(completing);
    fate = reportFate(reportsOf(store.entries(), handle), completion.report_id);
    if (fate === "accepted") await ctx.hook?.("completing_reported");
  }
  if (fate !== "accepted") {
    const attempted = attemptsOf(store.entries(), handle).length > 0;
    // Refused before acceptance: a local outcome only (Appendix G precheck step 3), and nothing was sent to the wallet.
    if (fate === "refused" && !attempted) {
      await local({ state: "failed", source: "gateway_precheck", reason: "redeem_refused" });
      return finish(completion);
    }
    if (!attempted && !(now() < expiresAt)) {
      await local({ state: "failed", source: "gateway_precheck", reason: "expired" });
      return finish(completion);
    }
    return finish(completion, advisory);
  }

  // ---- Step 6: complete ---------------------------------------------------------------------------------------------
  const locator = { storeDomain: String(completion.store), checkoutRef: String(completion.checkout_ref) };
  if (attemptsOf(store.entries(), handle).length === 0) {
    // No usable wallet right now: wait (no attempt is claimed), until the snapshot expires.
    if (ctx.wallet === null && now() < expiresAt) return finish(completion, advisory);
    if (!(now() < expiresAt)) {
      await local({ state: "failed", source: "gateway_precheck", reason: "expired" });
      return finish(completion);
    }
    const owner = (ctx.newOwner ?? (() => randomBytes(16).toString("base64url")))();
    let mine = true;
    try {
      await store.appendUnless("complete_attempt", { handle, owner, idempotency_key: completion.idempotency_key }, (chain) => attemptsOf(chain, handle).length > 0);
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      mine = false;
    }
    if (mine) {
      await ctx.hook?.("attempt");
      const result = await completeOnce(owner, completion, locator);
      if (result !== "reconcile") return finish(completion, advisory);
    }
  }

  // ---- Step 7: reconcile ---------------------------------------------------------------------------------------------
  if (!maybeSent(store.entries(), handle)) {
    // No disclosure: log-before-send proves complete_checkout was never sent. The outcome is compare-and-appended
    // against a disclosure, so a live owner's send and this verdict exclude each other.
    const chained = await local({ state: "failed", source: "gateway_precheck", reason: "not_sent" }, (chain) => maybeSent(chain, handle));
    if (chained) return finish(completion, advisory);
  }
  if (ctx.wallet === null) {
    await local({ state: "indeterminate", source: "shop_api", reason: "no_wallet" });
    return finish(completion, advisory);
  }
  if (now() >= deadline) return finish(completion, advisory);
  let read: WalletCheckout | null;
  try {
    read = await ctx.wallet.getCheckout(locator, handle, zip);
  } catch {
    read = null;
  }
  if (read === null) await local({ state: "indeterminate", source: "shop_api", reason: "read_failed" });
  else await settle(read, completion);
  return finish(completion, advisory);

  /**
   * Step 6b: the completer precheck on a fresh read, then complete_checkout, sent only while this process owns the
   * attempt, no complete_checkout is logged and no outcome is chained (compare-and-append on the disclosure).
   */
  async function completeOnce(owner: string, done: Body, at: { storeDomain: string; checkoutRef: string }): Promise<"settled" | "reconcile"> {
    const wallet = ctx.wallet;
    if (wallet === null) return "reconcile";
    const recheck = (fresh: WalletCheckout): string | null => {
      if (fresh.checkoutRef !== done.checkout_ref) return "checkout_ref";
      const problem = precheckProblem(bind(snapshot, fresh, fresh.checkoutRef).verdict);
      if (problem !== null) return problem;
      if (!(now() < expiresAt)) return "expired";
      // Appendix E again, step 7 included, against the chain without this approval's own entry (not a replay).
      const chain = store.entries().filter((e) => !(e.kind === "approval" && asBody(e.body).handle === handle));
      const again = verifyApprovalProof({ state: "approved", proof }, input.pending, ctx.keys, chain, new Date(now()));
      return again.ok ? null : "proof";
    };
    const sendUnless = (chain: readonly ChainEntry[]): boolean => {
      const attempts = attemptsOf(chain, handle);
      return attempts.length !== 1 || attempts[0]?.owner !== owner || completeLogged(chain, handle) || localOutcomes(chain, handle).length > 0;
    };
    let answer: WalletCheckout;
    try {
      answer = await wallet.completeCheckout(at, handle, String(done.idempotency_key), { shipToPostalCode: zip, precheck: recheck, sendUnless });
    } catch (error) {
      if (error instanceof CompletionRefusedError || error instanceof AddressFieldsRequiredError) {
        const reason = error instanceof CompletionRefusedError ? error.reason : "address_fields";
        const chained = await local({ state: "failed", source: "gateway_precheck", reason }, (chain) => completeLogged(chain, handle));
        return chained ? "settled" : "reconcile";
      }
      if (error instanceof DisclosureConflictError) return "reconcile";
      // Logged and maybe sent, with no usable answer: indeterminate, never re-sent. Not logged: never sent.
      if (completeLogged(store.entries(), handle)) {
        await local({ state: "indeterminate", source: "shop_api", reason: "no_answer" });
        return "settled";
      }
      return "reconcile";
    }
    await ctx.hook?.("complete_answered");
    await settle(answer, done);
    return "settled";
  }
}
