// Credentials in a logged request (ADR-0014): what the disclosure core digests before the log append, and what
// `intent verify` refuses to find unredacted in any disclosure.
//
// - A credential header: one of CREDENTIAL_HEADERS, compared case-insensitively.
// - A secret key: a body key at any depth (holding anything but null), or a query parameter name, whose words
//   (split on `_`, `-`, spaces and camelCase, lower-cased, joined with `_`) are one of SECRET_KEYS:
//   `accessToken`, `Refresh_Token` and `api-key` are secret keys. So is every key whose last word is `token` or
//   `bearer` (`session_token`, `authToken`, `bearer`; ADR-0017): a compound token name is still a token. `code` is
//   one only beside an OAuth sibling (`grant_type`, `redirect_uri`, `code_verifier` or `client_id`), so a product or
//   promo `code` is not.
// - A body is JSON, or a form (`content-type: application/x-www-form-urlencoded`, as OAuth endpoints take) read as
//   {name: value}; bodyValue reads both the same way for the disclosure core and for `intent verify`.
// A redacted value is the text `[redacted sha256:<hex>]`, where hex is the sha256 of the value as sent (a string's
// UTF-8 bytes; any other value's JSON text). Paths into the logged request read `headers.<name>` or
// `body.<path>`, where a path is a run of `.key` (key of letters, digits, `_`, `$` or `-`), `["any key"]` (JSON
// string) and `[n]` (array index): `body.params.arguments.refresh_token`, `body.items[0]["a.b"]`.
import { createHash } from "node:crypto";

export const CREDENTIAL_HEADERS: readonly string[] = ["authorization", "proxy-authorization", "cookie", "x-api-key"];
export const SECRET_KEYS: readonly string[] = [
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "device_code",
  "code_verifier",
  "client_secret",
  "client_assertion",
  "password",
  "api_key",
];
/** A key whose last word is one of these is secret too (`session_token`, `authToken`, `x_bearer`). */
const SECRET_LAST_WORDS: readonly string[] = ["token", "bearer"];
/** Keys beside which `code` is an OAuth authorization code. */
const OAUTH_SIBLINGS: readonly string[] = ["grant_type", "redirect_uri", "code_verifier", "client_id"];

const MARKER = /^\[redacted sha256:([0-9a-f]{64})\]$/;

/** The sha256 hex of a value as sent: a string's UTF-8 bytes, any other value's JSON text. */
export function secretDigest(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value), "utf8")
    .digest("hex");
}

/** `[redacted sha256:<hex>]` for a digest. */
export function redactionMarker(sha256: string): string {
  return `[redacted sha256:${sha256}]`;
}

/** The digest a redaction marker names, or null when `value` is not one. */
export function markerDigest(value: unknown): string | null {
  return typeof value === "string" ? (MARKER.exec(value)?.[1] ?? null) : null;
}

/** A key as words joined by `_`: `accessToken`, `Access-Token` and `ACCESS_TOKEN` are all `access_token`. */
function normalKey(key: string): string {
  return key
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1_$2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((w) => w !== "")
    .join("_");
}

/** Whether `key` names a secret; `siblings` are the other keys of the same object (or query), for `code`. */
export function isSecretKey(key: string, siblings: readonly string[] = []): boolean {
  const normal = normalKey(key);
  if (SECRET_KEYS.includes(normal) || SECRET_LAST_WORDS.includes(normal.split("_").at(-1) ?? "")) return true;
  return normal === "code" && siblings.some((s) => OAUTH_SIBLINGS.includes(normalKey(s)));
}

/** The names of the query parameters of `path` that are secret keys (for the log: names only, never values). */
export function secretQueryKeys(path: string): string[] {
  const query = path.includes("?") ? path.slice(path.indexOf("?") + 1).split("#")[0] ?? "" : "";
  const names = query
    .split("&")
    .filter((part) => part !== "")
    .map((part) => {
      const raw = part.split("=")[0] ?? "";
      try {
        return decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        return raw;
      }
    });
  return names.filter((name) => isSecretKey(name, names));
}

export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.includes(name.toLowerCase());
}

export type PathSegment = string | number;

