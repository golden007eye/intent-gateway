// Credentials in a logged request (ADR-0014): what the disclosure core digests before the log append, and what
// `intent verify` refuses to find unredacted in any disclosure.
//
// - A credential header: one of CREDENTIAL_HEADERS, compared case-insensitively.
// - A secret key: a body key at any depth (holding anything but null), or a query parameter name, whose words
//   (split on `_`, `-`, spaces and camelCase, lower-cased, joined with `_`) are one of SECRET_KEYS:
//   `accessToken`, `Refresh_Token` and `api-key` are secret keys. `code` is one only beside an OAuth sibling
//   (`grant_type`, `redirect_uri`, `code_verifier` or `client_id`), so a product or promo `code` is not.
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
  if (SECRET_KEYS.includes(normal)) return true;
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
  if (Array.isArray(body)) {
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
