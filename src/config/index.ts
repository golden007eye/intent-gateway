// The gateway's configuration. This is the only module that reads environment variables and resolves paths;
// every other module takes the resolved Config. Values that came from the user are checked here, so a typo
// fails at start with the variable's name instead of silently falling back to a default.
import type { JsonWebKey } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { readBuild, type Build } from "./build.ts";

export type { Build } from "./build.ts";

/** Version and build commit of this gateway (buildCommit is null when running from source). */
export const BUILD: Build = readBuild(new URL("../", import.meta.url));

export interface RootKey {
  kid: string;
  jwk: Readonly<JsonWebKey>;
}

/**
 * Root public keys pinned per Intent Cloud host (plan §3.1 "Key trust"). A root key signs the statement that
 * lists the host's current signing keys; everything else the gateway trusts is taken from that statement at run
 * time, so this map holds root public keys and nothing more.
 */
export const PINNED_HOSTS: Readonly<Record<string, { readonly rootKeys: readonly RootKey[] }>> = {
  // Empty until the release task commits the real `cloud-root-1` public key. With no root key, loadConfig
  // refuses this host unless `--trust-keys` names a key file, so the gateway never trusts an empty pin.
  "staging-api.intentai.shop": { rootKeys: [] },
};

export const DEFAULT_CLOUD_URL = "https://staging-api.intentai.shop";
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8787;
const MIN_TOKEN_LENGTH = 32;

export type Trust =
  | { kind: "pinned"; host: string; rootKeys: readonly RootKey[] }
  | { kind: "file"; path: string }
  /** Only with `requireTrust: false`: the host has no root key pinned and no `--trust-keys` was given. */
  | { kind: "unpinned"; host: string; reason: string };

export interface Config {
  runtime: "host" | "container";
  dataDir: string;
  policyPath: string;
  cloud: { url: string; trust: Trust };
  /** The MCP HTTP transport. token is null only on a loopback host. */
  http: { host: string; port: number; token: string | null };
  /** INTENT_DEMO=1: run against the local demo Intent Cloud (the `--demo` flag does the same). */
  demo: boolean;
  /** INTENT_DEBUG=1: print stack traces with errors. */
  debug: boolean;
}

export interface LoadOptions {
  platform?: NodeJS.Platform;
  homedir?: string;
  cwd?: string;
  /**
   * False for the commands that never reach Intent Cloud (log, panel, policy, approver): an unpinned host then
   * gives `trust.kind === "unpinned"` instead of a ConfigError. Defaults to true.
   */
  requireTrust?: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const KNOWN_VARIABLES = new Set([
  "INTENT_DATA_DIR",
  "INTENT_RUNTIME",
  "INTENT_POLICY",
  "INTENT_CLOUD_URL",
  "INTENT_HTTP_HOST",
  "INTENT_HTTP_PORT",
  "INTENT_HTTP_TOKEN",
  "INTENT_DEMO",
  "INTENT_DEBUG",
]);

/**
 * Builds the Config from the environment and the command line. Of argv it reads only `--trust-keys <path>`
 * (or `--trust-keys=<path>`); the CLI owns the other arguments. Throws ConfigError on any unknown INTENT_*
 * variable or invalid value.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  options: LoadOptions = {},
): Config {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const cwd = options.cwd ?? process.cwd();
  const home = options.homedir ?? homedir();

  const intent: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("INTENT_") || value === undefined) continue;
    if (!KNOWN_VARIABLES.has(name)) {
      throw new ConfigError(`unknown environment variable ${name}; known: ${[...KNOWN_VARIABLES].join(", ")}`);
    }
    if (value === "") throw new ConfigError(`${name} is set but empty; unset it to use the default`);
    intent[name] = value;
  }

  const runtimeValue = intent.INTENT_RUNTIME;
  if (runtimeValue !== undefined && runtimeValue !== "container") {
    throw new ConfigError(`INTENT_RUNTIME must be "container" or unset, got ${JSON.stringify(runtimeValue)}`);
  }
  const runtime = runtimeValue === "container" ? "container" : "host";

  const dataDir =
    intent.INTENT_DATA_DIR !== undefined
      ? path.resolve(cwd, userPath("INTENT_DATA_DIR", intent.INTENT_DATA_DIR))
      : runtime === "container"
        ? "/data"
        : defaultDataDir(platform, path, env, home);
  const policyPath =
    intent.INTENT_POLICY !== undefined
      ? path.resolve(cwd, userPath("INTENT_POLICY", intent.INTENT_POLICY))
      : path.join(dataDir, "policy.yaml");

  const trustKeys = readTrustKeys(argv);
  const cloud = cloudConfig(
    intent.INTENT_CLOUD_URL ?? DEFAULT_CLOUD_URL,
    trustKeys === undefined ? undefined : path.resolve(cwd, userPath("--trust-keys", trustKeys)),
    options.requireTrust ?? true,
  );

  return {
    runtime,
    dataDir,
    policyPath,
    cloud,
    http: httpConfig(intent),
    demo: flag("INTENT_DEMO", intent.INTENT_DEMO),
    debug: flag("INTENT_DEBUG", intent.INTENT_DEBUG),
  };
}

function flag(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value !== "1") throw new ConfigError(`${name} must be 1 or unset, got ${JSON.stringify(value)}`);
  return true;
}

/**
 * A path the user gave. A leading `~` is refused: the shell did not expand it (it was quoted, or set in a file),
 * and resolving it would make a folder literally named `~` under the working directory.
 */
function userPath(name: string, value: string): string {
  if (value.startsWith("~")) {
    throw new ConfigError(`${name} starts with ~, which is not expanded here; give the full path, got ${JSON.stringify(value)}`);
  }
  return value;
}

function defaultDataDir(
  platform: NodeJS.Platform,
  path: typeof posix,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  // The XDG spec says a relative XDG_DATA_HOME is invalid and must be ignored.
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg !== "" && path.isAbsolute(xdg)) return path.join(xdg, "intent-gateway");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "intent-gateway");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local !== undefined && local !== "" && !path.isAbsolute(local)) {
      throw new ConfigError(`LOCALAPPDATA is not an absolute path (${JSON.stringify(local)}); fix it or set INTENT_DATA_DIR`);
    }
    const base = local !== undefined && local !== "" ? local : path.join(home, "AppData", "Local");
    return path.join(base, "intent-gateway");
  }
  return path.join(home, ".local", "share", "intent-gateway");
}

