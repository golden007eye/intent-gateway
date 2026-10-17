// What each view of the panel shows, computed from the chain items `readChain` returns, the active policy and the
// last verify result. Pure; no I/O. Correlation (which entries make one action, one purchase) comes from the shared
// activity model; this file only words it. Wording follows `intent log` and invariant 5: what the gateway sent and
// what came back (a receipt: Intent Cloud acknowledged receiving it), never what Intent Cloud does next.
import { type Activity, type ActivityRequest, buildActivity, buildPurchases, type Delivery, leafFields, type Purchase } from "../activity/index.ts";
import { withheldAt } from "../observation/index.ts";
import { EXCLUDED_CATEGORIES, type Policy } from "../policy/index.ts";
import type { ChainResult } from "../store/index.ts";

export type Mode = "demo" | "real";
export type Tone = "ok" | "warn" | "bad" | "plain";

export interface PolicyInfo {
  readonly policy: Policy;
  /** Where it came from: the policy file's path, or "the bundled <name> policy (…)". */
  readonly source: string;
}

/** The parts of an `intent verify` report the panel shows (verify's Report has this shape). */
export interface VerifyResult {
  readonly ok: boolean;
  readonly head: { readonly seq: number; readonly hash: string };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly details: readonly string[] }[];
}

export interface ModelInput {
  readonly items: readonly unknown[];
  /** Milliseconds since the epoch. */
  readonly now: number;
  /** From the CLI: `panel --demo` reads the demo chain. */
  readonly mode: Mode;
  /** The command that runs this gateway, so the page's hints paste as is. */
  readonly intent: string;
  /** The active policy; null when it could not be read (`policyError` says why). */
  readonly policy: PolicyInfo | null;
  readonly policyError?: string;
  /** The verify result for this chain; null when none was run. */
  readonly verify: VerifyResult | null;
  /** For tests: the zone times are shown in (the local zone when absent). */
  readonly timeZone?: string;
}

export interface Line {
  readonly seq: number;
  /** ISO time, for `<time datetime>`. */
  readonly ts: string;
  /** Local time, HH:MM (with the date when not today). */
  readonly clock: string;
  readonly label: string;
  readonly tone: Tone;
  readonly text: string;
}

export interface Kpis {
  /** Approved in the last 24 hours, the window the daily limit counts. */
  readonly approvedMinor: number;
  readonly dailyLimitMinor: number | null;
  readonly waiting: number;
  /** The oldest approval still waiting. */
  readonly nextWaiting: { readonly text: string; readonly url: string | null } | null;
  readonly sent: number;
  readonly acknowledged: number;
  readonly unacknowledged: number;
  readonly maybeSent: number;
  readonly notSent: number;
  readonly discarded: number;
  readonly refusedBefore: number;
  readonly refusedNote: string;
}

export type StepState = "done" | "waiting" | "failed" | "todo";

export interface Step {
  readonly n: number;
  readonly name: string;
  readonly state: StepState;
  readonly note: string;
  /** The drawer that shows this step's requests, when it has any. */
  readonly drawer: string | null;
  /** The approval page, on a waiting approval step. */
  readonly link: string | null;
}

export interface PurchaseView {
  readonly id: string;
  readonly seq: number;
  readonly ts: string;
  readonly clock: string;
  readonly title: string;
  readonly subtitle: string;
  readonly state: string;
  readonly tone: Tone;
  readonly steps: readonly Step[];
}

export interface RequestDetail {
  readonly seq: number;
  readonly endpoint: string;
  readonly method: string;
  /** The values sent, field by field; for a request with no logged bytes, the field names with "(not logged)". */
  readonly sent: readonly (readonly [string, string])[];
  readonly back: readonly (readonly [string, string])[];
  readonly delivery: string;
  readonly tone: Tone;
  readonly digest: string | null;
}

