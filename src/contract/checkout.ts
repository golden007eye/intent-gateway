// The checkout ref hash (contract 1.6.0 hardening amendment L1): "sha256:" + hex(SHA-256(utf8(id))) over the checkout
// id up to but excluding its first "?", so a checkout URL's query (a Shopify `?key=…`) never decides the binding and
// never has to be kept to recompute it. Used for a snapshot's checkout_ref_hash in both modes. Pure.
import { createHash } from "node:crypto";

export function checkoutRefHash(checkoutId: string): string {
  const cut = checkoutId.indexOf("?");
  const id = cut === -1 ? checkoutId : checkoutId.slice(0, cut);
  return `sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}
