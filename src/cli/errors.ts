// Every failure the CLI can meet, as one line: what failed, then the command or setting that fixes it. Stack
// traces only with INTENT_DEBUG=1. Pure.
import { type Config, ConfigError, DEFAULT_CLOUD_URL, INTENT, tryLocally, UPDATE_COMMAND } from "../config/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureNoKeysError,
  DisclosureStoppedError,
} from "../disclosure/index.ts";
import { GatewayNotStartedError, GatewayStartError } from "../gateway/index.ts";
import { LibraryError, type LibraryErrorCode } from "../library/index.ts";
import { McpHttpError } from "../mcp/index.ts";
import { PanelError } from "../panel/index.ts";
import { PolicyError } from "../policy/index.ts";
import { StoreCorruptError, StoreFencedError, StoreUnsafeError } from "../store/index.ts";
import { CliError } from "./io.ts";
import { DEFAULT_POLICY } from "./setup.ts";

export interface ErrorContext {
  dataDir?: string;
  policyPath?: string;
  cloudUrl?: string;
  /** The demo next step for this runtime (config's tryLocally); defaults to `try everything locally with <INTENT> demo`. */
  tryLocally?: string;
}

const LIBRARY_FIX: Readonly<Record<LibraryErrorCode, string>> = {
  UNKNOWN_POLICY: "see the names in the policies/ folder of the gateway repository",
  INDEX_INVALID: `reinstall the gateway (${UPDATE_COMMAND}), or pass --commit <sha> to take the library from GitHub`,
  HASH_MISMATCH: "nothing was written; reinstall the gateway, or pass --commit <sha> of a signed commit on main",
  NO_BUILD_COMMIT: "pass --commit <sha> of a signed commit on main to take the policy from GitHub",
  BAD_COMMIT: "copy the full hash of a commit on main from git log",
  COMMIT_UNSIGNED: "pass --commit <sha> of a signed commit on main",
  COMMIT_NOT_ON_MAIN: "pass --commit <sha> of a commit on main",
  GITHUB_RATE_LIMITED: "try again later, or drop --commit to use the policy bundled with the gateway",
  GITHUB_ERROR: "check your connection and try again, or drop --commit to use the bundled policy",
  LOCK_INVALID: `run ${INTENT} policy add <name> again to rewrite it, or delete policy.lock`,
  LOCK_STALE: `run ${INTENT} policy add <name> again`,
  POLICY_CHANGED: "run the command again",
};

/** What describeError needs to name the fix for a command: the paths, the Intent Cloud URL and this runtime's demo next step. */
export function errorContext(config: Config, env: Readonly<Record<string, string | undefined>>): ErrorContext {
  return { dataDir: config.dataDir, policyPath: config.policyPath, cloudUrl: config.cloud.url, tryLocally: tryLocally(config.runtime, env) };
}

/** What to do when Intent Cloud cannot be used: wait for staging (the default host) or check the setting; or the demo. */
function unavailableNext(ctx: ErrorContext): string {
  const local = ctx.tryLocally ?? `try everything locally with ${INTENT} demo`;
  return ctx.cloudUrl === DEFAULT_CLOUD_URL ? `Staging may not be open yet; ${local}` : `Check your connection and INTENT_CLOUD_URL, or ${local}`;
}

/**
 * Intent Cloud's first request (meta, no body fields) came back with an HTTP error: the host answers but does not
 * serve the gateway yet. Says only what came back (invariant 5).
 */
export function metaRefused(status: number, ctx: ErrorContext): string {
  const host = ctx.cloudUrl === undefined ? "Intent Cloud" : `Intent Cloud at ${new URL(ctx.cloudUrl).host}`;
  return `${host} answered HTTP ${String(status)} to the gateway's first request (meta, no body fields). ${unavailableNext(ctx)}`;
}

/** One line, no trailing newline. */
export function describeError(error: unknown, ctx: ErrorContext = {}): string {
  return worded(error, ctx).replace(/\s*\n\s*/g, " ");
}