function readTrustKeys(argv: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    let value: string | undefined;
    if (arg === "--trust-keys") {
      value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new ConfigError("--trust-keys needs a path to a key file");
      }
      i++;
    } else if (arg.startsWith("--trust-keys=")) {
      value = arg.slice("--trust-keys=".length);
      if (value === "") throw new ConfigError("--trust-keys needs a path to a key file");
    } else {
      continue;
    }
    if (found !== undefined) throw new ConfigError("--trust-keys is given more than once");
    found = value;
  }
  return found;
}

function cloudConfig(raw: string, trustKeys: string | undefined, requireTrust: boolean): Config["cloud"] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`INTENT_CLOUD_URL is not a URL: ${JSON.stringify(raw)}`);
  }
  const loopback = isLoopback(url.hostname.replace(/^\[(.*)\]$/, "$1"));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError(`INTENT_CLOUD_URL must use https (http only on a loopback host), got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new ConfigError(`INTENT_CLOUD_URL must be an origin such as ${DEFAULT_CLOUD_URL}, got ${JSON.stringify(raw)}`);
  }
  if (trustKeys !== undefined) return { url: url.origin, trust: { kind: "file", path: trustKeys } };
  const rootKeys = Object.hasOwn(PINNED_HOSTS, url.host) ? PINNED_HOSTS[url.host]?.rootKeys : undefined;
  if (rootKeys === undefined || rootKeys.length === 0) {
    const reason =
      rootKeys === undefined
        ? `${url.host} is not a pinned Intent Cloud host; pass --trust-keys <path> to trust its root key`
        : `this build has no trusted root key for ${url.host}: Intent Cloud staging is not open yet. ` +
          `Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud`;
    if (requireTrust) throw new ConfigError(reason);
    return { url: url.origin, trust: { kind: "unpinned", host: url.host, reason } };
  }
  return { url: url.origin, trust: { kind: "pinned", host: url.host, rootKeys } };
}

function httpConfig(intent: Readonly<Record<string, string>>): Config["http"] {
  const host = intent.INTENT_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  if (!isBindHost(host)) {
    throw new ConfigError(`INTENT_HTTP_HOST must be an IP address or host name, got ${JSON.stringify(host)}`);
  }
  let port = DEFAULT_HTTP_PORT;
  if (intent.INTENT_HTTP_PORT !== undefined) {
    port = /^[0-9]{1,5}$/.test(intent.INTENT_HTTP_PORT) ? Number(intent.INTENT_HTTP_PORT) : NaN;
    if (!(port >= 1 && port <= 65535)) {
      throw new ConfigError(`INTENT_HTTP_PORT must be a port number 1-65535, got ${JSON.stringify(intent.INTENT_HTTP_PORT)}`);
    }
  }
  const token = intent.INTENT_HTTP_TOKEN ?? null;
  if (token !== null && (token.length < MIN_TOKEN_LENGTH || /\s/.test(token))) {
    throw new ConfigError(`INTENT_HTTP_TOKEN must be at least ${String(MIN_TOKEN_LENGTH)} characters with no spaces`);
  }
  if (token === null && !isLoopback(host)) {
    throw new ConfigError(`INTENT_HTTP_TOKEN is required when INTENT_HTTP_HOST (${host}) is not a loopback address`);
  }
  return { host, port, token };
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_CHARS = /^[0-9a-f:.]+$/i;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** An IPv6 literal (RFC 4291 text form, no brackets, no zone): eight hex groups, or fewer around one `::`. */
function isIpv6(host: string): boolean {
  if (!host.includes(":") || !IPV6_CHARS.test(host)) return false;
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const groups = halves.map((half) => (half === "" ? [] : half.split(":")));
  // A dotted IPv4 address may stand for the last two groups, so only at the very end of the text.
  const tail = IPV4.test(groups.at(-1)?.at(-1) ?? "") ? 2 : 0;
  if (tail === 2) groups.at(-1)?.pop();
  const all = groups.flat();
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  const count = all.length + tail;
  return halves.length === 2 ? count <= 7 : count === 8;
}

function isBindHost(host: string): boolean {
  // Digits and dots only is an IPv4 address or nothing: 999.1.1.1 is not a host name.
  return IPV4.test(host) || isIpv6(host) || (HOST_NAME.test(host) && !/^[0-9.]+$/.test(host));
}

/**
 * Only the literals 127.0.0.1 and ::1 count as loopback. A name such as `localhost` is resolved by the system and
 * can point elsewhere; any other spelling is treated as off-loopback, which only means a token is needed.
 */
function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}
