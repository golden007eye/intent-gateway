// binding-v1 (contract 1.6.0, Appendix G; vector o1): an observed order O compared with the snapshot S the passkey
// approved, in a context M. Five checks, each `match`, `differs` or `unknown`, and a result `ok`, `mismatch` or
// `incomplete`. No observed value is copied into the result. Pure.
//
// Inputs come from outside (Shop, Intent Cloud, a chain), so every observed value is typed `unknown`: a reference
// must be a JSON string and an amount or quantity a JSON integer, and anything else is `differs`, never converted.
// Parse wire JSON with parseIntegerJson (src/jcs) first, so `1.0` reaches this file as a non-number.
import { type Binding, type BindingCheck, checkoutRefHash, type CompletionMode, type SnapshotV2 } from "../contract/index.ts";

/** An observed order (Appendix G `O`). `checkout_ref` is the raw checkout id, which never leaves the checking service. */
export interface ObservedOrder {
  readonly merchant_origin?: unknown;
  readonly checkout_ref?: unknown;
  /**
   * The gateway's own extension, for re-running a binding from what its chain recorded: the checkout ref hash in place
   * of the raw id, which the chain never holds. Read only when `checkout_ref` is absent.
   */
  readonly checkout_ref_hash?: unknown;
  readonly lines?: unknown;
  readonly ship_to_postal_code?: unknown;
  readonly final_total?: unknown;
}

/** The context (Appendix G `M`). */
export interface BindingContext {
  /** `handoff` or `shop_agent`; anything else is a BindingError. A string, since a context may come from outside. */
  readonly mode: CompletionMode | (string & {});
  readonly recorded_checkout_ref_hash?: unknown;
  readonly ship_to_optional: unknown;
  /** The observed order is already bound to another approval (the one-order rule): check 2 differs. */
  readonly bound_elsewhere?: unknown;
}

export type BindingChecks = Binding["checks"];
export type BindingResult = Binding["result"];

/** A mode other than `handoff` or `shop_agent`: an error, not a check result (Appendix G). */
export class BindingError extends Error {
  override name = "BindingError";
}

/**
 * The sources table's `ship_to_optional` column (Appendix G). `merchant_api` was answered by S2 (`false`); `shop_api`
 * is PENDING S1 and is `false` until answered: the fallback publishes an unanswered cell as `false`, the strict side.
 * Every other source carries no ship-to cell, and reads as `false`.
 */
export const SHIP_TO_OPTIONAL: Readonly<Record<string, boolean>> = {
  shop_api: false,
  merchant_api: false,
  signed_webhook: false,
  staging_webhook: false,
};

export const shipToOptional = (source: string): boolean => SHIP_TO_OPTIONAL[source] ?? false;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const ORIGIN = new RegExp(`^https://(${LABEL}(?:\\.${LABEL})*)\\.?(?::443)?$`);
const HASH = /^sha256:[0-9a-f]{64}$/;
const ZIP5 = /^[0-9]{5}$/;

/**
 * The comparable form of an origin (`https://` + lowercase host), or null when it can only be `differs`: non-ASCII,
 * or anything but `"https://" host ["."] [":443"]` with LDH labels of 1 to 63 characters, the host at most 253.
 */
export function normaliseOrigin(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- ASCII is exactly U+0000 to U+007F.
  if (!/^[\x00-\x7f]*$/.test(value)) return null;
  const m = ORIGIN.exec(value.toLowerCase());
  const host = m?.[1];
  return host === undefined || host.length > 253 ? null : `https://${host}`;
}

/** Rule 25 in integers (`recheck-v1`): USD, `5·R ≥ 4·A` and `R ≤ A`, so exactly `ceil(0.8·A) ≤ R ≤ A`. */
export function totalMatches(approvedMinor: number, final: unknown): boolean {
  if (typeof final !== "object" || final === null) return false;
  const { amount_minor: r, currency } = final as { amount_minor?: unknown; currency?: unknown };
  if (currency !== "USD" || typeof r !== "number" || !Number.isSafeInteger(r) || r < 0) return false;
  return 5 * r >= 4 * approvedMinor && r <= approvedMinor;
}

