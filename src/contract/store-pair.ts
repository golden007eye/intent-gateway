// The store pair check (contract 1.6.1, Appendix G "Store pair check"; vector o5): before its `completing` report, a
// completer of a v3 snapshot that carries `myshopify_domain` verifies the pair (merchant_origin, myshopify_domain)
// against the storefront itself, because the passkey signs the pair but the buyer sees only the storefront.
//
//   GET <merchant_origin>/meta.json   no cookies, credentials, Authorization or buyer data; nothing else
//
// metaUrl refuses an origin that names no public site by its form; storePairProblem decides on what the fetcher read,
// in the vector's order. The fetcher (src/storefront) refuses names that resolve to non-public addresses, follows no
// redirect and stops reading past STORE_PAIR_LIMITS.maxBodyBytes. Pure.
import { MerchantOrigin, MyshopifyDomain } from "./schemas.ts";

export const STORE_PAIR_LIMITS = Object.freeze({
  /** The whole request: connect, headers and body. */
  timeoutMs: 5_000,
  /** Counted on the bytes read: a reader stops at maxBodyBytes + 1. */
  maxBodyBytes: 64 * 1024,
  /** The most a passing result may be kept. */
  cacheTtlMs: 24 * 3600 * 1000,
});

/** The failing rule, as vector o5 names it, in the order the checks run; `fetch_failed` for a network error or a timeout. */
export type StorePairReason =
  | "not_https"
  | "bad_origin"
  | "not_public"
  | "bad_domain"
  | "redirect"
  | "status"
  | "content_type"
  | "too_large"
  | "not_json"
  | "not_object"
  | "missing"
  | "not_string"
  | "non_ascii"
  | "differs"
  | "fetch_failed";

/** What the fetcher read for `GET metaUrl(origin)`: the status, the Content-Type and at most maxBodyBytes + 1 bytes. */
export interface MetaAnswer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

// A last label that "ends in a number" (WHATWG URL): all digits, or 0x and hex digits (127.0.0.0x1 resolves to
// 127.0.0.1 through getaddrinfo).
const NUMERIC_LABEL = /^(?:[0-9]+|0[xX][0-9a-fA-F]*)$/;
// eslint-disable-next-line no-control-regex -- ASCII is exactly U+0000 to U+007F.
const ASCII = /^[\x00-\x7f]*$/;

/** `<merchant_origin>/meta.json`, or the reason no request may be made for this origin. */
export function metaUrl(merchantOrigin: string): { url: string } | { reason: StorePairReason } {
  if (!merchantOrigin.toLowerCase().startsWith("https://")) return { reason: "not_https" };
  if (!ASCII.test(merchantOrigin) || !MerchantOrigin.safeParse(merchantOrigin).success) return { reason: "bad_origin" };
  const labels = merchantOrigin.slice("https://".length).split(".");
  const last = labels.at(-1) ?? "";
  if (labels.length < 2 || NUMERIC_LABEL.test(last) || last === "localhost") return { reason: "not_public" };
  return { url: `${merchantOrigin}/meta.json` };
}

/** A valid expected domain: one LDH label + `.myshopify.com`, lowercase ASCII (Appendix A v3). */
export const isMyshopifyDomain = (value: string): boolean => ASCII.test(value) && MyshopifyDomain.safeParse(value).success;

/** Whether the request may be made at all: the origin's form and the expected domain, checked before any fetch. */
export function storePairPrecondition(merchantOrigin: string, myshopifyDomain: string): { url: string } | { reason: StorePairReason } {
  const target = metaUrl(merchantOrigin);
  if ("reason" in target) return target;
  return isMyshopifyDomain(myshopifyDomain) ? target : { reason: "bad_domain" };
}

/**
 * Why the answer to `GET metaUrl(merchantOrigin)` does not name `myshopifyDomain`, or null when it does. The checks
 * run in vector o5's order: the origin, the expected domain, the status (a 3xx is `redirect`, never followed), the
 * media type (application/json, case-insensitive, parameters allowed), the size, the JSON (invalid UTF-8, a BOM, an
 * empty body or a duplicate member name is `not_json`), an object, then the member: present, a string, ASCII only
 * (never normalised) and, lowercased, exactly the expected domain.
 */
export function storePairProblem(merchantOrigin: string, myshopifyDomain: string, answer: MetaAnswer): StorePairReason | null {
  const target = storePairPrecondition(merchantOrigin, myshopifyDomain);
  if ("reason" in target) return target.reason;
  if (answer.status >= 300 && answer.status < 400) return "redirect";
  if (answer.status !== 200) return "status";
  if (answer.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return "content_type";
  if (answer.body.length > STORE_PAIR_LIMITS.maxBodyBytes) return "too_large";
  let doc: unknown;
  try {
    // fatal: invalid UTF-8 is refused; ignoreBOM: a BOM is kept in the text, so JSON.parse refuses it.
    doc = parseUniqueJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(answer.body));
  } catch {
    return "not_json";
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "not_object";
  if (!Object.hasOwn(doc, "myshopify_domain")) return "missing";
  const value = (doc as Record<string, unknown>).myshopify_domain;
  if (typeof value !== "string") return "not_string";
  if (!ASCII.test(value)) return "non_ascii";
  return value.toLowerCase() === myshopifyDomain ? null : "differs";
}

/**
 * JSON.parse, refusing an object with a duplicate member name (parsers disagree on which one wins, so the check
 * fails closed). The text is first validated by JSON.parse; the scan then only tracks strings and nesting.
 */
export function parseUniqueJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const frames: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = frames.at(-1);
    if (c === "{") frames.push({ keys: new Set(), expectKey: true });
    else if (c === "[") frames.push({ keys: null, expectKey: false });
    else if (c === "}" || c === "]") frames.pop();
    else if (c === ",") {
      if (top?.keys !== null && top !== undefined) top.expectKey = true;
    } else if (c === ":") {
      if (top !== undefined) top.expectKey = false;
    } else if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (top?.keys !== null && top !== undefined && top.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) throw new SyntaxError("duplicate member name");
        top.keys.add(key);
      }
      i = end;
    }
  }
  return value;
}
