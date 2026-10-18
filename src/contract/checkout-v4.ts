// The pure rules of a submitted Shop checkout (contract 1.7.0, Appendix A "Snapshot v4" and Appendix H; vectors a4,
// e3 and h1): coarse postcodes, the currency table version, the account key thumbprint, a v4 snapshot's own rules,
// and step 7 for a v4 snapshot against the CheckoutRequest the gateway sent. Pure.
import { createHash } from "node:crypto";
import { canonicalize } from "../jcs/index.ts";
import { type AccountKey, type AnySnapshot, type CheckoutRequest, type CheckoutTotals, type CurrencyCeiling, SnapshotV4 } from "./schemas.ts";

/** The countries 1.7.0 ships to; any other is refused locally (Intent Cloud would answer 400). */
export const COARSE_COUNTRIES = ["US", "CA", "AU"] as const;
export type CoarseCountry = (typeof COARSE_COUNTRIES)[number];

const COARSE_RULE: Readonly<Record<CoarseCountry, { take: number; pattern: RegExp }>> = {
  US: { take: 5, pattern: /^[0-9]{5}$/ },
  CA: { take: 3, pattern: /^[A-Z][0-9][A-Z]$/ },
  AU: { take: 4, pattern: /^[0-9]{4}$/ },
};

/**
 * `coarse(country, code)` of Appendix A: spaces and `-` removed, upper-cased, then the first 5 (US), 3 (CA) or 4 (AU)
 * characters, which must match the country's pattern; null when there is no coarse code (another country included).
 * AU takes "all 4": a longer code has no coarse form.
 */
export function coarsePostcode(country: string, code: string): string | null {
  const rule = (COARSE_RULE as Readonly<Record<string, { take: number; pattern: RegExp }>>)[country];
  if (rule === undefined) return null;
  const folded = code.replace(/[\s-]/g, "").toUpperCase();
  if (country === "AU" && folded.length !== 4) return null;
  const coarse = folded.slice(0, rule.take);
  return rule.pattern.test(coarse) ? coarse : null;
}

/** `"ct-"` + the first 16 hex characters of SHA-256(JCS(currencies)): the currency table's version. */
export function currencyTableVersion(currencies: Readonly<Record<string, CurrencyCeiling>>): string {
  return `ct-${createHash("sha256").update(canonicalize(currencies), "utf8").digest("hex").slice(0, 16)}`;
}

/** RFC 7638 thumbprint of an Ed25519 account key (Appendix H): base64url SHA-256 of {"crv","kty","x"}, no spaces. */
export function accountKeyThumbprint(key: AccountKey): string {
  const members = `{"crv":${JSON.stringify(key.crv)},"kty":${JSON.stringify(key.kty)},"x":${JSON.stringify(key.x)}}`;
  return createHash("sha256").update(members, "utf8").digest("base64url");
}

/** `continue_url_hash` of Appendix A: "sha256:" + hex SHA-256 of the URL's UTF-8. */
export function continueUrlHash(url: string): string {
  return `sha256:${createHash("sha256").update(url, "utf8").digest("hex")}`;
}

/**
 * Whether a hand-off `continue_url` may be submitted (Appendix A, v4 `continue_url_hash`; vector a4 `continue_urls`):
 * `https://` + a host exactly `shop.app`, the checkout's myshopify domain or the host of its store site, compared as
 * written (lowercase ASCII), then a path. No port (`:443` included), no userinfo, no fragment, never another host.
 */
export function continueUrlAllowed(url: string, checkout: { readonly myshopify_domain: string; readonly store_site: string }): boolean {
  const m = /^https:\/\/([a-z0-9.-]+)(\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)$/.exec(url);
  if (m === null || url.length > 2048) return false;
  const host = m[1] as string;
  const siteHost = /^https:\/\/([a-z0-9.-]+)$/.exec(checkout.store_site)?.[1];
  return host === "shop.app" || host === checkout.myshopify_domain || (siteHost !== undefined && host === siteHost);
}