/** The binding-v1 result rule over five check values. */
export function bindingResult(checks: BindingChecks, shipToIsOptional: boolean): BindingResult {
  const values = Object.values(checks);
  if (values.includes("differs")) return "mismatch";
  const core = checks.merchant_origin === "match" && checks.checkout_ref === "match" && checks.line === "match" && checks.total === "match";
  return core && (checks.ship_to === "match" || shipToIsOptional) ? "ok" : "incomplete";
}

/** binding-v1 over snapshot `s`, observed order `o` and context `m`. Throws BindingError for an unknown mode. */
export function bindingV1(s: SnapshotV2, o: ObservedOrder, m: BindingContext): Binding {
  if (m.mode !== "handoff" && m.mode !== "shop_agent") throw new BindingError(`unknown completion mode ${JSON.stringify(m.mode)}`);
  const checks: BindingChecks = {
    merchant_origin: checkOrigin(s.merchant_origin, o.merchant_origin),
    checkout_ref: checkCheckout(s, o, m),
    line: checkLine(s, o.lines),
    ship_to: checkShipTo(s, o.ship_to_postal_code),
    total: totalMatches(s.total.amount_minor, o.final_total) ? "match" : "differs",
  };
  return { rule_version: "binding-v1", result: bindingResult(checks, m.ship_to_optional === true), checks };
}

const absent = (value: unknown): boolean => value === undefined || value === null;

function checkOrigin(approved: string, observed: unknown): BindingCheck {
  if (absent(observed)) return "unknown";
  if (typeof observed !== "string") return "differs";
  const a = normaliseOrigin(approved);
  return a !== null && a === normaliseOrigin(observed) ? "match" : "differs";
}

function checkCheckout(s: SnapshotV2, o: ObservedOrder, m: BindingContext): BindingCheck {
  // One order, one approval: an order already bound elsewhere differs, whatever else is present or absent.
  if (m.bound_elsewhere === true) return "differs";
  let observed: string | null;
  if (!absent(o.checkout_ref)) {
    if (typeof o.checkout_ref !== "string") return "differs";
    // Null for an id with nothing before its "?": no checkout ref hash, so differs (Update 2 item 7).
    observed = checkoutRefHash(o.checkout_ref);
  } else if (!absent(o.checkout_ref_hash)) {
    observed = typeof o.checkout_ref_hash === "string" && HASH.test(o.checkout_ref_hash) ? o.checkout_ref_hash : null;
  } else {
    return "unknown";
  }
  if (observed === null) return "differs";
  const expected = m.mode === "handoff" ? s.checkout_ref_hash : m.recorded_checkout_ref_hash;
  if (absent(expected)) return "unknown";
  return expected === observed ? "match" : "differs";
}

function checkLine(s: SnapshotV2, lines: unknown): BindingCheck {
  if (!Array.isArray(lines) || lines.length !== 1) return "differs";
  const line: unknown = lines[0];
  if (typeof line !== "object" || line === null) return "differs";
  const { variant_ref, quantity } = line as { variant_ref?: unknown; quantity?: unknown };
  if (typeof variant_ref !== "string" || typeof quantity !== "number" || !Number.isSafeInteger(quantity)) return "differs";
  return variant_ref === s.variant_ref && quantity === s.quantity ? "match" : "differs";
}

function checkShipTo(s: SnapshotV2, code: unknown): BindingCheck {
  if (absent(code)) return "unknown";
  if (typeof code !== "string") return "differs";
  const first5 = code.slice(0, 5);
  return ZIP5.test(first5) && first5 === s.ship_to.postal_code ? "match" : "differs";
}