export interface Drawer {
  /** `a-<seq>`; the drawer's address is `#/purchases/a-<seq>`. */
  readonly id: string;
  readonly heading: string;
  readonly requests: readonly RequestDetail[];
  /** Facts that are not requests (an approval's handle and passkey). */
  readonly facts: readonly (readonly [string, string])[];
  readonly seqs: string;
}

export interface Pending {
  readonly seq: number;
  readonly handle: string;
  readonly total: string;
  readonly url: string | null;
  readonly expires: string;
  readonly expired: boolean;
  readonly clock: string;
  readonly ts: string;
}

export interface Approved {
  readonly seq: number;
  readonly handle: string;
  readonly total: string;
  readonly fingerprint: string;
  readonly pinned: boolean;
  readonly clock: string;
  readonly ts: string;
}

export interface LogRow {
  readonly seq: number;
  readonly ts: string;
  readonly clock: string;
  readonly kind: string;
  /** One line, as in the overview's server log strip. */
  readonly summary: string;
  readonly tone: Tone;
  readonly fields: readonly (readonly [string, string])[];
  readonly hash: string;
  readonly prev: string;
}

export interface PanelModel {
  readonly mode: Mode;
  readonly intent: string;
  readonly entries: number;
  readonly chain: ChainResult;
  readonly head: { readonly seq: number; readonly hash: string } | null;
  readonly updated: string;
  readonly kpis: Kpis;
  readonly feed: readonly Line[];
  readonly purchases: readonly PurchaseView[];
  readonly drawers: readonly Drawer[];
  readonly refusals: readonly Line[];
  readonly pending: readonly Pending[];
  readonly approved: readonly Approved[];
  readonly pin: { readonly fingerprint: string; readonly seq: number; readonly clock: string } | null;
  readonly flags: readonly Line[];
  readonly policy: { readonly source: string; readonly rules: readonly (readonly [string, string])[]; readonly summary: readonly string[] } | null;
  readonly policyError: string | null;
  readonly log: readonly LogRow[];
  readonly logKinds: readonly string[];
  readonly verify: VerifyResult | null;
  readonly verifyCommand: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What became of a request, in `intent verify`'s categories, in the words `intent log` uses (never "sent" for one that never left). */
const DELIVERY: Record<Delivery, readonly [short: string, long: string, tone: Tone]> = {
  acknowledged: ["receipt ✓", "Intent Cloud acknowledged receiving it (signed receipt)", "ok"],
  unacknowledged: ["no receipt", "left the gateway; no receipt came back", "warn"],
  not_sent: ["not sent", "logged, not sent: no connection was made", "plain"],
  maybe_sent: ["maybe sent", "logged, maybe sent; no answer recorded", "warn"],
  discarded: ["discarded", "a response came back without a valid receipt and was not used", "bad"],
};

export function buildModel(input: ModelInput): PanelModel {
  const { items, now } = input;
  const { activities, summary } = buildActivity(items);
  const purchases = buildPurchases(activities, now);
  const time = clockFor(now, input.timeZone);
  const last = record(items.at(-1));
  const head = typeof last.seq === "number" && typeof last.hash === "string" ? { seq: last.seq, hash: last.hash } : null;

  const waiting = purchases.filter((p) => p.state === "waiting");
  const blocked = activities.filter((a) => a.action === "blocked");
  const approvals = activities.filter((a) => a.action === "approval");
  const approvedMinor = approvals
    .filter((a) => now - Date.parse(a.time) < DAY_MS && now >= Date.parse(a.time))
    .reduce((sum, a) => sum + (a.facts.total_minor ?? 0), 0);
  const perDay = input.policy?.policy.spend.per_day_usd;
  const firstWaiting = waiting[0];
  const r = summary.requests;
  const kpis: Kpis = {
    approvedMinor,
    dailyLimitMinor: perDay === undefined ? null : perDay * 100,
    waiting: waiting.length,
    nextWaiting:
      firstWaiting === undefined
        ? null
        : { text: `${purchaseTitle(firstWaiting)} · open approval page`, url: safeUrl(firstWaiting.cart.facts.approval_url) },
    sent: r.sent,
    acknowledged: r.acknowledged,
    unacknowledged: r.unacknowledged,
    maybeSent: r.maybe_sent,
    notSent: r.not_sent,
    discarded: r.discarded,
    refusedBefore: blocked.length,
    refusedNote: blocked.length === 0 ? "nothing refused" : `last: ${refusalWords(blocked.at(-1)?.blocked ?? [], blocked.at(-1)?.facts.held)}, nothing sent`,
  };

  const lines = activities.filter((a) => a.action !== "keys").map((a) => feedLine(a, time));
  const drawers = purchases.flatMap((p) => [p.search, p.cart, p.checks.at(-1) ?? null, p.approval]).filter((a): a is Activity => a !== null);
  const pin = [...items].reverse().map(record).find((e) => e.kind === "approver_pin");
  const currentPin = pin === undefined ? null : text(record(pin.body).fingerprint);

  return {
    mode: input.mode,
    intent: input.intent,
    entries: items.length,
    chain: summary.chain,
    head,
    updated: time(new Date(now).toISOString(), true),
    kpis,
    feed: lines.reverse(),
    purchases: purchases.map((p) => purchaseView(p, time)).reverse(),
    drawers: [...new Map(drawers.map((a) => [a.seq, drawerOf(a, time)])).values()],
    refusals: activities.filter((a) => a.action === "blocked" || (a.outcome === "refused" && a.action !== "cart")).map((a) => feedLine(a, time)).reverse(),
    pending: purchases
      .filter((p) => p.state === "waiting" || p.state === "expired")
      .map((p) => ({
        seq: p.seq,
        handle: p.cart.facts.approval_handle ?? "",
        total: money(p.cart.facts.total_minor),
        url: safeUrl(p.cart.facts.approval_url),
        expires: p.cart.facts.expires_at === undefined ? "" : time(p.cart.facts.expires_at, true),
        expired: p.state === "expired",
        clock: time(p.cart.time),
        ts: p.cart.time,
      }))
      .reverse(),
    approved: approvals
      .map((a) => ({
        seq: a.seq,
        handle: a.facts.approval_handle ?? "",
        total: money(a.facts.total_minor),
        fingerprint: a.facts.fingerprint ?? "",
        pinned: a.facts.pinned === true,
        clock: time(a.time),
        ts: a.time,
      }))
      .reverse(),
    pin: pin === undefined ? null : { fingerprint: currentPin ?? "", seq: Number(pin.seq), clock: time(text(pin.ts)) },
    flags: activities.filter((a) => a.action === "flagged" && a.facts.fingerprint !== currentPin).map((a) => feedLine(a, time)),
    policy: input.policy === null ? null : policyView(input.policy),
    policyError: input.policy === null ? (input.policyError ?? "the active policy could not be read") : null,
    log: items.map((item, index) => logRow(item, index, time)),
    logKinds: [...new Set(items.map((i) => text(record(i).kind) || "unreadable"))].sort(),
    verify: input.verify,
    verifyCommand: `${input.intent} verify${input.mode === "demo" ? " --demo" : ""}`,
  };
}

// ---- wording ------------------------------------------------------------------------------------------------------

function feedLine(a: Activity, time: Clock): Line {
  const f = a.facts;
  const base = { seq: a.seq, ts: a.time, clock: a.time === "" ? "" : time(a.time) };
  const delivery = (): string => worstShort(a.requests);
  switch (a.action) {
    case "start":
      return { ...base, label: "start", tone: "plain", text: join(["Gateway started", f.key_kid === undefined ? "" : `key statement ${f.key_kid}`, a.requests.length === 0 ? "" : delivery()]) };
    case "keys":
      return { ...base, label: "keys", tone: "plain", text: join(["Key statement read", f.key_kid ?? "", delivery()]) };
    case "search":
      return { ...base, label: "search", tone: toneOf(a.requests), text: join(["Search", searchWords(a), offersWords(a), delivery()]) };
    case "blocked":
      // With the value the policy held back (chains with `held`): `Search refused: category "alcohol" excluded`.
      return {
        ...base,
        label: "refused",
        tone: "bad",
        text: join([`${endpointWords(f.endpoint)} refused${f.held === undefined ? " before sending" : ""}: ${refusalWords(a.blocked, f.held)}`, "nothing sent"]),
      };
    case "cart":
      return {
        ...base,
        label: a.outcome === "refused" ? "refused" : "cart",
        tone: a.outcome === "refused" ? "bad" : toneOf(a.requests),
        text: join(["Cart", cartWords(a), a.outcome === "refused" ? `refused what came back: ${a.blocked.join("; ")}` : delivery(), a.outcome === "approval_asked" ? "approval asked" : ""]),
      };
    case "status": {
      const ended = a.outcome === "rejected" || a.outcome === "expired";
      return {
        ...base,
        label: ended ? a.outcome : "status",
        tone: a.outcome === "refused" || a.outcome === "rejected" ? "bad" : toneOf(a.requests),
        text: join(["Approval status checked", short(f.approval_handle), f.title ?? "", f.approval_state === undefined ? "" : f.approval_state.replace("_", " "), delivery()]),
      };
    }
    case "approval":
      return {
        ...base,
        label: "approved",
        tone: "ok",
        text: join(["Approved", money(f.total_minor), f.fingerprint === undefined ? "" : `passkey ${fingerprintShort(f.fingerprint)} ✓`, f.pinned === true ? "pinned as your approver" : ""]),
      };
    case "pin":
      return { ...base, label: "pin", tone: "plain", text: `Approver pinned: passkey ${f.fingerprint ?? ""}` };
    case "flagged":
      return { ...base, label: "flagged", tone: "bad", text: join([`Passkey ${f.fingerprint ?? ""} flagged`, f.flag_reason === "sign_count" ? "its signature counter went back" : "it is not your pinned approver"]) };
    case "wallet":
      return { ...base, label: "wallet", tone: "plain", text: join([`Wallet ${f.wallet_rail ?? ""} ${f.wallet_action ?? ""}`, f.revoked === true ? "token revoked" : f.revoked === false ? "token not revoked" : ""]) };
    case "unreadable":
      return { ...base, label: "unreadable", tone: "bad", text: `Line ${String(f.line ?? "?")} is not an entry (a torn or edited line)` };
  }
}

function searchWords(a: Activity): string {
  const f = a.facts;
  return join([
    f.product ?? f.category ?? "",
    f.must_haves === undefined || f.must_haves.length === 0 ? "" : f.must_haves.join(", "),
    f.budget_minor === undefined ? "" : `under ${money(f.budget_minor)}`,
    f.zip === undefined ? "" : `ZIP ${f.zip}`,
  ]);
}

/** `3 offers`, `3 offers, 1 hidden by your policy`, from the search's observation; "" without one. */
function offersWords(a: Activity): string {
  const n = a.facts.offers_count;
  if (n === undefined || a.outcome !== "acknowledged") return "";
  const hidden = a.facts.offers_hidden ?? 0;
  return `${String(n)} offer${n === 1 ? "" : "s"}${hidden === 0 ? "" : `, ${String(hidden)} hidden by your policy`}`;
}

function cartWords(a: Activity, total = true): string {
  const f = a.facts;
  // With the cart's observation: what Intent Cloud returned (title, total, merchant); without one: the values sent.
  if (f.title !== undefined) {
    return join([`${f.title}${(f.quantity ?? 1) > 1 ? ` ×${String(f.quantity)}` : ""}`, total ? totalWords(a) : "", f.merchant ?? ""]);
  }
  return sentCartWords(a, total);
}

/** The values the cart request sent: `1 × offer of_8Kx2a…hij · ZIP 94103` (and the total, when asked). */
function sentCartWords(a: Activity, total = false): string {
  const f = a.facts;
  return join([
    f.quantity === undefined ? "" : `${String(f.quantity)} ×`,
    f.offer_handle === undefined ? "" : `offer ${short(f.offer_handle)}`,
    f.zip === undefined ? "" : `ZIP ${f.zip}`,
    f.total_minor === undefined || !total ? "" : money(f.total_minor),
  ]).replace(" × · ", " × ");
}

/** `Trail Socks 3-pack · $18.00 · Hydra Goods` from the cart's observation; on older chains, the search and the total. */
function purchaseTitle(p: Purchase): string {
  if (p.cart.facts.title !== undefined) return cartWords(p.cart);
  const what = p.search?.facts.product ?? p.search?.facts.category ?? "Purchase";
  return join([capitalise(what), totalWords(p.cart)]);
}

/** The action's total, `total withheld` when an observation withheld it as possible buyer identity (never a 0), or "". */
function totalWords(a: Activity): string {
  if (a.facts.total_minor !== undefined) return money(a.facts.total_minor);
  return a.facts.withheld?.includes("total_minor") === true ? "total withheld" : "";
}

const STATE: Record<Purchase["state"], readonly [string, Tone]> = {
  approved: ["Approved", "ok"],
  waiting: ["Waiting for you", "warn"],
  expired: ["Expired", "plain"],
  rejected: ["Rejected", "bad"],
  refused: ["Refused by the gateway", "bad"],
  acknowledged: ["No approval asked", "plain"],
  unacknowledged: ["No receipt", "warn"],
  not_sent: ["Not sent", "plain"],
  maybe_sent: ["Maybe sent", "warn"],
  discarded: ["Response discarded", "bad"],
};

function purchaseView(p: Purchase, time: Clock): PurchaseView {
  const [state, tone] = STATE[p.state];
  const cart = p.cart;
  const steps: Step[] = [];
  steps.push(
    p.search === null
      ? { n: 1, name: "Search", state: "todo", note: "none logged before this cart", drawer: null, link: null }
      : { n: 1, name: "Search", state: stepState(p.search), note: join([time(p.search.time), worstShort(p.search.requests)]), drawer: drawerId(p.search), link: null },
  );
  steps.push({
    n: 2,
    name: "Cart",
    state: cart.outcome === "refused" ? "failed" : stepState(cart),
    note: join([time(cart.time), cart.outcome === "refused" ? "refused what came back" : worstShort(cart.requests)]),
    drawer: drawerId(cart),
    link: null,
  });
  const approvalStep: Step =
    p.approval !== null
      ? { n: 3, name: "Your approval", state: "done", note: join([time(p.approval.time), `passkey ${fingerprintShort(p.approval.facts.fingerprint ?? "")} ✓`]), drawer: drawerId(p.approval), link: null }
      : p.state === "waiting"
        ? { n: 3, name: "Your approval", state: "waiting", note: "waiting for you", drawer: null, link: safeUrl(cart.facts.approval_url) }
        : p.state === "expired" || p.state === "rejected"
          ? // A rejection (or expiry) Intent Cloud returned is worded as its answer; a local expiry is the gateway's own.
            { n: 3, name: "Your approval", state: "failed", note: cart.facts.approval_state === p.state ? `Intent Cloud says ${p.state}` : p.state, drawer: null, link: null }
          : { n: 3, name: "Your approval", state: "todo", note: "not asked", drawer: null, link: null };
  steps.push(approvalStep);
  const lastCheck = p.checks.at(-1);
  steps.push(
    p.approval !== null
      ? { n: 4, name: "Agent checked", state: "done", note: join([time(p.approval.time), "verified and chained"]), drawer: lastCheck === undefined ? null : drawerId(lastCheck), link: null }
      : lastCheck !== undefined
        ? { n: 4, name: "Agent checks", state: p.state === "waiting" ? "waiting" : "todo", note: `checked ${String(p.checks.length)}×, not approved yet`, drawer: drawerId(lastCheck), link: null }
        : { n: 4, name: "Agent checks", state: "todo", note: "not yet", drawer: null, link: null },
  );
  return {
    id: `p-${String(p.seq)}`,
    seq: p.seq,
    ts: cart.time,
    clock: time(cart.time),
    title: purchaseTitle(p),
    subtitle: join([sentCartWords(cart), p.approval === null && cart.facts.approval_handle !== undefined ? `approval ${short(cart.facts.approval_handle)}` : ""]),
    state,
    tone,
    steps,
  };
}

function stepState(a: Activity): StepState {
  const worst = worstDelivery(a.requests);
  if (worst === "acknowledged") return "done";
  if (worst === "maybe_sent" || worst === "unacknowledged") return "waiting";
  return "failed";
}

const drawerId = (a: Activity): string => `a-${String(a.seq)}`;

function drawerOf(a: Activity, time: Clock): Drawer {
  const heading = a.action === "search" ? "Search" : a.action === "cart" ? "Cart" : a.action === "status" ? "Agent checked" : "Your approval";
  const seqs = a.seqs.length <= 1 ? `seq ${String(a.seq)}` : `seq ${String(a.seqs[0])}–${String(a.seqs.at(-1))}`;
  const facts: (readonly [string, string])[] =
    a.action === "approval"
      ? [
          ["approval", a.facts.approval_handle ?? ""],
          ["total", money(a.facts.total_minor)],
          ["passkey", a.facts.fingerprint ?? ""],
          ["time", time(a.time, true)],
          ["proof", "verified by the gateway and chained"],
        ]
      : [];
  return { id: drawerId(a), heading, requests: a.requests.map(requestDetail), facts, seqs };
}

function requestDetail(r: ActivityRequest): RequestDetail {
  const sent: [string, string][] =
    r.fields === null ? r.field_names.map((n) => [n, "(value not logged)"]) : Object.entries(r.fields).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
  const back: [string, string][] = [];
  const res = r.response;
  if (res !== null) {
    if (res.status !== null) back.push(["status", String(res.status)]);
    if (res.acknowledged) back.push(["receipt", `${res.receipt_kid ?? "signed"}${res.signature_checked ? " ✓" : ""}`]);
    if (res.reason !== null) back.push(["reason", res.reason]);
  }
  const [, long, tone] = DELIVERY[r.delivery];
  return { seq: r.seq, endpoint: r.endpoint, method: join([r.method ?? "", r.path ?? ""], " "), sent, back, delivery: long, tone, digest: r.content_digest };
}

function policyView(info: PolicyInfo): NonNullable<PanelModel["policy"]> {
  const p = info.policy;
  const usd = (v: number | undefined) => (v === undefined ? "no limit set" : `up to $${String(v)}`);
  const own = p.categories.block.filter((c) => !EXCLUDED_CATEGORIES.includes(c));
  const rules: [string, string][] = [
    ["Shares", p.share.ship_to === "postcode_only" ? "ZIP code only (US)" : "no ship-to: every search needs a ZIP from you"],
    ["Purchase history", "never shared"],
    ["Per order", usd(p.spend.per_order_usd)],
    ["Per day (24 h)", usd(p.spend.per_day_usd)],
    ["Per week (7 days)", usd(p.spend.per_week_usd)],
    ["Quantity", `at most ${String(p.quantity.max)} per cart`],
    ["Merchants", p.merchants.allow === undefined ? (p.merchants.block.length === 0 ? "any" : `any but ${p.merchants.block.join(", ")}`) : `only ${p.merchants.allow.join(", ")}`],
    ["Categories you block", own.length === 0 ? "none beyond the excluded ones" : own.join(", ")],
    ["Always excluded", EXCLUDED_CATEGORIES.join(", ")],
    ["Approval", "your passkey, on every purchase"],
  ];
  const summary = [
    p.share.ship_to === "postcode_only" ? "Shares: ZIP code only" : "Shares: no ship-to",
    `Per order: ${usd(p.spend.per_order_usd)}`,
    `Per day: ${usd(p.spend.per_day_usd)}`,
  ];
  return { source: info.source, rules, summary };
}

function logRow(item: unknown, index: number, time: Clock): LogRow {
  const e = record(item);
  if (typeof e.seq !== "number" || typeof e.ts !== "string" || typeof e.kind !== "string") {
    return { seq: index, ts: "", clock: "", kind: "unreadable", summary: `line ${String(index + 1)}: not an entry (a torn or edited line)`, tone: "bad", fields: [], hash: "", prev: "" };
  }
  const body = record(e.body);
  const fields: [string, string][] = [];
  flatten(e.body, "", fields);
  return {
    seq: e.seq,
    ts: e.ts,
    clock: time(e.ts, true),
    kind: e.kind,
    summary: entrySummary(e.kind, body),
    tone: e.kind === "block" || e.kind === "discarded" || e.kind === "approver_flag" ? "bad" : e.kind === "unacknowledged" ? "warn" : e.kind === "receipt" || e.kind === "approval" ? "ok" : "plain",
    fields,
    hash: text(e.hash),
    prev: text(e.prev),
  };
}

function entrySummary(kind: string, b: Record<string, unknown>): string {
  const names = (v: unknown) => leafFields(strings(v)).join(", ");
  switch (kind) {
    case "disclosure":
      return join([`logged ${text(b.endpoint)}`, names(b.fields) || "no body fields"], "  ");
    case "receipt":
      return join([`receipt for #${String(b.disclosure_seq)}`, typeof b.status === "number" ? `status ${String(b.status)}` : "", b.verified === true ? "signature checked" : ""]);
    case "unacknowledged":
    case "discarded":
      return join([`${kind} #${String(b.disclosure_seq)}`, text(b.reason)]);
    case "block":
      return join([`refused before sending ${text(b.endpoint)}`, strings(b.blocked).join("; "), ...Object.entries(record(b.held)).map(([k, v]) => `${k} ${JSON.stringify(v)} kept here only`)]);
    case "observed": {
      // What came back for one request, recorded here after its receipt; never sent.
      const what =
        b.endpoint === "searchCatalog"
          ? `${String(b.offers_count)} offers`
          : join([
              text(b.title),
              withheldAt(strings(b.withheld), "$.total_minor") ? "total withheld" : typeof b.total_minor === "number" ? money(b.total_minor) : "",
              text(b.merchant),
              text(b.state),
            ]);
      return join([`came back for #${String(b.disclosure_seq)}`, what]);
    }
    case "approval_pending":
      return join([`approval asked ${text(b.handle)}`, typeof b.total_minor === "number" ? money(b.total_minor) : ""]);
    case "approval":
      return `approval verified and chained ${text(b.handle)}`;
    case "approver_pin":
      return `approver pinned ${text(b.fingerprint)}`;
    case "approver_flag":
      return `passkey flagged ${text(b.fingerprint)}`;
    case "keys":
      return `key statement ${text(record(b.statement).kid)}`;
    case "session":
      return b.mode === "demo" ? "demo chain" : `session ${text(b.id)}`;
    default:
      return kind;
  }
}

/** A body as `path = value` rows, field by field; arrays of scalars stay one value. */
function flatten(value: unknown, prefix: string, out: [string, string][]): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix !== "") out.push([prefix, "{}"]);
    for (const [k, v] of entries) flatten(v, prefix === "" ? k : `${prefix}.${k}`, out);
  } else if (Array.isArray(value) && value.some((v) => typeof v === "object" && v !== null)) {
    value.forEach((v, i) => {
      flatten(v, `${prefix}[${String(i)}]`, out);
    });
  } else {
    out.push([prefix === "" ? "body" : prefix, typeof value === "string" ? value : JSON.stringify(value)]);
  }
}

