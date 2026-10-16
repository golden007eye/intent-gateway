// The local hash chain read as actions: each search, cart, approval-status check, approval or block, with the
// requests it sent, what came back for each, and its outcome. Pure and presentation-free: `intent log` prints it
// (and serialises it for --json) and the panel can show the same actions. Like `intent log`, it says what the
// gateway sent and what came back, never what Intent Cloud does next (invariant 5); `intent verify` stays the
// integrity check.
//
// Entry bodies are written by other modules (disclosure, gateway, trust, cli approver). This module reads only:
// - disclosure: endpoint, method, path, fields, body_b64, content_digest, keyid.
// - receipt: disclosure_seq, status, verified, receipt_header (its `kid` member); unacknowledged, discarded:
//   disclosure_seq, reason (and status inside the reason, when it starts with one).
// - block: endpoint, fields, blocked, held (the values a policy block held back; absent on older chains).
// - observed: what Intent Cloud returned for one acknowledged request (src/observation's ObservedBody), joined to
//   that request's action. A chain written before observations existed has none, and its actions read as before.
// - approval_pending: handle, approval_url, total_minor, expires_at; approval: handle.
// - approver_pin, approver_flag: fingerprint, handle, reason. keys: statement.kid, statement.expires_at.
// - session: mode ("demo" on the first entry of a demo chain) or id.
import { ObservedBody, type ObservedOffer } from "../observation/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { neverLeft, verifyChain, type ChainResult } from "../store/index.ts";

/** What one action was. */
export const ACTION_KINDS = ["start", "keys", "search", "cart", "status", "approval", "blocked", "pin", "flagged", "unreadable"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * What became of one logged request, in `intent verify`'s categories: a receipt came back (`acknowledged`); it left
 * and no receipt came back (`unacknowledged`); it never left, no connection was made (`not_sent`); no answer is
 * recorded, the gateway stopped first or is still waiting (`maybe_sent`); a response without a valid receipt was not
 * used (`discarded`).
 */
export type Delivery = "acknowledged" | "unacknowledged" | "not_sent" | "maybe_sent" | "discarded";

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
  readonly kind: "receipt" | "unacknowledged" | "discarded";
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
}

export interface ActivityRequest {
  readonly seq: number;
  readonly time: string;
  readonly endpoint: string;
  readonly method: string | null;
  readonly path: string | null;
  /** The values sent, by dotted path (arrays as `[]`, values as sent), read from the logged body bytes; {} for no body, null when the entry holds no bytes. */
  readonly fields: Readonly<Record<string, unknown>> | null;
  /** The field paths that carry a value, as the entry lists them. */
  readonly field_names: readonly string[];
  readonly content_digest: string | null;
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
  key_kid?: string;
  keys_expire_at?: string;
  session_id?: string;
  /** block: the endpoint whose request was held back. */
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
  /** block: the values a policy block held back (never sent), e.g. {category: "alcohol"}. */
  held?: Record<string, unknown>;
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
  /**
   * Buyer identity (findIdentity, the check the gateway runs before each send) in the values of the requests that may
   * have left: `checked` requests with logged bytes, `unchecked` ones without, and each finding by seq.
   */
  readonly identity: { checked: number; unchecked: number; findings: IdentityFinding[] };
}

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

const KEY_READS: ReadonlySet<string> = new Set(["getMeta", "getSignatureKeys", "getKeyStatement"]);
/** Block reasons the gateway writes about a response it refused (gateway.ts), not a request it held back. */
const REFUSAL = /^(cart|snapshot|approval_proof): /;
const SEVERITY: readonly Delivery[] = ["acknowledged", "not_sent", "unacknowledged", "maybe_sent", "discarded"];

