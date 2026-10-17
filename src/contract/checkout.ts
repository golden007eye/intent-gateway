// The checkout ref hash (contract 1.6.0 hardening amendment L1, item 7): "sha256:" + hex(SHA-256(utf8(id))) over the
// checkout id up to but excluding its first "?", so a checkout URL's query (a Shopify `?key=…`) never decides the
// binding and never has to be kept to recompute it. An id with nothing before its "?" (or an empty one) names no
// checkout and has no hash: null, which a binding check reads as `differs`. Pure.
import { createHash } from "node:crypto";

export function checkoutRefHash(checkoutId: string): string | null {
  const cut = checkoutId.indexOf("?");
  const id = cut === -1 ? checkoutId : checkoutId.slice(0, cut);
  if (id === "") return null;
  return `sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}
