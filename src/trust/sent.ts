// Appendix E step 7 for a v2 snapshot (contract 1.6.0 hardening amendment H2; vector e2-snapshot-v2-request): the
// snapshot the passkey signed must be the purchase this gateway asked for and was offered. Checked locally, both when
// the approval is requested and when it is accepted, against what the gateway chains in its `approval_pending` entry
// (`sent`: its own CartRequest, the Offer's variant and the Cart it received). Pure.
import { z } from "zod";
import { type AnySnapshot, CartRequest, Merchant, MerchantOrigin, Money, Timestamp, VariantRef } from "../contract/index.ts";

/** e2's input: the gateway's own CartRequest, and what it received in the Offer and the Cart. */
export const SentPurchase = z.strictObject({
  cart_request: CartRequest,
  offer: z.strictObject({ variant_ref: VariantRef, merchant: Merchant }),
  cart: z.strictObject({ merchant_origin: MerchantOrigin, variant_ref: VariantRef, total: Money, expires_at: Timestamp }),
});
export type SentPurchase = z.infer<typeof SentPurchase>;

/** The refused fields, in e2's order. */
export const SENT_FIELDS = ["quantity", "ship_to", "completer_keyid", "completion_mode", "variant_ref", "merchant_origin", "total", "expires_at"] as const;
export type SentReason = (typeof SENT_FIELDS)[number] | "snapshot_version";

/**
 * The snapshot's fields that are not the purchase in `sent`, in e2's order, or [] when it is (Appendix E step 7):
 * quantity and ship_to.postal_code = the CartRequest's; completer_keyid = the one sent; completion_mode ∈
 * completion_accepts (absent means [handoff]); variant_ref = the offer's and the cart's; merchant_origin =
 * "https://" + the offer's merchant domain = the cart's; total = the cart's; expires_at no later than the cart's.
 * A v1 snapshot binds none of these and is always refused.
 */
export function sentProblems(snapshot: AnySnapshot, sent: SentPurchase): SentReason[] {
  if (snapshot.v !== 2) return ["snapshot_version"];
  const request = sent.cart_request;
  const failed: Record<(typeof SENT_FIELDS)[number], boolean> = {
    quantity: snapshot.quantity !== request.quantity,
    ship_to: snapshot.ship_to.postal_code !== request.ship_to.postal_code,
    completer_keyid: snapshot.completer_keyid !== request.completer_keyid,
    completion_mode: !(request.completion_accepts ?? ["handoff"]).includes(snapshot.completion_mode),
    variant_ref: snapshot.variant_ref !== sent.offer.variant_ref || snapshot.variant_ref !== sent.cart.variant_ref,
    merchant_origin: snapshot.merchant_origin !== `https://${sent.offer.merchant.domain}` || snapshot.merchant_origin !== sent.cart.merchant_origin,
    total: snapshot.total.amount_minor !== sent.cart.total.amount_minor, // Money is USD only (the schema)
    // Both are RFC 3339 UTC with seconds and Z (the Timestamp schema), so they compare as instants.
    expires_at: !(Date.parse(snapshot.expires_at) <= Date.parse(sent.cart.expires_at)),
  };
  return SENT_FIELDS.filter((field) => failed[field]);
}

/** The words for a reason, for refusals the developer and the agent read. */
export const SENT_WORDS: Readonly<Record<SentReason, string>> = {
  snapshot_version: "snapshot is v1, which binds only a ZIP prefix; a 1.6.0 host sends v2",
  quantity: "quantity is not the quantity requested",
  ship_to: "ship_to differs from the ZIP sent",
  completer_keyid: "completer_keyid is not the key this gateway made for the cart",
  completion_mode: "completion_mode is not one the cart request offered",
  variant_ref: "variant_ref is not the offer's and the cart's",
  merchant_origin: "merchant_origin is not https:// + the offer's merchant domain and the cart's",
  total: "total is not the cart's",
  expires_at: "expires_at is later than the cart's",
};

/** Parses a chained `sent`; null when absent or malformed. */
export function readSent(value: unknown): SentPurchase | null {
  const parsed = SentPurchase.safeParse(value);
  return parsed.success ? parsed.data : null;
}