/** `.key`, `["key"]` or `[n]` per segment, after `prefix`. */
export function formatPath(prefix: string, segments: readonly PathSegment[]): string {
  return (
    prefix +
    segments.map((s) => (typeof s === "number" ? `[${String(s)}]` : /^[A-Za-z0-9_$-]+$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join("")
  );
}

/** The segments of a path written by formatPath (without its prefix), or null when it is not one. */
export function parsePath(path: string): PathSegment[] | null {
  const segments: PathSegment[] = [];
  let rest = path;
  while (rest !== "") {
    const key = /^\.([A-Za-z0-9_$-]+)/.exec(rest);
    const index = /^\[(0|[1-9][0-9]{0,8})\]/.exec(rest);
    const quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
    if (key?.[1] !== undefined) segments.push(key[1]);
    else if (index?.[1] !== undefined) segments.push(Number(index[1]));
    else if (quoted?.[1] !== undefined) segments.push(JSON.parse(quoted[1]) as string);
    else return null;
    rest = rest.slice((key ?? index ?? quoted)?.[0].length ?? rest.length);
  }
  return segments;
}

/** Whether a value is present at `segments`, and what it is. */
export function valueAt(root: unknown, segments: readonly PathSegment[]): { found: boolean; value: unknown } {
  let node = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(node) || segment >= node.length) return { found: false, value: undefined };
      node = (node as unknown[])[segment];
    } else {
      if (typeof node !== "object" || node === null || Array.isArray(node) || !Object.hasOwn(node, segment)) return { found: false, value: undefined };
      node = (node as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: node };
}

/**
 * Whether `at` (`headers.<name>` or `body.<path>`) names, in a logged request, a value that is the redaction marker
 * for `sha256`. `body` is the logged body parsed as JSON.
 */
export function redactionHeld(logged: { headers: readonly (readonly [string, string])[]; body: unknown }, at: string, sha256: string): boolean {
  if (at.startsWith("headers.")) {
    const name = at.slice("headers.".length);
    return logged.headers.some(([key, value]) => key === name && markerDigest(value) === sha256);
  }
  if (!at.startsWith("body")) return false;
  const segments = parsePath(at.slice("body".length));
  if (segments === null || segments.length === 0) return false;
  const found = valueAt(logged.body, segments);
  return found.found && markerDigest(found.value) === sha256;
}

/** The path of every secret key holding something other than null or a redaction marker, as `body.<path>`. */
export function unredactedSecrets(body: unknown, segments: PathSegment[] = [], out: string[] = []): string[] {
  if (segments.length > SCAN_DEPTH) {
    // Too deep to walk without risking the stack: reported as a credential, so a hand-edited chain cannot hide one there.
    out.push(`${formatPath("body", segments)} (nested deeper than ${String(SCAN_DEPTH)} levels, not checked)`);
  } else if (Array.isArray(body)) {
    (body as unknown[]).forEach((item, i) => unredactedSecrets(item, [...segments, i], out));
  } else if (typeof body === "object" && body !== null) {
    const keys = Object.keys(body);
    for (const [key, value] of Object.entries(body)) {
      if (isSecretKey(key, keys) && value !== null && markerDigest(value) === null) out.push(formatPath("body", [...segments, key]));
      else unredactedSecrets(value, [...segments, key], out);
    }
  }
  return out;
}

/** How deep the credential scans walk nested objects, arrays and JSON text before they stop. */
export const SCAN_DEPTH = 64;

/**
 * Whether `text` is JSON text (an object or array) holding a secret key, at any depth and in JSON text inside it,
 * with anything but a redaction marker (`state: "{\"access_token\":…}"`). The disclosure core digests by key and
 * path, never inside string values, so such a value is logged as sent (ADR-0014): the log views do not print it, and
 * `intent verify` warns about it. Text nested deeper than SCAN_DEPTH counts as holding one (fail closed).
 */
export function holdsNestedSecret(text: string, depth = 0): boolean {
  if (!/^\s*[[{]/.test(text)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const holds = (value: unknown, level: number): boolean => {
    if (level > SCAN_DEPTH) return true;
    if (Array.isArray(value)) return value.some((item) => holds(item, level + 1));
    if (typeof value === "string") return holdsNestedSecret(value, level + 1);
    if (typeof value !== "object" || value === null) return false;
    const keys = Object.keys(value);
    return Object.entries(value).some(([key, item]) => (isSecretKey(key, keys) && item !== null && markerDigest(item) === null) || holds(item, level + 1));
  };
  return holds(parsed, depth);
}

/** The body paths of string values that hold a credential inside JSON text (holdsNestedSecret); paths only, never values. */
export function nestedSecrets(body: unknown, segments: PathSegment[] = [], out: string[] = []): string[] {
  if (segments.length > SCAN_DEPTH) return out;
  if (typeof body === "string") {
    if (holdsNestedSecret(body, segments.length)) out.push(formatPath("body", segments));
  } else if (Array.isArray(body)) {
    (body as unknown[]).forEach((item, i) => nestedSecrets(item, [...segments, i], out));
  } else if (typeof body === "object" && body !== null) {
    for (const [key, value] of Object.entries(body)) nestedSecrets(value, [...segments, key], out);
  }
  return out;
}

/** The content type of a form body (RFC 7009 revocation, OAuth token requests). */
export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Whether the request's `content-type` header names a form body. */
export function isFormBody(headers: readonly (readonly [string, string])[]): boolean {
  const type = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === FORM_CONTENT_TYPE;
}

/**
 * A request body as a value: null when empty, a form as {name: value} (a repeated name keeps its last value, which
 * bodyText then cannot reproduce), anything else parsed as JSON. Throws on a body that is not JSON.
 */
export function bodyValue(headers: readonly (readonly [string, string])[], bytes: Uint8Array): unknown {
  if (bytes.length === 0) return null;
  const text = Buffer.from(bytes).toString("utf8");
  if (isFormBody(headers)) return Object.fromEntries(new URLSearchParams(text));
  return JSON.parse(text) as unknown;
}

/**
 * A body value as the gateway writes it: a form with URLSearchParams, anything else with JSON.stringify. A request
 * whose bytes are not bodyText of their own bodyValue cannot be logged as sent (ADR-0014).
 */
export function bodyText(value: unknown, form: boolean): string {
  if (!form) return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]): [string, string] => [k, typeof v === "string" ? v : JSON.stringify(v)]);
  return new URLSearchParams(entries).toString();
}
