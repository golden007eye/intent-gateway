// Observations: the `observed` chain entry, a small local summary of what Intent Cloud returned for one request
// with a verified receipt (the receipt covers the request and its status, not the body summarised here). The gateway writes it after the receipt; `intent log` and the panel read it to
// show what came back (offers, the cart, the approval state); `intent verify` checks its shape and its reference.
//
// An observation is not a disclosure: nothing in it leaves the machine, and it never answers a request (only a
// receipt, unacknowledged or discarded entry does). It holds Intent Cloud's content only, never the buyer's: before
// it is written, findIdentity runs over it, and any value that looks like buyer identity is replaced with WITHHELD
// and its path listed in `withheld` (invariant 3: what we never hold, we cannot leak). Pure; no I/O.
import { z } from "zod";
import { type ApprovalCreated, type ApprovalStatus, type Cart, CompletionMode, OutcomeSource, OutcomeState, type SearchResponse } from "../contract/index.ts";
import { findIdentity, ORDER_REF_AT } from "../privacy/index.ts";

/** At most this many offers of a search are kept in its observation; `offers_count` still counts them all. */
export const OBSERVED_OFFERS_MAX = 10;
/** The outcome's order gid is not read as a card (ADR-0019): its order number passes Luhn about one time in ten. */
const ORDER_REFS = { orderRefAt: ORDER_REF_AT.observation };
/** What replaces a value findIdentity flagged. */
export const WITHHELD = "[withheld]";

const Seq = z.int().min(0);
const Minor = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const Text = z.string().min(1).max(253);
const State = z.enum(["pending", "approved", "rejected", "expired", "handed_off", "ordered"]);
const Withheld = z.array(z.string().max(200)).max(100).optional();

export const ObservedOffer = z.strictObject({
  offer_handle: Text,
  title: Text,
  merchant: Text,
  price_minor: Minor,
  shipping_minor: Minor,
  currency: z.literal("USD"),
});
export type ObservedOffer = z.infer<typeof ObservedOffer>;

/** The body of an `observed` entry, by the endpoint of the request it answers (`disclosure_seq`). */
export const ObservedBody = z.discriminatedUnion("endpoint", [
  z.strictObject({
    disclosure_seq: Seq,
    endpoint: z.literal("searchCatalog"),
    /** How many offers Intent Cloud returned. */
    offers_count: z.int().min(0).max(1000),
    /** How many of them the gateway policy hid from the agent. */
    offers_hidden: z.int().min(0).max(1000),
    offers: z.array(ObservedOffer).max(OBSERVED_OFFERS_MAX),
    withheld: Withheld,
  }),
  z.strictObject({
    disclosure_seq: Seq,
    endpoint: z.literal("createCart"),
    title: Text,
    merchant: Text,
    quantity: z.int().min(1).max(3),
    total_minor: Minor,
    currency: z.literal("USD"),
    /** 1.6.0: how the purchase completes, the merchant origin and whether the total is an estimate. */
    completion_mode: CompletionMode.optional(),
    // Any text up to an origin's length, so a value withheld as "[withheld]" still parses.
    merchant_origin: z.string().min(1).max(261).optional(),
    total_estimated: z.boolean().optional(),
    withheld: Withheld,
  }),
  z.strictObject({
    disclosure_seq: Seq,
    endpoint: z.literal("createApproval"),
    approval_handle: Text,
    state: State,
    title: Text,
    merchant: Text,
    quantity: z.int().min(1).max(3),
    total_minor: Minor,
    currency: z.literal("USD"),
    withheld: Withheld,
  }),
  z.strictObject({
    disclosure_seq: Seq,
    endpoint: z.literal("getApproval"),
    approval_handle: Text,
    state: State,
    /** 1.6.0: the outcome's state, as Intent Cloud reported it (the completer key's retention reads it). */
    outcome_state: OutcomeState.optional(),
    /**
     * 1.6.0: a summary of the outcome as Intent Cloud served it, before any check: its words, the order it names and
     * the binding result it states. What the gateway concluded is the `outcome` entry, not this.
     */
    outcome: z
      .strictObject({
        state: OutcomeState,
        source: OutcomeSource,
        assurance: z.enum(["verified", "reported"]),
        order_ref: z.string().min(1).max(64).optional(),
        final_total_minor: Minor.optional(),
        binding_result: z.enum(["ok", "mismatch", "incomplete"]).optional(),
      })
      .optional(),
    /** The merchant's order number Intent Cloud returned (before 1.6.0, and beside an outcome). */
    order_number: z.string().min(1).max(40).optional(),
    title: Text,
    merchant: Text,
    total_minor: Minor,
    currency: z.literal("USD"),
    withheld: Withheld,
  }),
]);
export type ObservedBody = z.infer<typeof ObservedBody>;

/** The endpoints an observation can answer. */
export const OBSERVED_ENDPOINTS: ReadonlySet<string> = new Set(["searchCatalog", "createCart", "createApproval", "getApproval"]);