/**
 * Policy rules and identity findings in plain words; the rule itself stays in the server log. `held`, the values a
 * policy block kept (never sent), names the category: `category "alcohol" excluded`.
 */
export function refusalWords(blocked: readonly string[], held?: Readonly<Record<string, unknown>>): string {
  const category = typeof held?.category === "string" ? held.category : null;
  const words = blocked.map((b) => {
    if (b.startsWith("categories.block")) return category === null ? "excluded or blocked category" : `category "${category}" excluded`;
    if (b.startsWith("spend.")) return "over a spend limit";
    if (b.startsWith("merchants.")) return "merchant not allowed";
    if (b.startsWith("quantity.")) return "over the quantity limit";
    if (b.startsWith("share.")) return "a field your policy does not share";
    if (/identity|name|address|card|email|phone/i.test(b)) return "buyer identity held back";
    return b;
  });
  return [...new Set(words)].join("; ") || "a policy rule";
}

function endpointWords(endpoint: string | undefined): string {
  if (endpoint === "searchCatalog") return "Search";
  if (endpoint === "createCart") return "Cart";
  if (endpoint === "getApproval") return "Status check";
  return endpoint === undefined || endpoint === "" ? "Request" : endpoint;
}

function worstDelivery(requests: readonly ActivityRequest[]): Delivery | null {
  const order: Delivery[] = ["acknowledged", "not_sent", "unacknowledged", "maybe_sent", "discarded"];
  let worst = -1;
  for (const r of requests) worst = Math.max(worst, order.indexOf(r.delivery));
  return order[worst] ?? null;
}

