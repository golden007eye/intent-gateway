// Which chain entries belong to one purchase (an approval handle). The same rule picks the entries an evidence pack
// holds from the whole chain, and checks, on the pack alone, that every entry it holds is one of them. Pure.
//
// A purchase's entries, all found from the entries themselves (nothing the exporter says about them is trusted):
// - its `approval_pending`, `approval` and `outcome` entries (body `handle`);
// - the disclosures sent for it: the cart request (its logged body is byte for byte the CartRequest the pending entry
//   chained in `sent`, Appendix E step 7), the approval request (an `observed` entry for it names the handle), the
//   status reads and outcome reports (the handle is in their path), and wallet requests (local field `purchase`);
// - the search the offer came from, when an `observed` entry of a search before the cart lists the offer: optional;
// - each of those disclosures' follow-up and `observed` entries;
// - what re-checking them needs: the gateway session entries the disclosures name (and entry 0 when it is a session
//   entry, which marks a demo chain), the approver pin in force at the approval, and the key statements in force
//   (the latest `keys` entry before each entry, and the next one after a receipt chained `verified: false`).
import { canonicalize } from "../jcs/index.ts";
import type { Entry } from "../store/index.ts";
import { readSent } from "../trust/index.ts";

/** What an entry is to the purchase. */
export type Role =
  | "approval pending"
  | "approval"
  | "outcome"
  | "search"
  | "cart request"
  | "approval request"
  | "status read"
  | "outcome report"
  | "wallet request"
  | "answer"
  | "observed"
  | "session"
  | "approver pin"
  | "key statement";

export interface Membership {
  /** The entries that belong to the purchase, by seq. */
  readonly roles: ReadonlyMap<number, Role>;
  /** What a purchase needs and the entries lack: a pending entry and an approval. */
  readonly missing: readonly string[];
}

const FOLLOW_UPS: ReadonlySet<string> = new Set(["receipt", "response", "unacknowledged", "discarded"]);

/** The entries of `entries` (a whole chain or a pack's entries, in seq order) that belong to purchase `handle`. */
export function purchaseEntries(entries: readonly Entry[], handle: string): Membership {
  const roles = new Map<number, Role>();
  const of = (kind: string) => entries.filter((e) => e.kind === kind && body(e).handle === handle);
  const pendings = of("approval_pending");
  const approvals = of("approval");
  const missing = [
    ...(pendings.length === 0 ? ["no approval_pending entry names it"] : []),
    ...(approvals.length === 0 ? ["no approval entry names it: there is no verified approval to show"] : []),
  ];
  for (const e of pendings) roles.set(e.seq, "approval pending");
  for (const e of approvals) roles.set(e.seq, "approval");
  for (const e of of("outcome")) roles.set(e.seq, "outcome");

  const observedBy = new Map<number, Record<string, unknown>>();
  for (const e of entries) if (e.kind === "observed" && typeof body(e).disclosure_seq === "number") observedBy.set(body(e).disclosure_seq as number, body(e));
  const sent = pendings.length === 0 ? null : readSent(body(pendings.at(-1) as Entry).sent);
  const cartText = sent === null ? null : canonicalize(sent.cart_request);

  const disclosures = entries.filter((e) => e.kind === "disclosure");
  for (const d of disclosures) {
    const role = disclosureRole(body(d), observedBy.get(d.seq), handle, cartText);
    if (role !== null) roles.set(d.seq, role);
  }
  // The search the offer came from: the latest one before the cart whose observation lists the offer.
  const cartSeq = disclosures.find((d) => roles.get(d.seq) === "cart request")?.seq;
  if (sent !== null && cartSeq !== undefined) {
    const offer = sent.cart_request.offer_handle;
    const search = disclosures.findLast((d) => {
      const seen = observedBy.get(d.seq);
      return d.seq < cartSeq && body(d).endpoint === "searchCatalog" && seen?.endpoint === "searchCatalog" && listsOffer(seen.offers, offer);
    });
    if (search !== undefined) roles.set(search.seq, "search");
  }

  const chosen = new Set(disclosures.filter((d) => roles.has(d.seq)).map((d) => d.seq));
  const sessions = new Set(disclosures.filter((d) => chosen.has(d.seq)).map((d) => record(body(d).session).id));
  for (const e of entries) {
    const b = body(e);
    if ((FOLLOW_UPS.has(e.kind) || e.kind === "observed") && typeof b.disclosure_seq === "number" && chosen.has(b.disclosure_seq)) {
      roles.set(e.seq, e.kind === "observed" ? "observed" : "answer");
    }
    if (e.kind === "session" && (e.seq === 0 || (typeof b.id === "string" && sessions.has(b.id)))) roles.set(e.seq, "session");
  }
  for (const a of approvals) {
    const pin = entries.findLast((e) => e.kind === "approver_pin" && e.seq < a.seq);
    if (pin !== undefined) roles.set(pin.seq, "approver pin");
  }
  // The key statements in force for every entry chosen so far.
  const keys = entries.filter((e) => e.kind === "keys");
  for (const e of entries.filter((x) => roles.has(x.seq))) {
    const before = keys.findLast((k) => k.seq < e.seq);
    if (before !== undefined) roles.set(before.seq, "key statement");
    if (e.kind === "receipt" && body(e).verified === false) {
      const after = keys.find((k) => k.seq > e.seq);
      if (after !== undefined) roles.set(after.seq, "key statement");
    }
  }
  return { roles, missing };
}

function disclosureRole(b: Record<string, unknown>, seen: Record<string, unknown> | undefined, handle: string, cartText: string | null): Role | null {
  const path = typeof b.path === "string" ? b.path : "";
  if (path === `/v1/approvals/${handle}`) return "status read";
  if (path.startsWith(`/v1/approvals/${handle}/`)) return "outcome report";
  if (b.purchase === handle) return "wallet request";
  if (b.endpoint === "createApproval" && seen?.endpoint === "createApproval" && seen.approval_handle === handle) return "approval request";
  if (cartText !== null && b.endpoint === "createCart" && typeof b.body_b64 === "string" && Buffer.from(b.body_b64, "base64").toString("utf8") === cartText) {
    return "cart request";
  }
  return null;
}

function listsOffer(offers: unknown, handle: string): boolean {
  return Array.isArray(offers) && offers.some((o) => record(o).offer_handle === handle);
}

function body(entry: Entry): Record<string, unknown> {
  return record(entry.body);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