function worded(error: unknown, ctx: ErrorContext): string {
  const message = error instanceof Error ? error.message : String(error);
  const dataDir = ctx.dataDir ?? "the data dir";
  if (error instanceof CliError) return message;
  if (error instanceof ConfigError) {
    if (/Try everything locally|INTENT_DEMO=1/.test(message)) return `configuration: ${message}`;
    if (/root key|pinned/.test(message)) return `configuration: ${message}; or run ${INTENT} demo to try the gateway with no setup`;
    const fix = /pass |unset |give /.test(message) ? "" : `; correct that setting, or unset it to use the default (${INTENT} --help lists them)`;
    return `configuration: ${message}${fix}`;
  }
  if (error instanceof GatewayStartError) {
    if (error.metaStatus !== null) return metaRefused(error.metaStatus, ctx);
    return `could not start: ${message}; run ${INTENT} doctor to see each check`;
  }
  if (error instanceof GatewayNotStartedError) return `${message}; run ${INTENT} doctor`;
  if (error instanceof PolicyError) {
    const where = ctx.policyPath ?? "the policy";
    return `policy ${where}: ${message}; fix that line, or delete the file to use the bundled ${DEFAULT_POLICY} policy`;
  }
  if (error instanceof LibraryError) return `policy library: ${message}; ${LIBRARY_FIX[error.code]}`;
  if (error instanceof StoreUnsafeError) {
    return `data dir: ${message}; set INTENT_DATA_DIR to a folder you own that is not a symbolic link`;
  }
  if (error instanceof StoreCorruptError) {
    return `local hash chain in ${dataDir}: ${message}; run ${INTENT} verify to see where it breaks, then move audit.jsonl aside to start a new chain`;
  }
  if (error instanceof DisclosureStoppedError) {
    return `${message}; check the disk and the permissions of ${dataDir}, restart the gateway, then run ${INTENT} verify`;
  }
  if (error instanceof StoreFencedError && /\b(write|append) failed: /.test(message)) {
    return `local hash chain in ${dataDir}: ${message}; check the disk and the permissions of the data dir, then restart the gateway`;
  }
  if (error instanceof StoreFencedError) {
    return `local hash chain in ${dataDir}: ${message}; another gateway is writing to it, so stop that one or set INTENT_DATA_DIR`;
  }
  const cloud = ctx.cloudUrl ?? "Intent Cloud";
  if (error instanceof CloudNetworkError) {
    // Invariant 5: "nothing was sent" only when no connection was ever made; otherwise the request may have arrived.
    const sent = error.neverLeft ? "nothing was sent" : "the request may have reached it (logged as sent, not acknowledged)";
    return `${message}; ${sent}. ${unavailableNext(ctx)}`;
  }
  if (error instanceof CloudResponseError || error instanceof DisclosureDiscardedError) {
    return `${cloud} answered something the gateway does not accept: ${message}; run ${INTENT} doctor`;
  }
  if (error instanceof CloudRequestError) return `request refused before sending: ${message}; check INTENT_CLOUD_URL`;
  if (error instanceof DisclosureBlockedError) return `${message}; remove the buyer's identity from the request`;
  if (error instanceof DisclosureNoKeysError) return `${message}; run ${INTENT} doctor`;
  if (error instanceof McpHttpError) return `MCP over HTTP: ${message}; set INTENT_HTTP_TOKEN or INTENT_HTTP_HOST=127.0.0.1`;
  if (error instanceof PanelError) return `panel: ${message}`; // its messages already name the fix
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EADDRINUSE") return `${message}; that port is taken: pass --port <n> or set INTENT_HTTP_PORT`;
  if (code === "EACCES" || code === "EPERM") return `${message}; check the permissions, or set INTENT_DATA_DIR to a folder you own`;
  if (code === "ENOENT") return `${message}; check the path`;
  return `unexpected error: ${message}; run again with INTENT_DEBUG=1 for details and report it at https://github.com/golden007eye/intent-gateway/issues`;
}
