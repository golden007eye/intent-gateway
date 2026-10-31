// The local hash chain read as actions: each search, cart, approval-status check, approval or block, with the
// requests it sent, what came back for each, and its outcome. Pure and presentation-free: `intent log` prints it
// (and serialises it for --json) and the panel can show the same actions. Like `intent log`, it says what the
// gateway sent and what came back, never what Intent Cloud does next (invariant 5); `intent verify` stays the
// integrity check.
//
// Entry bodies are written by other modules (disclosure, gateway, trust, cli approver). This module reads only:
// - disclosure: endpoint, method, path, fields, body_b64, content_digest, keyid.
// - disclosure, also: destination (absent = Intent Cloud) and redacted [{at, sha256}] (ADR-0014). A disclosure to a
//   wallet destination is a `call` action, never correlated with a purchase here.
// - receipt: disclosure_seq, status, verified, receipt_header (its `kid` member); unacknowledged, discarded:
//   disclosure_seq, reason (and status inside the reason, when it starts with one).
// - response (the follow-up of a destination that signs no receipt): disclosure_seq, status, body_sha256, bytes.
// - block: endpoint, destination, fields, blocked, held (the values a policy block held back; absent on older chains,
//   and never read for an identity block or a logging refusal, which hold no values).
// - wallet: rail, action (linked, unlinked, checked), revoked; a check: since, order_count, unmatched_count,
//   unmatched_total_minor, complete.
// - outcome (src/outcome's OutcomeEntry, ADR-0015): handle, basis, state_shown (never `cloud.state`), source or
//   cloud.source, order_ref; joined to the approval of its handle as `outcome_*` facts. A `local` outcome (the
//   gateway's own evidence) wins over a `cloud` one once one exists; a cloud outcome that showed nothing is not read.
// - completion (one-tap, plan G7b): handle; the approval shows `completing` until an outcome says more.
//   complete_attempt is not read.
// - observed: what Intent Cloud returned for one acknowledged request (src/observation's ObservedBody), joined to
//   that request's action. A chain written before observations existed has none, and its actions read as before.
// - approval_pending: handle, approval_url, total_minor, expires_at; approval: handle.
// - approver_pin, approver_flag: fingerprint, handle, reason. keys: statement.kid, statement.expires_at.
// - session: mode ("demo" on the first entry of a demo chain) or id.
// - pause: from; pause_sent: result, reason (joined to its pause, with the `pause` disclosure it names); resume;
//   resume_check: result (joined to its resume); refused: step, reason, source, purchase (ADR-0023).
import { ObservedBody, type ObservedOffer, withheldAt } from "../observation/index.ts";
import { bodyValue, findIdentity, holdsNestedSecret, isSecretKey, markerDigest, SCAN_DEPTH, sentOrderRefAt } from "../privacy/index.ts";
import { neverLeft, verifyChain, type ChainResult } from "../store/index.ts";

