// Every failure the CLI can meet, as one line: what failed, then the command or setting that fixes it. Stack
// traces only with INTENT_DEBUG=1. Pure.
import { ConfigError } from "../config/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureNoKeysError,
} from "../disclosure/index.ts";
import { GatewayNotStartedError, GatewayStartError } from "../gateway/index.ts";
import { LibraryError, type LibraryErrorCode } from "../library/index.ts";
import { McpHttpError } from "../mcp/index.ts";
import { PanelError } from "../panel/index.ts";
import { PolicyError } from "../policy/index.ts";
import { StoreCorruptError, StoreFencedError, StoreUnsafeError } from "../store/index.ts";
import { CliError } from "./io.ts";

export interface ErrorContext {
  dataDir?: string;
  policyPath?: string;
  cloudUrl?: string;
}

const LIBRARY_FIX: Readonly<Record<LibraryErrorCode, string>> = {
  UNKNOWN_POLICY: "see the names in the policies/ folder of the gateway repository",
  INDEX_INVALID: "reinstall the gateway (npx -y intent-gateway@latest), or pass --commit <sha> to take the library from GitHub",
  HASH_MISMATCH: "nothing was written; reinstall the gateway, or pass --commit <sha> of a signed commit on main",
  NO_BUILD_COMMIT: "pass --commit <sha> of a signed commit on main to take the policy from GitHub",
  BAD_COMMIT: "pass the full 40-character hash of a commit on main",
  COMMIT_UNSIGNED: "pass --commit <sha> of a signed commit on main",
  COMMIT_NOT_ON_MAIN: "pass --commit <sha> of a commit on main",
  GITHUB_RATE_LIMITED: "try again later, or drop --commit to use the policy bundled with the gateway",
  GITHUB_ERROR: "check your connection and try again, or drop --commit to use the bundled policy",
  LOCK_INVALID: "run intent policy add <name> again to rewrite it, or delete policy.lock",
  LOCK_STALE: "run intent policy add <name> again",
  POLICY_CHANGED: "run the command again",
};

/** One line, no trailing newline. */
export function describeError(error: unknown, ctx: ErrorContext = {}): string {
  return worded(error, ctx).replace(/\s*\n\s*/g, " ");
}

function worded(error: unknown, ctx: ErrorContext): string {
  const message = error instanceof Error ? error.message : String(error);
  const dataDir = ctx.dataDir ?? "the data dir";
  if (error instanceof CliError) return message;
  if (error instanceof ConfigError) {
    if (/root key|pinned/.test(message)) return `configuration: ${message}; or run intent demo to try the gateway with no setup`;
    const fix = /pass |unset |give /.test(message) ? "" : "; correct that setting, or unset it to use the default (intent --help lists them)";
    return `configuration: ${message}${fix}`;
  }
  if (error instanceof GatewayStartError) {
    return `could not start: ${message}; run intent doctor to see each check`;
  }
  if (error instanceof GatewayNotStartedError) return `${message}; run intent doctor`;
  if (error instanceof PolicyError) {
    const where = ctx.policyPath ?? "the policy";
    return `policy ${where}: ${message}; fix that line, or delete the file to use the bundled strict-default policy`;
  }
  if (error instanceof LibraryError) return `policy library: ${message}; ${LIBRARY_FIX[error.code]}`;
  if (error instanceof StoreUnsafeError) {
    return `data dir: ${message}; set INTENT_DATA_DIR to a folder you own that is not a symbolic link`;
  }
  if (error instanceof StoreCorruptError) {
    return `local hash chain in ${dataDir}: ${message}; run intent verify to see where it breaks, then move audit.jsonl aside to start a new chain`;
  }
  if (error instanceof StoreFencedError) {
    return `local hash chain in ${dataDir}: ${message}; another gateway is writing to it, so stop that one or set INTENT_DATA_DIR`;
  }
  const cloud = ctx.cloudUrl ?? "Intent Cloud";
  if (error instanceof CloudNetworkError) {
    return `could not reach ${cloud}: ${message}; check your connection or INTENT_CLOUD_URL, or run intent demo to try without a network`;
  }
  if (error instanceof CloudResponseError || error instanceof DisclosureDiscardedError) {
    return `${cloud} answered something the gateway does not accept: ${message}; run intent doctor`;
  }
  if (error instanceof CloudRequestError) return `request refused before sending: ${message}; check INTENT_CLOUD_URL`;
  if (error instanceof DisclosureBlockedError) return `${message}; remove the buyer's identity from the request`;
  if (error instanceof DisclosureNoKeysError) return `${message}; run intent doctor`;
  if (error instanceof McpHttpError) return `MCP over HTTP: ${message}; set INTENT_HTTP_TOKEN or INTENT_HTTP_HOST=127.0.0.1`;
  if (error instanceof PanelError) return `panel: ${message}`; // its messages already name the fix
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EADDRINUSE") return `${message}; that port is taken: pass --port <n> or set INTENT_HTTP_PORT`;
  if (code === "EACCES" || code === "EPERM") return `${message}; check the permissions, or set INTENT_DATA_DIR to a folder you own`;
  if (code === "ENOENT") return `${message}; check the path`;
  return `unexpected error: ${message}; run again with INTENT_DEBUG=1 for details and report it at https://github.com/golden007eye/intent-gateway/issues`;
}