function worstShort(requests: readonly ActivityRequest[]): string {
  const worst = worstDelivery(requests);
  return worst === null ? "" : DELIVERY[worst][0];
}

function toneOf(requests: readonly ActivityRequest[]): Tone {
  const worst = worstDelivery(requests);
  return worst === null ? "plain" : worst === "acknowledged" ? "plain" : DELIVERY[worst][2];
}

// ---- formatting ---------------------------------------------------------------------------------------------------

type Clock = (iso: string, seconds?: boolean) => string;

/** Local HH:MM (or HH:MM:SS), with the date in front when it is not `now`'s day. */
function clockFor(now: number, timeZone: string | undefined): Clock {
  const zone = timeZone === undefined ? {} : { timeZone };
  const day = new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = day.format(now);
  return (iso, seconds = false) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const clock = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23" }).format(t);
    const date = day.format(t);
    return date === today ? clock : `${date} ${clock}`;
  };
}

/** `$1,234.56`; "" when the total is not known. */
export function money(minor: number | undefined): string {
  if (minor === undefined || !Number.isFinite(minor)) return "";
  return `$${Math.floor(minor / 100).toLocaleString("en-US")}.${String(Math.abs(minor % 100)).padStart(2, "0")}`;
}

/** An approval link the page may open: http(s) only, so a chain value cannot become a `javascript:` link. */
function safeUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function short(handle: string | undefined): string {
  if (handle === undefined) return "";
  return handle.length > 14 ? `${handle.slice(0, 8)}…${handle.slice(-3)}` : handle;
}

function fingerprintShort(fp: string): string {
  const compact = fp.replace(/\s+/g, "");
  return compact.length > 12 ? `${compact.slice(0, 4)}…${compact.slice(-4)}` : fp;
}

function capitalise(s: string): string {
  return s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function join(parts: readonly string[], sep = " · "): string {
  return parts.filter((p) => p !== "").join(sep);
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