/** Reads the chain items `readChain` returns as actions, in chain order, with summary counts. */
export function buildActivity(items: readonly unknown[]): ActivityLog {
  const activities: Activity[] = [];
  const requests = new Map<number, { request: ActivityRequest; activity: Activity }>();
  const answers = new Map<number, Item>();
  for (const raw of items) {
    const item = asItem(raw);
    if (item !== null && (item.kind === "receipt" || item.kind === "unacknowledged" || item.kind === "discarded")) {
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
        if (KEY_READS.has(endpoint)) {
          const previous = activities.at(-1);
          activity = previous !== undefined && (previous.action === "start" || previous.action === "keys") && previous.facts.key_kid === undefined ? previous : open(item, "keys");
        } else if (endpoint === "searchCatalog") {
          activity = open(item, "search", searchFacts(request.fields));
        } else if (endpoint === "createCart") {
          activity = open(item, "cart", cartFacts(request.fields));
        } else if (endpoint === "createApproval") {
          activity = last("cart", (a) => !a.requests.some((r) => r.endpoint === "createApproval")) ?? open(item, "cart");
        } else if (endpoint === "getApproval") {
          activity = open(item, "status", handleFromPath(request.path));
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
          const held = record(b.held);
          const facts: ActivityFacts = { endpoint, field_names: leafFields(strings(b.fields)), ...(Object.keys(held).length === 0 ? {} : { held }) };
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
  const counts = { logged: 0, sent: 0, acknowledged: 0, unacknowledged: 0, not_sent: 0, maybe_sent: 0, discarded: 0 };
  let refused = 0;
  const sent = new Set<string>();
  const findings: IdentityFinding[] = [];
  let checked = 0;
  let unchecked = 0;
  for (const a of activities) {
    actions[a.action] += 1;
    if (a.outcome === "refused") refused += 1;
    for (const r of a.requests) {
      counts.logged += 1;
      counts[r.delivery] += 1;
      if (r.delivery === "not_sent") continue;
      for (const f of r.field_names) sent.add(f);
      if (r.fields === null) {
        unchecked += 1;
        continue;
      }
      checked += 1;
      const found = findIdentity(r.fields);
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
    identity: { checked, unchecked, findings },
  };
}

function toRequest(item: Item, answer: Item | null): ActivityRequest {
  const b = item.body;
  return {
    seq: item.seq,
    time: item.ts,
    endpoint: text(b.endpoint),
    method: typeof b.method === "string" ? b.method : null,
    path: typeof b.path === "string" ? b.path : null,
    fields: values(b.body_b64),
    field_names: leafFields(strings(b.fields)),
    content_digest: typeof b.content_digest === "string" ? b.content_digest : null,
    keyid: typeof b.keyid === "string" ? b.keyid : null,
    delivery: answer === null ? "maybe_sent" : answer.kind === "receipt" ? "acknowledged" : answer.kind === "discarded" ? "discarded" : neverLeft(answer.body) ? "not_sent" : "unacknowledged",
    response: answer === null ? null : toResponse(answer),
    observed: null,
  };
}

/** Adds what an observation says to its action's facts; a rejected or expired approval becomes the status's outcome. */
function observe(activity: Activity, o: ObservedBody, activities: readonly Activity[]): void {
  const f = activity.facts;
  switch (o.endpoint) {
    case "searchCatalog":
      Object.assign(f, { offers_count: o.offers_count, offers_hidden: o.offers_hidden, offers: o.offers });
      break;
    case "createCart":
      Object.assign(f, { title: o.title, merchant: o.merchant, quantity: o.quantity, total_minor: o.total_minor });
      break;
    case "createApproval":
      Object.assign(f, { title: o.title, merchant: o.merchant, quantity: o.quantity, total_minor: o.total_minor, approval_state: o.state });
      break;
    case "getApproval": {
      Object.assign(f, { title: o.title, merchant: o.merchant, total_minor: o.total_minor, approval_state: o.state });
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
  };
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

/** The logged body bytes as `path → value`; {} for an empty body, null when there are no bytes or they are not JSON. */
function values(b64: unknown): Record<string, unknown> | null {
  if (typeof b64 !== "string") return null;
  if (b64 === "") return {};
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const out: Record<string, unknown> = {};
  flatten(json, "", out);
  return out;
}

/** Leaves by dotted path; an array of scalars stays one value (`must_haves: ["road"]`), an array of objects is walked as `[]`. */
function flatten(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (Array.isArray(value) && value.some((v) => typeof v === "object" && v !== null)) {
    for (const item of value) flatten(item, `${prefix}[]`, out);
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix === "" ? key : `${prefix}.${key}`, out);
  } else if (prefix !== "") {
    out[prefix] = value;
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

function shipTo(f: Readonly<Record<string, unknown>>): ActivityFacts {
  return {
    ...(typeof f["ship_to.postal_code"] === "string" ? { zip: f["ship_to.postal_code"] } : {}),
    ...(typeof f["ship_to.country"] === "string" ? { country: f["ship_to.country"] } : {}),
  };
}

/** `/v1/approvals/ap_x` → its handle. */
function handleFromPath(path: string | null): ActivityFacts {
  const handle = path === null ? undefined : /\/approvals\/([^/?#]+)$/.exec(path)?.[1];
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