/** What one action was. */
export const ACTION_KINDS = ["start", "keys", "search", "cart", "status", "outcome", "approval", "blocked", "pin", "flagged", "wallet", "call", "pause", "resume", "refused", "unreadable"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * What became of one logged request, in `intent verify`'s categories: a receipt came back (`acknowledged`); it left
 * and no receipt came back (`unacknowledged`); it never left, no connection was made (`not_sent`); no answer is
 * recorded, the gateway stopped first or is still waiting (`maybe_sent`); a response without a valid receipt was not
 * used (`discarded`); a destination that signs no receipt (a wallet) answered, and its `response` entry records the
 * status, size and digest of what came back (`answered`).
 */
export type Delivery = "acknowledged" | "answered" | "unacknowledged" | "not_sent" | "maybe_sent" | "discarded";

/** What a request's `fields` hold, instead of the value, for a credential the log holds in clear. */
export const CLEAR_CREDENTIAL = "[a credential in clear, not shown: intent verify fails this entry]";

/**
 * What a request's `fields` hold, instead of the value, for a string that is JSON text with a secret key in it
 * (`state: "{\"access_token\":…}"`). The core redacts by key, not inside string values, so the chain holds it as
 * sent (ADR-0014); the views do not print it.
 */
export const NESTED_CREDENTIAL = "[JSON text holding a credential, not shown]";

/** What a request's `fields` hold, instead of the value, for a value nested deeper than the views walk. */
export const TOO_DEEP = "[nested too deep, not shown]";

/** Where a disclosure without `destination` went. */
export const INTENT_CLOUD = "intent_cloud";

/** One credential a logged request holds only as its digest: where it sat and its sha256. */
export interface ActivityRedaction {
  readonly at: string;
  readonly sha256: string;
}

/** An action's outcome: the worst delivery of its requests, or what the action itself recorded. */
export type Outcome =
  | Delivery
  | "blocked"
  | "refused"
  | "approval_asked"
  | "approved"
  | "pinned"
  | "flagged"
  | "recorded"
  | "unreadable"
  /** A status check whose answer (an observation) said the approval was rejected, or had expired. */
  | "rejected"
  | "expired";

/** What Intent Cloud returned for one request, as the `observed` entry at `seq` recorded it locally. */
export type ActivityObserved = { readonly seq: number } & ObservedBody;

export interface ActivityResponse {
  /** The follow-up entry's seq. */
  readonly seq: number;
  readonly kind: "receipt" | "response" | "unacknowledged" | "discarded";
  /** The HTTP status, when one came back. */
  readonly status: number | null;
  /** A receipt came back. */
  readonly acknowledged: boolean;
  /** The receipt's signature was checked by the gateway when it was logged (`verified: true`); `intent verify` re-checks it. */
  readonly signature_checked: boolean;
  /** The receipt key that signed it, read from the receipt header (not a verification). */
  readonly receipt_kid: string | null;
  /** Why there is no receipt (unacknowledged, discarded). */
  readonly reason: string | null;
  /** response: the size and sha256 of the body that came back (never its content). */
  readonly bytes: number | null;
  readonly body_sha256: string | null;
}

export interface ActivityRequest {
  readonly seq: number;
  readonly time: string;
  /** `intent_cloud`, or the wallet destination (`shop`) the request went to. */
  readonly destination: string;
  readonly endpoint: string;
  readonly method: string | null;
  readonly path: string | null;
  /** The values sent, by dotted path (arrays as `[]`, values as sent), read from the logged body bytes; {} for no body, null when the entry holds no bytes. */
  readonly fields: Readonly<Record<string, unknown>> | null;
  /** The field paths that carry a value, as the entry lists them. */
  readonly field_names: readonly string[];
  readonly content_digest: string | null;
  /** The credentials the logged request holds only as digests (`headers.authorization`); [] for none. */
  readonly redacted: readonly ActivityRedaction[];
  /** The shopping session keyid the request was signed with; null when unsigned. */
  readonly keyid: string | null;
  readonly delivery: Delivery;
  /** The follow-up entry; null when none is recorded. */
  readonly response: ActivityResponse | null;
  /** What Intent Cloud returned, recorded locally after the receipt; null when no observation is recorded. */
  observed: ActivityObserved | null;
}

/** The readable facts of an action; only the ones its entries hold are present. */
export interface ActivityFacts {
  category?: string;
  product?: string;
  must_haves?: string[];
  budget_minor?: number;
  currency?: string;
  zip?: string;
  country?: string;
  offer_handle?: string;
  /** cart: the request was the Shop checkout submitted for the passkey (createCheckout, contract 1.7.0), not createCart. */
  submit?: boolean;
  quantity?: number;
  approval_handle?: string;
  approval_url?: string;
  total_minor?: number;
  expires_at?: string;
  fingerprint?: string;
  /** A new approver pin was written with this approval (the first verified one). */
  pinned?: boolean;
  /** approver_flag: "sign_count", or another passkey than the pin. */
  flag_reason?: string;
  /** call, blocked: the destination when it is not Intent Cloud (`shop`). */
  destination?: string;
  /** blocked: what held it back: a gateway `policy` rule, buyer `identity` in the body, or a `logging` rule (ADR-0014). */
  block_kind?: BlockKind;
  /** wallet: the rail (`shop`), what was done (`linked`, `unlinked`) and whether the rail confirmed revoking the token. */
  wallet_rail?: string;
  wallet_action?: string;
  revoked?: boolean;
  /** wallet `checked` (plan G12): the period's start, the orders the rail reported, how many no outcome names and their USD total, and whether the rail returned every order. */
  check_since?: string;
  check_orders?: number;
  check_unmatched?: number;
  check_unmatched_total_minor?: number;
  check_complete?: boolean;
  key_kid?: string;
  keys_expire_at?: string;
  session_id?: string;
  /** block: the endpoint whose request was held back; call: the operation sent to the destination. */
  endpoint?: string;
  /** block: the field names the held-back request held (names only: its values are not logged). */
  field_names?: string[];
  /** unreadable: the line number in the chain file. */
  line?: number;
  /** search, observed: how many offers Intent Cloud returned, how many the policy hid, and the first ones. */
  offers_count?: number;
  offers_hidden?: number;
  offers?: ObservedOffer[];
  /** cart or status, observed: the product title and merchant name Intent Cloud returned. */
  title?: string;
  merchant?: string;
  /** cart or status, observed: the approval state Intent Cloud returned last (`rejected` after a rejection). */
  approval_state?: string;
  /** approval: what happened after it (an `outcome` entry's state_shown, or `completing` once a one-tap redemption is chained). */
  outcome_state?: string;
  /** approval: `local` (the gateway's own evidence) or `cloud` (Intent Cloud's verified statement). */
  outcome_basis?: string;
  /** approval: where the outcome was read (`shop_api`, `gateway_precheck`, `merchant_api`, …). */
  outcome_source?: string;
  /** approval: the order the outcome names. */
  order_ref?: string;
  /** block: the values a policy block held back (never sent), e.g. {category: "alcohol"}. */
  held?: Record<string, unknown>;
  /** pause: who paused (`cli`, `panel`, `intent_cloud`), and the latest send's result and reason (`pause_sent`). */
  pause_from?: string;
  pause_result?: string;
  pause_reason?: string;
  /** resume: `unconfirmed` until the next submit says `confirmed` or `repaused`. */
  resume_state?: string;
  /** refused: the step a pause stopped and who refused it (`gateway`, `intent_cloud`). */
  refused_step?: string;
  refused_by?: string;
  /** observed: the number facts an observation withheld as possible buyer identity (`total_minor`); shown as "withheld", never as 0. */
  withheld?: string[];
}

export interface Activity {
  /** The seq of its first entry (for an unreadable line, -1). */
  readonly seq: number;
  /** Every entry it covers, in chain order. */
  readonly seqs: number[];
  /** Its first entry's `ts`. */
  readonly time: string;
  readonly action: ActionKind;
  readonly requests: ActivityRequest[];
  /** What was held back or refused: policy rules or identity findings (`categories.block at category`). */
  readonly blocked: string[];
  outcome: Outcome;
  readonly facts: ActivityFacts;
}

export interface ActivitySummary {
  readonly entries: number;
  /** The chain's first entry is the demo session entry. */
  readonly demo: boolean;
  readonly chain: ChainResult;
  /** How many actions of each kind. */
  readonly actions: Record<ActionKind, number>;
  /** Logged requests, in `intent verify`'s categories; `sent` excludes not_sent and maybe_sent. */
  readonly requests: { logged: number; sent: number } & Record<Delivery, number>;
  readonly refused: number;
  /** The field paths every request that may have left carried (all but not_sent), sorted. */
  readonly sent_fields: string[];
  /** The same per destination, Intent Cloud first, then in order of first appearance; only destinations with a logged request. */
  readonly destinations: DestinationSummary[];
  /**
   * Buyer identity (findIdentity, the check the gateway runs before each send) in the values of the requests that may
   * have left: `checked` requests with logged bytes, `unchecked` ones without, and each finding by seq.
   */
  readonly identity: { checked: number; unchecked: number; findings: IdentityFinding[] };
}

export interface DestinationSummary {
  readonly destination: string;
  /** Requests logged to it, and how many of them were maybe sent (no answer recorded) or never left. */
  readonly logged: number;
  readonly maybe_sent: number;
  readonly not_sent: number;
  /** The field paths of its requests that may have left, sorted. */
  readonly fields: string[];
  /** Where the credentials its requests carried sat (`headers.authorization`), sorted; logged as digests only. */
  readonly redacted: string[];
}

export type BlockKind = "policy" | "identity" | "logging";

export interface IdentityFinding {
  readonly seq: number;
  readonly kinds: string[];
}

export interface ActivityLog {
  readonly activities: Activity[];
  readonly summary: ActivitySummary;
}

type Body = Record<string, unknown>;

interface Item {
  seq: number;
  ts: string;
  kind: string;
  body: Body;
}

const FOLLOW_UPS: ReadonlySet<string> = new Set(["receipt", "response", "unacknowledged", "discarded"]);
const KEY_READS: ReadonlySet<string> = new Set(["getMeta", "getSignatureKeys", "getKeyStatement"]);
/** Block reasons the gateway writes about a response it refused (gateway.ts), not a request it held back. */
const REFUSAL = /^(cart|snapshot|approval_proof): /;
/**
 * Block reasons the disclosure core writes for a request it would not log as it was (core.ts step 1), read only on a
 * block entry without `rule` (written before the core recorded it).
 */
const LOGGING_REFUSAL = /^(a credential at |a credential in the query |the body is not plain JSON|the form body is not written|the request has more than one content-type header)/;
/** Block reasons of the buyer-identity check (findIdentity's kinds, written as `<kind> at <path>`). */
const IDENTITY_REASON = /^(card|email|phone|street_address|postcode|banned_key|too_deep) at /;
const SEVERITY: readonly Delivery[] = ["acknowledged", "answered", "not_sent", "unacknowledged", "maybe_sent", "discarded"];

/** Reads the chain items `readChain` returns as actions, in chain order, with summary counts. */
export function buildActivity(items: readonly unknown[]): ActivityLog {
  const activities: Activity[] = [];
  const requests = new Map<number, { request: ActivityRequest; activity: Activity }>();
  const answers = new Map<number, Item>();
  for (const raw of items) {
    const item = asItem(raw);
    if (item !== null && FOLLOW_UPS.has(item.kind)) {
      const target = item.body.disclosure_seq;
      if (typeof target === "number" && !answers.has(target)) answers.set(target, item);
    }
  }
  const last = (kind: ActionKind, accept: (a: Activity) => boolean = () => true): Activity | undefined =>
    activities.findLast((a) => a.action === kind && accept(a));
  const open = (item: Item, action: ActionKind, facts: ActivityFacts = {}, outcome: Outcome = "recorded"): Activity => {
    const activity: Activity = { seq: item.seq, seqs: [item.seq], time: item.ts, action, requests: [], blocked: [], outcome, facts };
    activities.push(activity);
    return activity;
  };
  const join = (activity: Activity, item: Item): void => {
    activity.seqs.push(item.seq);
  };

  for (const [index, raw] of items.entries()) {
    const item = asItem(raw);
    if (item === null) {
      activities.push({ seq: -1, seqs: [], time: "", action: "unreadable", requests: [], blocked: [], outcome: "unreadable", facts: { line: index + 1 } });
      continue;
    }
    const b = item.body;
    switch (item.kind) {
      case "session":
        if (b.mode !== "demo") open(item, "start", { ...(typeof b.id === "string" ? { session_id: b.id } : {}) });
        break;
      case "disclosure": {
        const endpoint = text(b.endpoint);
        const request = toRequest(item, answers.get(item.seq) ?? null);
        let activity: Activity;
        if (request.destination !== INTENT_CLOUD) {
          activity = open(item, "call", { destination: request.destination, endpoint });
        } else if (KEY_READS.has(endpoint)) {
          const previous = activities.at(-1);
          activity = previous !== undefined && (previous.action === "start" || previous.action === "keys") && previous.facts.key_kid === undefined ? previous : open(item, "keys");
        } else if (endpoint === "searchCatalog") {
          activity = open(item, "search", searchFacts(request.fields));
        } else if (endpoint === "createCart") {
          activity = open(item, "cart", cartFacts(request.fields));
        } else if (endpoint === "createCheckout") {
          // The 1.7.0 submit: the Shop checkout sent to Intent Cloud for the passkey; its approval link joins this cart.
          activity = open(item, "cart", checkoutFacts(request.fields));
        } else if (endpoint === "createApproval") {
          activity = last("cart", (a) => !a.requests.some((r) => r.endpoint === "createApproval")) ?? open(item, "cart");
        } else if (endpoint === "getApproval") {
          activity = open(item, "status", handleFromPath(request.path));
        } else if (endpoint === "pause") {
          activity = last("pause") ?? open(item, "pause");
        } else if (endpoint === "reportOutcome") {
          // The gateway's own outcome report (contract 1.6.0): what it sent, never what Intent Cloud then did.
          activity = open(item, "outcome", handleFromPath(request.path));
        } else {
          activity = open(item, "keys");
        }
        if (activity.seq !== item.seq) join(activity, item);
        activity.requests.push(request);
        requests.set(item.seq, { request, activity });
        if (activity.outcome === "recorded" || isDelivery(activity.outcome)) activity.outcome = worst(activity.requests);
        break;
      }
      case "receipt":
      case "response":
      case "unacknowledged":
      case "discarded": {
        const target = typeof b.disclosure_seq === "number" ? requests.get(b.disclosure_seq) : undefined;
        if (target !== undefined) join(target.activity, item);
        break;
      }
      case "keys": {
        const statement = record(b.statement);
        const facts = { key_kid: text(statement.kid), keys_expire_at: text(statement.expires_at) };
        const previous = activities.at(-1);
        if (previous !== undefined && (previous.action === "start" || previous.action === "keys") && previous.facts.key_kid === undefined) {
          join(previous, item);
          Object.assign(previous.facts, facts);
        } else {
          open(item, "keys", facts);
        }
        break;
      }
      case "block": {
        const blocked = strings(b.blocked);
        const endpoint = text(b.endpoint);
        const refusalOf: ActionKind | null = blocked.some((r) => REFUSAL.test(r)) ? (endpoint === "getApproval" ? "status" : "cart") : null;
        const target = refusalOf === null ? undefined : last(refusalOf);
        if (target !== undefined) {
          join(target, item);
          target.blocked.push(...blocked);
          target.outcome = "refused";
        } else {
          const kind = blockKind(b);
          // Only a policy block keeps values (the structured ones it held back); any other `held` is never shown.
          const held = kind === "policy" ? record(b.held) : {};
          const facts: ActivityFacts = {
            endpoint,
            ...(typeof b.destination === "string" && b.destination !== INTENT_CLOUD ? { destination: b.destination } : {}),
            block_kind: kind,
            field_names: leafFields(strings(b.fields)),
            ...(Object.keys(held).length === 0 ? {} : { held }),
          };
          const activity = open(item, "blocked", facts, refusalOf === null ? "blocked" : "refused");
          activity.blocked.push(...blocked);
        }
        break;
      }
      case "observed": {
        const parsed = ObservedBody.safeParse(b);
        // A malformed observation, or one that names no request, is left out here; `intent verify` reports it.
        const target = parsed.success ? requests.get(parsed.data.disclosure_seq) : undefined;
        if (!parsed.success || target === undefined || target.request.observed !== null || target.request.endpoint !== parsed.data.endpoint || target.request.delivery !== "acknowledged") break;
        join(target.activity, item);
        target.request.observed = { seq: item.seq, ...parsed.data };
        observe(target.activity, parsed.data, activities);
        break;
      }
      case "approval_pending": {
        const facts: ActivityFacts = {
          ...(typeof b.handle === "string" ? { approval_handle: b.handle } : {}),
          ...(typeof b.approval_url === "string" ? { approval_url: b.approval_url } : {}),
          ...(typeof b.total_minor === "number" ? { total_minor: b.total_minor } : {}),
          ...(typeof b.expires_at === "string" ? { expires_at: b.expires_at } : {}),
        };
        const cart = last("cart", (a) => a.facts.approval_handle === undefined);
        if (cart === undefined) {
          open(item, "cart", facts, "approval_asked");
        } else {
          join(cart, item);
          Object.assign(cart.facts, facts);
          // A link asked for over a request without a receipt keeps that request's outcome: it is the one to see.
          if (cart.outcome !== "refused" && worst(cart.requests) === "acknowledged") cart.outcome = "approval_asked";
        }
        break;
      }
      case "approver_pin": {
        const fingerprint = text(b.fingerprint);
        // The gateway writes the first pin just before the approval it came with (same handle); `approver accept` writes one alone.
        const next = asItem(items[index + 1]);
        if (typeof b.handle === "string" && next?.kind === "approval" && next.body.handle === b.handle) break;
        open(item, "pin", { fingerprint }, "pinned");
        break;
      }
      case "approval": {
        const handle = text(b.handle);
        const pending = items.map(asItem).findLast((e) => e !== null && e.seq < item.seq && e.kind === "approval_pending" && e.body.handle === handle);
        const previous = asItem(items[index - 1]);
        const pinItem = previous?.kind === "approver_pin" && previous.body.handle === handle ? previous : null;
        const pinnedNow = pinItem !== null;
        const pin = pinItem ?? items.map(asItem).findLast((e) => e !== null && e.seq < item.seq && e.kind === "approver_pin");
        const activity = open(pinItem ?? item, "approval", {
          approval_handle: handle,
          ...(typeof pending?.body.total_minor === "number" ? { total_minor: pending.body.total_minor } : {}),
          ...(pin === undefined || pin === null ? {} : { fingerprint: text(pin.body.fingerprint) }),
          ...(pinnedNow ? { pinned: true } : {}),
        }, "approved");
        if (pinnedNow) join(activity, item);
        break;
      }
      case "wallet":
        open(item, "wallet", {
          wallet_rail: text(b.rail),
          wallet_action: text(b.action),
          ...(typeof b.revoked === "boolean" ? { revoked: b.revoked } : {}),
          ...(b.action !== "checked"
            ? {}
            : {
                check_since: text(b.since),
                ...(typeof b.order_count === "number" ? { check_orders: b.order_count } : {}),
                ...(typeof b.unmatched_count === "number" ? { check_unmatched: b.unmatched_count } : {}),
                ...(typeof b.unmatched_total_minor === "number" ? { check_unmatched_total_minor: b.unmatched_total_minor } : {}),
                ...(typeof b.complete === "boolean" ? { check_complete: b.complete } : {}),
              }),
        });
        break;
      case "completion":
      case "outcome": {
        const approval = last("approval", (a) => a.facts.approval_handle === b.handle);
        if (approval === undefined) break;
        const f = approval.facts;
        if (item.kind === "completion") {
          join(approval, item);
          f.outcome_state ??= "completing";
          break;
        }
        const local = b.basis === "local";
        const shown = typeof b.state_shown === "string" ? b.state_shown : null;
        // Intent Cloud's word never overrides the gateway's own evidence, and a refused statement shows nothing.
        if (shown === null || (!local && f.outcome_basis === "local")) break;
        join(approval, item);
        const cloud = typeof b.cloud === "object" && b.cloud !== null ? (b.cloud as Record<string, unknown>) : {};
        const source = local ? b.source : cloud.source;
        Object.assign(f, {
          outcome_state: shown,
          outcome_basis: local ? "local" : "cloud",
          ...(typeof source === "string" ? { outcome_source: source } : {}),
        });
        if (typeof b.order_ref === "string") f.order_ref = b.order_ref;
        break;
      }
      case "pause":
        open(item, "pause", { pause_from: text(b.from) });
        break;
      case "pause_sent": {
        const pause = last("pause");
        if (pause === undefined) break;
        join(pause, item);
        pause.facts.pause_result = text(b.result);
        pause.facts.pause_reason = text(b.reason);
        break;
      }
      case "resume":
        open(item, "resume", { resume_state: "unconfirmed" });
        break;
      case "resume_check": {
        const resume = last("resume", (a) => a.seq === b.resume_seq);
        if (b.result === "repaused") {
          open(item, "pause", { pause_from: "intent_cloud" });
        }
        if (resume === undefined) break;
        join(resume, item);
        resume.facts.resume_state = text(b.result);
        break;
      }
      case "refused": {
        const activity = open(item, "refused", {
          refused_step: text(b.step),
          refused_by: text(b.source),
          ...(typeof b.purchase === "string" ? { approval_handle: b.purchase } : {}),
        }, "refused");
        activity.blocked.push(text(b.reason));
        break;
      }
      case "approver_flag":
        open(item, "flagged", { fingerprint: text(b.fingerprint), ...(typeof b.reason === "string" ? { flag_reason: b.reason } : {}) }, "flagged");
        break;
      default:
        break;
    }
  }
  return { activities, summary: summarise(items, activities) };
}

export interface ActivityFilter {
  /** Keep actions at or after this time. */
  readonly since?: Date;
  /** Keep only these kinds. */
  readonly actions?: ReadonlySet<ActionKind>;
  /** Then keep the last N. */
  readonly last?: number;
}

/** The actions a filter keeps, in chain order. Unreadable lines are always kept: they are never hidden. */
export function filterActivity(activities: readonly Activity[], filter: ActivityFilter): Activity[] {
  const since = filter.since?.getTime();
  const kept = activities.filter((a) => {
    if (a.action === "unreadable") return true;
    if (filter.actions !== undefined && !filter.actions.has(a.action)) return false;
    if (since !== undefined) {
      const t = Date.parse(a.time);
      if (Number.isNaN(t) || t < since) return false;
    }
    return true;
  });
  return filter.last === undefined ? kept : kept.slice(Math.max(0, kept.length - filter.last));
}

/** The counts over `activities` (all of a chain's, or the ones a filter kept) of the chain `items`. */
export function summarise(items: readonly unknown[], activities: readonly Activity[]): ActivitySummary {
  const actions = Object.fromEntries(ACTION_KINDS.map((k) => [k, 0])) as Record<ActionKind, number>;
  const counts = { logged: 0, sent: 0, acknowledged: 0, answered: 0, unacknowledged: 0, not_sent: 0, maybe_sent: 0, discarded: 0 };
  let refused = 0;
  const sent = new Set<string>();
  const byDestination = new Map<string, { logged: number; maybe_sent: number; not_sent: number; fields: Set<string>; redacted: Set<string> }>();
  const findings: IdentityFinding[] = [];
  let checked = 0;
  let unchecked = 0;
  let bodies: Map<number, unknown> | null = null;
  for (const a of activities) {
    actions[a.action] += 1;
    if (a.outcome === "refused") refused += 1;
    for (const r of a.requests) {
      counts.logged += 1;
      counts[r.delivery] += 1;
      let d = byDestination.get(r.destination);
      if (d === undefined) {
        d = { logged: 0, maybe_sent: 0, not_sent: 0, fields: new Set(), redacted: new Set() };
        byDestination.set(r.destination, d);
      }
      d.logged += 1;
      if (r.delivery === "maybe_sent") d.maybe_sent += 1;
      if (r.delivery === "not_sent") {
        d.not_sent += 1;
        continue;
      }
      for (const f of r.field_names) {
        sent.add(f);
        d.fields.add(f);
      }
      for (const x of r.redacted) d.redacted.add(x.at);
      if (r.fields === null) {
        unchecked += 1;
        continue;
      }
      checked += 1;
      // Every body is checked as the disclosure core checked it before the send: the logged body, nested, with the same
      // options. The flattened fields would not do: their keys are dotted paths, so `checkout.store_name` reads as a
      // name key, and a wallet's `params.name` loses its MCP exemption.
      bodies ??= bodiesBySeq(items);
      const toCloud = r.destination === INTENT_CLOUD;
      // A search carries the agent's free text (product, must-haves), to Intent Cloud and to a wallet's catalog search
      // (Shop's search_catalog query): the free-text rules run on it too.
      const freeText = toCloud ? r.endpoint === "searchCatalog" : r.endpoint === "search_catalog";
      const found = findIdentity(bodies.get(r.seq) ?? null, { mcpEnvelope: !toCloud, orderRefAt: sentOrderRefAt(r.endpoint, toCloud), freeText });
      if (found.length > 0) findings.push({ seq: r.seq, kinds: [...new Set(found.map((f) => f.kind))].sort() });
    }
  }
  counts.sent = counts.logged - counts.not_sent - counts.maybe_sent;
  const first = asItem(items[0]);
  return {
    entries: items.length,
    demo: first?.kind === "session" && first.body.mode === "demo",
    chain: verifyChain(items),
    actions,
    requests: counts,
    refused,
    sent_fields: [...sent].sort(),
    destinations: [...byDestination.entries()]
      .sort(([a], [b]) => Number(b === INTENT_CLOUD) - Number(a === INTENT_CLOUD))
      .map(([destination, d]) => ({ destination, logged: d.logged, maybe_sent: d.maybe_sent, not_sent: d.not_sent, fields: [...d.fields].sort(), redacted: [...d.redacted].sort() })),
    identity: { checked, unchecked, findings },
  };
}

/** The logged JSON body of each disclosure, by seq (bodies that are not JSON are left out). */
function bodiesBySeq(items: readonly unknown[]): Map<number, unknown> {
  const out = new Map<number, unknown>();
  for (const raw of items) {
    const item = asItem(raw);
    if (item?.kind !== "disclosure") continue;
    // A body that cannot be read has no fields either, so its request counts as unchecked.
    const body = loggedBody(item.body);
    if (body !== undefined && body !== null) out.set(item.seq, body);
  }
  return out;
}

function toRequest(item: Item, answer: Item | null): ActivityRequest {
  const b = item.body;
  return {
    seq: item.seq,
    time: item.ts,
    destination: destinationOf(b),
    endpoint: text(b.endpoint),
    method: typeof b.method === "string" ? b.method : null,
    path: typeof b.path === "string" ? b.path : null,
    fields: loggedValues(b),
    field_names: leafFields(strings(b.fields)),
    content_digest: typeof b.content_digest === "string" ? b.content_digest : null,
    redacted: Array.isArray(b.redacted)
      ? b.redacted.map(record).flatMap((r) => (typeof r.at === "string" && typeof r.sha256 === "string" ? [{ at: r.at, sha256: r.sha256 }] : []))
      : [],
    keyid: typeof b.keyid === "string" ? b.keyid : null,
    delivery:
      answer === null
        ? "maybe_sent"
        : answer.kind === "receipt"
          ? "acknowledged"
          : answer.kind === "response"
            ? "answered"
            : answer.kind === "discarded"
              ? "discarded"
              : neverLeft(answer.body)
                ? "not_sent"
                : "unacknowledged",
    response: answer === null ? null : toResponse(answer),
    observed: null,
  };
}

/** Adds what an observation says to its action's facts; a rejected or expired approval becomes the status's outcome. */
function observe(activity: Activity, o: ObservedBody, activities: readonly Activity[]): void {
  const f = activity.facts;
  // A total the observation withheld is stored as 0: it is not a fact, so it is listed in `withheld` instead.
  const total = (): Partial<ActivityFacts> =>
    "total_minor" in o && withheldAt(o.withheld, "$.total_minor") ? { withheld: [...new Set([...(f.withheld ?? []), "total_minor"])] } : "total_minor" in o ? { total_minor: o.total_minor } : {};
  switch (o.endpoint) {
    case "searchCatalog":
      Object.assign(f, { offers_count: o.offers_count, offers_hidden: o.offers_hidden, offers: o.offers });
      break;
    case "createCart":
      Object.assign(f, { title: o.title, merchant: o.merchant, quantity: o.quantity, ...total() });
      break;
    case "createApproval":
      Object.assign(f, { title: o.title, merchant: o.merchant, quantity: o.quantity, ...total(), approval_state: o.state });
      break;
    case "getApproval": {
      Object.assign(f, { title: o.title, merchant: o.merchant, ...total(), approval_state: o.state });
      if ((o.state === "rejected" || o.state === "expired") && activity.outcome === "acknowledged") activity.outcome = o.state;
      const cart = activities.findLast((a) => a.action === "cart" && a.facts.approval_handle === o.approval_handle);
      if (cart !== undefined) cart.facts.approval_state = o.state;
      break;
    }
  }
}

function toResponse(item: Item): ActivityResponse {
  const b = item.body;
  const reason = typeof b.reason === "string" ? b.reason : null;
  const status = typeof b.status === "number" ? b.status : reason === null ? null : statusIn(reason);
  return {
    seq: item.seq,
    kind: item.kind as ActivityResponse["kind"],
    status,
    acknowledged: item.kind === "receipt",
    signature_checked: item.kind === "receipt" && b.verified === true,
    receipt_kid: item.kind === "receipt" ? receiptKid(b.receipt_header) : null,
    reason,
    bytes: item.kind === "response" && typeof b.bytes === "number" ? b.bytes : null,
    body_sha256: item.kind === "response" && typeof b.body_sha256 === "string" ? b.body_sha256 : null,
  };
}

/** A disclosure's destination: `intent_cloud` when it names none. */
function destinationOf(b: Body): string {
  return typeof b.destination === "string" && b.destination !== "" ? b.destination : INTENT_CLOUD;
}

/**
 * What held a request back, from a `block` entry's body: its `rule` when present (the disclosure core writes
 * `logging` or `identity`); any other `rule`, `policy` included (the core never writes it), is read as `identity`, so its values are never shown. A block without
 * `rule` (a policy block, or one written before the core recorded it) is read from its reasons.
 */
export function blockKind(block: Readonly<Record<string, unknown>>): BlockKind {
  if (block.rule !== undefined) return block.rule === "logging" ? "logging" : "identity";
  const reasons = strings(block.blocked);
  if (reasons.some((r) => LOGGING_REFUSAL.test(r))) return "logging";
  if (reasons.some((r) => IDENTITY_REASON.test(r))) return "identity";
  return "policy";
}

/**
 * A wallet check (plan G12) in words, one part per fact: what the rail reported and how many orders no outcome in the
 * log names, never what the rail did (invariant 5). Empty for any other wallet action.
 */
export function walletCheckWords(f: Readonly<ActivityFacts>): string[] {
  if (f.wallet_action !== "checked") return [];
  const rail = destinationLabel(f.wallet_rail ?? "");
  const n = f.check_orders ?? 0;
  const day = (f.check_since ?? "").slice(0, 10);
  const total = f.check_unmatched_total_minor === undefined ? "" : ` (${(f.check_unmatched_total_minor / 100).toFixed(2)} USD)`;
  return [
    `${rail} reported ${String(n)} order${n === 1 ? "" : "s"}${day === "" ? "" : ` since ${day}`}`,
    `${String(f.check_unmatched ?? 0)} not matched to a purchase in this log${total}`,
    f.check_complete === false ? `${rail} said more orders exist, or returned a full page of 50: counts cover only the orders it returned` : "",
  ].filter((p) => p !== "");
}

const IDENTITY_WORDS: Readonly<Record<string, string>> = {
  card: "a card number",
  email: "an email address",
  phone: "a phone number",
  street_address: "a street address",
  postcode: "a full postcode",
  banned_key: "an identity field",
  too_deep: "a value nested too deep to check",
};

/** Field names whose words differ from the name with `_` read as a space. */
const FIELD_WORDS: Readonly<Record<string, string>> = { must_haves: "must-haves", postal_code: "postcode" };

/**
 * A logged JSON path as the field a person typed it in: `$.must_haves[0]` → `must-haves`, `$.params.arguments.note`
 * → `note`, `$` → `the request`. The exact path stays in `intent log -v` and the panel's server log.
 */
export function fieldWords(path: string): string {
  const last = path.replace(/\[\d+\]/g, "").split(".").filter((s) => s !== "" && s !== "$").at(-1);
  if (last === undefined) return "the request";
  return FIELD_WORDS[last] ?? last.replaceAll("_", " ");
}

/** An identity block reason in plain words, `postcode at $.must_haves[0]` → `a full postcode (in must-haves)`; null for any other reason. */
export function identityWords(reason: string): string | null {
  const match = /^(.+?) at (.+)$/.exec(reason);
  const words = match === null ? undefined : IDENTITY_WORDS[match[1] ?? ""];
  return words === undefined ? null : `${words} (in ${fieldWords(match?.[2] ?? "")})`;
}

/** `intent_cloud` → `Intent Cloud`, `shop` → `Shop`, `shop_accounts` → `Shop accounts`: a destination in words. */
export function destinationLabel(destination: string): string {
  if (destination === INTENT_CLOUD) return "Intent Cloud";
  const words = destination.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The client fields the gateway's own Shop MCP client (src/wallet-shop/rpc.ts) writes in `params._meta` of every
 * request. Only these are summed up as the MCP envelope; any other `_meta` field is named on its own (invariant 5).
 */
export const MCP_CLIENT_META: ReadonlySet<string> = new Set([
  "params._meta.io.modelcontextprotocol/clientCapabilities",
  "params._meta.io.modelcontextprotocol/clientInfo.name",
  "params._meta.io.modelcontextprotocol/clientInfo.version",
  "params._meta.io.modelcontextprotocol/protocolVersion",
]);

/** The JSON-RPC fields of every MCP request, the tool name and an empty arguments object. */
export const MCP_ENVELOPE: ReadonlySet<string> = new Set(["jsonrpc", "id", "method", "params.name", "params.arguments"]);

/** A redaction marker (`[redacted sha256:<hex>]`) in words: `redacted (sha256 1a2b3c4d…)`; null for any other value. */
export function credentialWords(value: unknown): string | null {
  const digest = markerDigest(value);
  return digest === null ? null : `redacted (sha256 ${digest.slice(0, 8)}…)`;
}

/** `502 without Intent-Contract-Version` → 502. */
function statusIn(reason: string): number | null {
  const match = /^([1-5][0-9]{2}) /.exec(reason);
  return match === null ? null : Number(match[1]);
}

/** The `kid` member of a receipt header (base64url JSON), for display; the signature is checked elsewhere. */
function receiptKid(header: unknown): string | null {
  if (typeof header !== "string") return null;
  try {
    const kid = record(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).kid;
    return typeof kid === "string" ? kid : null;
  } catch {
    return null;
  }
}

/** A disclosure's logged body bytes as `path → value`; {} for an empty body, null when there are no bytes or they cannot be read. */
export function loggedValues(b: Readonly<Body>): Record<string, unknown> | null {
  const body = loggedBody(b);
  if (body === undefined) return null;
  const out: Record<string, unknown> = {};
  if (body !== null) flatten(body, "", out);
  return out;
}

/**
 * A disclosure's logged body read as its content-type says (privacy's bodyValue: a form as {name: value}, else JSON);
 * null for an empty body, undefined when there are no bytes or they cannot be read.
 */
function loggedBody(b: Readonly<Body>): unknown {
  if (typeof b.body_b64 !== "string") return undefined;
  const headers = Array.isArray(b.headers)
    ? b.headers.flatMap((h): [string, string][] => (Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string" ? [[h[0], h[1]]] : []))
    : [];
  try {
    return bodyValue(headers, Buffer.from(b.body_b64, "base64"));
  } catch {
    return undefined;
  }
}

/** Leaves by dotted path; an array of scalars stays one value (`must_haves: ["road"]`), an array of objects is walked as `[]`. */
// A value under a credential key that is not a redaction marker (a hand-edited chain; `intent verify` fails it) is
// never read out: it stands as CLEAR_CREDENTIAL, so no view prints a credential. A value nested deeper than
// SCAN_DEPTH stands as TOO_DEEP, so a deeply nested value cannot exhaust the stack (or hide a credential below it).
function flatten(value: unknown, prefix: string, out: Record<string, unknown>, secretKey = false, depth = 0): void {
  if (secretKey && value !== null && markerDigest(value) === null) {
    out[prefix] = CLEAR_CREDENTIAL;
  } else if (depth > SCAN_DEPTH && typeof value === "object" && value !== null) {
    out[prefix] = TOO_DEEP;
  } else if (Array.isArray(value) && value.some((v) => typeof v === "object" && v !== null)) {
    for (const item of value) flatten(item, `${prefix}[]`, out, false, depth + 1);
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const [key, item] of Object.entries(value)) flatten(item, prefix === "" ? key : `${prefix}.${key}`, out, isSecretKey(key, keys), depth + 1);
  } else if (prefix !== "") {
    const texts = Array.isArray(value) ? value : [value];
    out[prefix] = texts.some((v) => typeof v === "string" && holdsNestedSecret(v)) ? NESTED_CREDENTIAL : value;
  }
}

function searchFacts(fields: Readonly<Record<string, unknown>> | null): ActivityFacts {
  if (fields === null) return {};
  const f = fields;
  return {
    ...(typeof f.category === "string" ? { category: f.category } : {}),
    ...(typeof f.product === "string" ? { product: f.product } : {}),
    ...(Array.isArray(f.must_haves) ? { must_haves: f.must_haves.filter((m): m is string => typeof m === "string") } : {}),
    ...(typeof f["budget_max.amount_minor"] === "number" ? { budget_minor: f["budget_max.amount_minor"] } : {}),
    ...(typeof f["budget_max.currency"] === "string" ? { currency: f["budget_max.currency"] } : {}),
    ...shipTo(f),
  };
}

function cartFacts(fields: Readonly<Record<string, unknown>> | null): ActivityFacts {
  if (fields === null) return {};
  const f = fields;
  return {
    ...(typeof f.offer_handle === "string" ? { offer_handle: f.offer_handle } : {}),
    ...(typeof f.quantity === "number" ? { quantity: f.quantity } : {}),
    ...shipTo(f),
  };
}

/** What a createCheckout body sent, by its contract paths (`checkout.*`). */
function checkoutFacts(fields: Readonly<Record<string, unknown>> | null): ActivityFacts {
  if (fields === null) return { submit: true };
  const f = fields;
  return {
    submit: true,
    ...(typeof f["checkout.title"] === "string" ? { title: f["checkout.title"] } : {}),
    ...(typeof f["checkout.quantity"] === "number" ? { quantity: f["checkout.quantity"] } : {}),
    ...(typeof f["checkout.totals.total"] === "number" ? { total_minor: f["checkout.totals.total"] } : {}),
    ...(typeof f["checkout.store_name"] === "string" ? { merchant: f["checkout.store_name"] } : {}),
    ...(typeof f["checkout.ship_to.postal_code"] === "string" ? { zip: f["checkout.ship_to.postal_code"] } : {}),
    ...(typeof f["checkout.ship_to.country"] === "string" ? { country: f["checkout.ship_to.country"] } : {}),
  };
}

function shipTo(f: Readonly<Record<string, unknown>>): ActivityFacts {
  return {
    ...(typeof f["ship_to.postal_code"] === "string" ? { zip: f["ship_to.postal_code"] } : {}),
    ...(typeof f["ship_to.country"] === "string" ? { country: f["ship_to.country"] } : {}),
  };
}

/** `/v1/approvals/ap_x` → its handle. */
function handleFromPath(path: string | null): ActivityFacts {
  const handle = path === null ? undefined : /\/approvals\/([^/?#]+)(?:\/outcome-reports)?$/.exec(path)?.[1];
  return handle === undefined ? {} : { approval_handle: decodeURIComponent(handle) };
}

function worst(requests: readonly ActivityRequest[]): Delivery {
  let index = 0;
  for (const r of requests) index = Math.max(index, SEVERITY.indexOf(r.delivery));
  return SEVERITY[index] ?? "acknowledged";
}

function isDelivery(outcome: Outcome): outcome is Delivery {
  return (SEVERITY as readonly string[]).includes(outcome);
}

/** `ship_to` and `ship_to.postal_code` → `ship_to.postal_code`: only the fields that carry a value. */
export function leafFields(fields: readonly string[]): string[] {
  return fields.filter((f) => !fields.some((other) => other.startsWith(`${f}.`) || other.startsWith(`${f}[]`)));
}

function asItem(raw: unknown): Item | null {
  const r = record(raw);
  if (typeof r.seq !== "number" || typeof r.ts !== "string" || typeof r.kind !== "string") return null;
  return { seq: r.seq, ts: r.ts, kind: r.kind, body: record(r.body) };
}

function record(value: unknown): Body {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Body) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
