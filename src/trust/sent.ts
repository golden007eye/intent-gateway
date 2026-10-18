// Appendix E step 7 (contract 1.6.1; vector e2-snapshot-v2-request): the snapshot the passkey signed must be the
// purchase this gateway asked for and was offered. Checked locally, both when the approval is requested and when it is
// accepted, against what the gateway chains in its `approval_pending` entry (`sent`: the contract version it spoke,
// its own CartRequest, and what it received in the Offer and the Cart). A 1.6.1 gateway takes only a v3 snapshot, whose
// `myshopify_domain` must equal the offer's and the cart's (or be absent from all three); a `sent` chained by a 1.6.0
// gateway names no version and takes only v2, so `intent verify` still checks those chains. Pure.
import { z } from "zod";
import { type AnySnapshot, CartRequest, Merchant, MerchantOrigin, Money, MyshopifyDomain, Timestamp, VariantRef } from "../contract/index.ts";

/** e2's input without the snapshot: the version spoken, the gateway's own CartRequest, the Offer and the Cart received. */
export const SentPurchase = z.strictObject({
  /** The contract version the cart was made in; absent in entries a 1.6.0 gateway chained. */
  contract_version: z.enum(["1.6.0", "1.6.1"]).optional(),
  cart_request: CartRequest,
  offer: z.strictObject({ variant_ref: VariantRef, merchant: Merchant, myshopify_domain: MyshopifyDomain.optional() }),
  cart: z.strictObject({
    merchant_origin: MerchantOrigin,
    variant_ref: VariantRef,
    total: Money,
    expires_at: Timestamp,
    myshopify_domain: MyshopifyDomain.optional(),
  }),
});
export type SentPurchase = z.infer<typeof SentPurchase>;

/** The refused fields, in e2's order. */
export const SENT_FIELDS = [
  "quantity",
  "ship_to",
  "completer_keyid",
  "completion_mode",
  "variant_ref",
  "merchant_origin",
  "total",
  "expires_at",
  "myshopify_domain",
] as const;
/** A refused field, or `v`: the snapshot is not the version the gateway speaks (checked first, alone). */
export type SentReason = (typeof SENT_FIELDS)[number] | "v";

/** The snapshot version each contract version takes (Appendix E step 7). */
const SNAPSHOT_VERSION = { "1.6.0": 2, "1.6.1": 3 } as const;

/**
 * The snapshot's fields that are not the purchase in `sent`, in e2's order, or [] when it is (Appendix E step 7): the
 * version first (a v2 snapshot for 1.6.0, v3 for 1.6.1; anything else is `v` alone); then quantity and
 * ship_to.postal_code = the CartRequest's; completer_keyid = the one sent; completion_mode ∈ completion_accepts
 * (absent means [handoff]); variant_ref = the offer's and the cart's; merchant_origin = "https://" + the offer's
 * merchant domain = the cart's; total = the cart's; expires_at no later than the cart's; and (1.6.1) myshopify_domain =
 * the offer's = the cart's, or absent from all three. A v1 snapshot binds none of these and is always refused.
 */
export function sentProblems(snapshot: AnySnapshot, sent: SentPurchase): SentReason[] {
  const version = sent.contract_version ?? "1.6.0";
  if (snapshot.v === 1 || snapshot.v !== SNAPSHOT_VERSION[version]) return ["v"];
  const request = sent.cart_request;
  const signedDomain = snapshot.v === 3 ? snapshot.myshopify_domain : undefined;
  const failed: Record<(typeof SENT_FIELDS)[number], boolean> = {
    quantity: snapshot.quantity !== request.quantity,
    ship_to: snapshot.ship_to.postal_code !== request.ship_to.postal_code,
    completer_keyid: snapshot.completer_keyid !== request.completer_keyid,
    completion_mode: !(request.completion_accepts ?? ["handoff"]).includes(snapshot.completion_mode),
    variant_ref: snapshot.variant_ref !== sent.offer.variant_ref || snapshot.variant_ref !== sent.cart.variant_ref,
    merchant_origin: snapshot.merchant_origin !== `https://${sent.offer.merchant.domain}` || snapshot.merchant_origin !== sent.cart.merchant_origin,
    total: snapshot.total.amount_minor !== sent.cart.total.amount_minor, // Money is USD only (the schema)
    // Compared as instants; one that is not a real instant (2026-02-30, 24:00) fails closed.
    expires_at: !(instant(snapshot.expires_at) <= instant(sent.cart.expires_at)),
    // A value on one side only is a failure: a Shopify store's pair must be signed as offered.
    myshopify_domain: version === "1.6.1" && (signedDomain !== sent.offer.myshopify_domain || signedDomain !== sent.cart.myshopify_domain),
  };
  return SENT_FIELDS.filter((field) => failed[field]);
}

/**
 * A Timestamp (`YYYY-MM-DDTHH:MM:SSZ`) as milliseconds since the epoch, or NaN when it names no real instant. Stricter
 * than Date.parse, which rolls some impossible dates over instead of refusing them.
 */
export function instant(timestamp: string): number {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/.exec(timestamp);
  if (m === null) return Number.NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(ms).toISOString() === `${timestamp.slice(0, -1)}.000Z` ? ms : Number.NaN;
}

/** The words for a reason, for refusals the developer and the agent read. */
export const SENT_WORDS: Readonly<Record<SentReason, string>> = {
  v: "snapshot is not the version this gateway speaks (contract 1.6.1 takes only snapshot v3)",
  quantity: "quantity is not the quantity requested",
  ship_to: "ship_to differs from the ZIP sent",
  completer_keyid: "completer_keyid is not the key this gateway made for the cart",
  completion_mode: "completion_mode is not one the cart request offered",
  variant_ref: "variant_ref is not the offer's and the cart's",
  merchant_origin: "merchant_origin is not https:// + the offer's merchant domain and the cart's",
  total: "total is not the cart's",
  expires_at: "expires_at is later than the cart's",
  myshopify_domain: "myshopify_domain is not the offer's and the cart's",
};

/** Parses a chained `sent`; null when absent or malformed. */
export function readSent(value: unknown): SentPurchase | null {
  const parsed = SentPurchase.safeParse(value);
  return parsed.success ? parsed.data : null;
}