/** The total the passkey approved, in its currency: v1 to v3 `total` (USD), v4 `totals.total` in `currency`. */
export function snapshotTotal(s: AnySnapshot): { readonly amount_minor: number; readonly currency: string } {
  return s.v === 4 ? { amount_minor: s.totals.total, currency: s.currency } : s.total;
}

/** The binding rule an approval's outcomes use: binding-v2 for a v4 snapshot (Appendix G), binding-v1 before. */
export function bindingRuleFor(s: AnySnapshot): "binding-v1" | "binding-v2" {
  return s.v === 4 ? "binding-v2" : "binding-v1";
}

/** `total == subtotal + shipping + tax`, with total ≥ 1, all safe integers. */
export function totalsAddUp(t: CheckoutTotals): boolean {
  const all = [t.subtotal, t.shipping, t.tax, t.total];
  return all.every((n) => Number.isSafeInteger(n) && n >= 0) && t.total >= 1 && t.subtotal + t.shipping + t.tax === t.total;
}

/**
 * Why a value is not a valid v4 snapshot (Appendix A "Snapshot v4", vector a4's `invalid`), or null when it is: the
 * schema, totals that add up, a coarse postcode of its country, and `continue_url_hash` exactly for `handoff`.
 */
export function snapshotV4Problem(value: unknown): string | null {
  const parsed = SnapshotV4.safeParse(value);
  if (!parsed.success) return "schema";
  const s = parsed.data;
  if (!totalsAddUp(s.totals)) return "totals";
  if (coarsePostcode(s.ship_to.country, s.ship_to.postal_code_coarse) !== s.ship_to.postal_code_coarse) return "ship_to";
  if ((s.completion_mode === "handoff") !== (s.continue_url_hash !== undefined)) return "continue_url_hash";
  return null;
}

/** The step 7 fields of a v4 snapshot, in e3's order. */
export const V4_FIELDS = [
  "store_name",
  "store_site",
  "myshopify_domain",
  "variant_ref",
  "title",
  "quantity",
  "currency",
  "totals",
  "checkout_ref_hash",
  "ship_to",
  "completion_mode",
  "completer_keyid",
  "account_key_thumbprint",
  "continue_url_hash",
] as const;
export type V4Field = (typeof V4_FIELDS)[number];

/**
 * Appendix E step 7 (1.7.0) for an approval from `POST /v1/checkouts`: the fields of `snapshot` that are not the
 * request the gateway sent, in e3's order, or ["v"] alone when it is not a v4 snapshot. [] means it is the request.
 */
export function checkoutRequestProblems(snapshot: unknown, request: CheckoutRequest): (V4Field | "v")[] {
  const parsed = SnapshotV4.safeParse(snapshot);
  if (!parsed.success) return ["v"];
  const s = parsed.data;
  const c = request.checkout;
  const same = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);
  const expectedContinue = request.completion_mode === "handoff" && c.continue_url !== undefined ? continueUrlHash(c.continue_url) : undefined;
  const failed: Record<V4Field, boolean> = {
    store_name: s.store_name !== c.store_name,
    store_site: s.store_site !== c.store_site,
    myshopify_domain: s.myshopify_domain !== c.myshopify_domain,
    variant_ref: s.variant_ref !== c.variant_ref,
    title: s.title !== c.title,
    quantity: s.quantity !== c.quantity,
    currency: s.currency !== c.currency,
    totals: !same(s.totals, c.totals),
    checkout_ref_hash: s.checkout_ref_hash !== c.checkout_ref_hash,
    ship_to: s.ship_to.country !== c.ship_to.country || s.ship_to.postal_code_coarse !== c.ship_to.postal_code,
    completion_mode: s.completion_mode !== request.completion_mode,
    completer_keyid: s.completer_keyid !== request.completer_keyid,
    account_key_thumbprint: s.account_key_thumbprint !== accountKeyThumbprint(request.account_key),
    continue_url_hash: s.continue_url_hash !== expectedContinue,
  };
  return V4_FIELDS.filter((f) => failed[f]);
}