/** A search's observation: the count, the offers (at most OBSERVED_OFFERS_MAX) and how many the policy hid. */
export function observeSearch(disclosureSeq: number, response: SearchResponse, hidden: number): ObservedBody {
  return guarded({
    disclosure_seq: disclosureSeq,
    endpoint: "searchCatalog",
    offers_count: response.offers.length,
    offers_hidden: hidden,
    offers: response.offers.slice(0, OBSERVED_OFFERS_MAX).map((o) => ({
      offer_handle: o.offer_handle,
      title: o.title,
      merchant: o.merchant.name,
      price_minor: o.price.amount_minor,
      shipping_minor: o.shipping.amount_minor,
      currency: o.price.currency,
    })),
  });
}

export function observeCart(disclosureSeq: number, cart: Cart): ObservedBody {
  return guarded({
    disclosure_seq: disclosureSeq,
    endpoint: "createCart",
    title: cart.item.title,
    merchant: cart.merchant.name,
    quantity: cart.quantity,
    total_minor: cart.total.amount_minor,
    currency: cart.total.currency,
    ...(cart.completion_mode === undefined ? {} : { completion_mode: cart.completion_mode }),
    ...(cart.merchant_origin === undefined ? {} : { merchant_origin: cart.merchant_origin }),
    ...(cart.total_estimated === undefined ? {} : { total_estimated: cart.total_estimated }),
  });
}

export function observeApproval(disclosureSeq: number, created: ApprovalCreated): ObservedBody {
  const s = created.snapshot;
  return guarded({
    disclosure_seq: disclosureSeq,
    endpoint: "createApproval",
    approval_handle: created.approval_handle,
    state: created.state,
    title: s.item.title,
    merchant: s.merchant.name,
    quantity: s.quantity,
    total_minor: s.total.amount_minor,
    currency: s.total.currency,
  });
}

export function observeStatus(disclosureSeq: number, handle: string, status: ApprovalStatus): ObservedBody {
  return guarded({
    disclosure_seq: disclosureSeq,
    endpoint: "getApproval",
    approval_handle: handle,
    state: status.state,
    ...(status.outcome === undefined ? {} : { outcome_state: status.outcome.state, outcome: outcomeSummary(status.outcome) }),
    ...(status.order_number === undefined ? {} : { order_number: status.order_number }),
    title: status.display.title,
    merchant: status.display.merchant,
    total_minor: status.display.total.amount_minor,
    currency: status.display.total.currency,
  });
}

/** Read by a constant key: src/ lint forbids naming a property `binding` (it would also match `process.binding`). */
const BINDING = "binding";

function outcomeSummary(o: NonNullable<ApprovalStatus["outcome"]>) {
  const result = o[BINDING]?.result;
  return {
    state: o.state,
    source: o.source,
    assurance: o.assurance,
    ...(o.order_ref === undefined ? {} : { order_ref: o.order_ref }),
    ...(o.final_total === undefined ? {} : { final_total_minor: o.final_total.amount_minor }),
    ...(result === undefined ? {} : { binding_result: result }),
  };
}

/** Why `body` is not a valid observation (its shape, or buyer identity in it), or null. */
export function observationProblem(body: unknown): string | null {
  const parsed = ObservedBody.safeParse(body);
  if (!parsed.success) return `is not an observation (${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")})`;
  const found = findIdentity(body, ORDER_REFS);
  if (found.length > 0) return `holds what looks like buyer identity (${found.map((f) => `${f.kind} at ${f.path}`).join(", ")})`;
  return null;
}

/**
 * Whether the value at `path` (`$.total_minor`, `$.offers[0].price_minor`) was withheld: its path, or a container
 * holding it (a split card across an offer's numbers withholds `$.offers[0]`), is listed in `withheld`. A withheld
 * number is stored as 0, so a reader shows "withheld" for it, never the 0.
 */
export function withheldAt(withheld: readonly string[] | undefined, path: string): boolean {
  return (withheld ?? []).some((w) => path === w || path.startsWith(`${w}.`) || path.startsWith(`${w}[`));
}

/** Replaces each value findIdentity flags with WITHHELD and lists its path; the keys are fixed, so only values can be. */
function guarded(body: ObservedBody): ObservedBody {
  const findings = findIdentity(body, ORDER_REFS);
  if (findings.length === 0) return body;
  const copy = structuredClone(body) as Record<string, unknown>;
  const withheld: string[] = [];
  for (const { path } of findings) {
    if (withheld.includes(path)) continue;
    withheld.push(path);
    replaceAt(copy, path);
  }
  const result = ObservedBody.parse({ ...copy, withheld: withheld.sort() });
  // A finding the replacement did not clear (a container-level split card) withholds every number under it.
  if (findIdentity(result, ORDER_REFS).length > 0) throw new Error("an observation still looks like buyer identity after withholding");
  return result;
}

/** Sets the value at a findIdentity path (`$.offers[0].title`) to WITHHELD; a number becomes 0 (readers check withheldAt), a container is left. */
function replaceAt(root: Record<string, unknown>, path: string): void {
  const steps = [...path.slice(1).matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)].map((m): string | number => m[1] ?? Number(m[2]));
  const last = steps.pop();
  if (last === undefined) return;
  let node: unknown = root;
  for (const step of steps) node = (node as Record<string | number, unknown> | undefined)?.[step];
  if (typeof node !== "object" || node === null) return;
  const holder = node as Record<string | number, unknown>;
  const value = holder[last];
  if (typeof value === "string") holder[last] = WITHHELD;
  else if (typeof value === "number") holder[last] = 0;
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) if (typeof item === "number") (value as Record<string, unknown>)[key] = 0;
  }
}
