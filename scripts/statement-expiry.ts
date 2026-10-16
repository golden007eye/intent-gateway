// Daily check that the key statement Intent Cloud serves still has at least 14 days to run (R3-5). A gateway trusts
// no key of a host once its statement expires (fail closed), so an expiring statement must show up as a red run
// well before it stops every gateway. The statement is verified against the pinned root first: only a statement the
// gateway would accept counts, and a dated but unsigned one proves nothing.
//
// Run: node scripts/statement-expiry.ts. KEY_STATEMENT_URL overrides the URL; TRUST_KEYS names a root key file
// (`{"rootKeys": [...]}`, the --trust-keys format) used until the host's root key is in PINNED_HOSTS.
// Prints a GitHub Actions annotation and exits 1 when the check fails.
import { readFileSync, realpathSync } from "node:fs";
import { PINNED_HOSTS, type RootKey } from "../src/config/index.ts";
import { verifyStatement } from "../src/trust/index.ts";

export const KEY_STATEMENT_URL = "https://staging-api.intentai.shop/v1/key-statement";
/** Fewer days than this left on the statement fails the check. */
export const MIN_DAYS_LEFT = 14;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface Verdict {
  ok: boolean;
  message: string;
}

/** Whether a statement expiring at `expiresAt` still has `minDays` days to run at `now`. */
export function expiryVerdict(expiresAt: Date, now: Date, minDays = MIN_DAYS_LEFT): Verdict {
  const daysLeft = (expiresAt.getTime() - now.getTime()) / DAY_MS;
  const when = `the key statement expires at ${expiresAt.toISOString()}, ${daysLeft.toFixed(1)} days from now`;
  return daysLeft >= minDays
    ? { ok: true, message: when }
    : { ok: false, message: `${when}: fewer than ${String(minDays)} days left; Intent Cloud must publish a new statement` };
}

/** The root keys to verify `url`'s statement with: the TRUST_KEYS file when given, else the build's pin for the host. */
export function rootKeysFor(url: string, trustKeysPath?: string): readonly RootKey[] {
  if (trustKeysPath === undefined || trustKeysPath === "") {
    const host = new URL(url).host;
    return Object.hasOwn(PINNED_HOSTS, host) ? (PINNED_HOSTS[host]?.rootKeys ?? []) : [];
  }
  const file = JSON.parse(readFileSync(trustKeysPath, "utf8")) as { rootKeys?: unknown };
  if (!Array.isArray(file.rootKeys)) throw new Error(`${trustKeysPath} is not {"rootKeys": [...]}`);
  return file.rootKeys as RootKey[];
}

export interface CheckOptions {
  url: string;
  rootKeys: readonly RootKey[];
  now: Date;
  fetch?: typeof fetch;
}

/** Fetches the statement, verifies it against `rootKeys` at `now`, and checks the days it has left. */
export async function checkStatement(opts: CheckOptions): Promise<Verdict> {
  if (opts.rootKeys.length === 0) {
    return { ok: false, message: `no root key is pinned for ${new URL(opts.url).host}; set the TRUST_KEYS file or pin the key (docs/release.md)` };
  }
  let body: unknown;
  try {
    const res = await (opts.fetch ?? fetch)(opts.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) return { ok: false, message: `${opts.url} answered HTTP ${String(res.status)}` };
    if (bytes.length > MAX_BODY_BYTES) return { ok: false, message: `${opts.url} sent more than ${String(MAX_BODY_BYTES)} bytes` };
    body = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    return { ok: false, message: `cannot read ${opts.url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = verifyStatement(body, opts.rootKeys, opts.now);
  if (!result.ok) {
    return { ok: false, message: `the key statement does not verify against the pinned root (Appendix F step ${String(result.step)}: ${result.reason})` };
  }
  return expiryVerdict(result.keySet.expiresAt, opts.now);
}

/** A GitHub Actions workflow command; the message is escaped so it stays one annotation. */
export function annotation(verdict: Verdict): string {
  const escaped = verdict.message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::${verdict.ok ? "notice" : "error"} title=Key statement::${escaped}`;
}

async function main(): Promise<void> {
  const url = process.env.KEY_STATEMENT_URL ?? KEY_STATEMENT_URL;
  let verdict: Verdict;
  try {
    verdict = await checkStatement({ url, rootKeys: rootKeysFor(url, process.env.TRUST_KEYS), now: new Date() });
  } catch (err) {
    verdict = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  console.log(annotation(verdict));
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) await main();
