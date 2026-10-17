// The gateway's configuration. This is the only module that reads environment variables and resolves paths;
// every other module takes the resolved Config. Values that came from the user are checked here, so a typo
// fails at start with the variable's name instead of silently falling back to a default.
import type { JsonWebKey } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { readBuild, type Build } from "./build.ts";
import { containerDemo, containerRef, dockerExec, IMAGE_TRUST_KEYS, invocation } from "./invocation.ts";

export type { Build } from "./build.ts";
export { describeBuild } from "./build.ts";

/** Version and build commit of this gateway (buildCommit is null when running from source). */
export const BUILD: Build = readBuild(new URL("../", import.meta.url));

export { containerDemo, containerRef, dockerExec, IMAGE_DEMO_RUN, IMAGE_TRUST_KEYS, invocation, type InvocationInput } from "./invocation.ts";

/**
 * The command that runs this gateway, to print before a subcommand (`${INTENT} verify --demo`): `npx -y <spec>`
 * under npx, `node /abs/dist/main.js` from a path, `intent` from a global install, `docker exec <container id> intent`
 * in the image. See invocation().
 */
export const INTENT: string = invocation({ argv1: process.argv[1], packageRoot: fileURLToPath(new URL("../../", import.meta.url)), env: process.env });

/** `docker exec <this container's id>`, to print before a command run inside the image. See dockerExec(). */
export const DOCKER_EXEC: string = dockerExec(process.env);

/** `docker stop <this container's id>`: a detached container has no Ctrl-C to stop it. */
export const DOCKER_STOP: string = `docker stop ${containerRef(process.env)}`;

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
  // Intent Cloud staging's root public key, pinned by the 0.1.0-preview.1 release (docs/release.md). A host whose
  // pin lists no root key is refused unless `--trust-keys` names a key file, so the gateway never trusts an empty pin.
  "staging-api.intentai.shop": {
    rootKeys: [{ kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "7-sDUcgqFgaDKZvWfEjmnhcntLrcrnNVlM1VFyGHFoI" } }],
  },
};

export const DEFAULT_CLOUD_URL = "https://staging-api.intentai.shop";

/** The command that installs the newest release of this channel: `@next` for a preview (a version with a `-`), else `@latest`. */
export const UPDATE_COMMAND = `npx -y intent-gateway@${BUILD.version.includes("-") ? "next" : "latest"}`;

/**
 * The next step when Intent Cloud cannot be used: run the demo. On a host, `<INTENT> demo`; in the Docker image,
 * re-run the container in demo mode (a container that failed to start has exited, so there is nothing to exec into).
 */
export function tryLocally(runtime: Config["runtime"], env: Readonly<Record<string, string | undefined>>): string {
  return runtime === "container" ? `try everything locally: ${containerDemo(env)}` : `try everything locally with ${INTENT} demo`;
}
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
  /** INTENT_QUIET_TOKEN=1: the HTTP token is never printed (the Docker image's connect line reads it instead). */
  quietToken: boolean;
  /** In the Docker image, the file its entrypoint keeps the HTTP token in (<data>/http-token); null on a host. */
  tokenFile: string | null;
  wallet: WalletConfig;
}

/**
 * A secret setting's value. It prints as `[redacted]` (String, JSON, util.inspect), so a Config logged or put in an
 * error message never carries it; only `reveal()` returns the value.
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [inspect.custom](): string {
    return "[redacted]";
  }
}

/**
 * Where the wallet vault's key comes from (plan D4), in this order: `INTENT_WALLET_KEY_FILE` (a Docker secret;
 * preferred), else `INTENT_WALLET_KEY` (its value is visible in /proc/<pid>/environ and docker inspect, so using it
 * warns), else a key file the gateway generates in the per-user config folder, outside the data dir. `none` when
 * there is no safe default: in the Docker image (a container's home does not outlive it) or when the default
 * would sit inside the data dir.
 */
export type WalletKeySource =
  | { kind: "file"; path: string }
  | { kind: "env"; value: Secret }
  | { kind: "default"; path: string }
  | { kind: "none"; reason: string };

export interface WalletConfig {
  key: WalletKeySource;
  /** INTENT_WALLET_KEY is set but INTENT_WALLET_KEY_FILE wins; the env value is still exposed, so the CLI warns. */
  envKeyIgnored: boolean;
  /** INTENT_SHOP_MCP_URL, INTENT_SHOP_AUTH_URL: the Shop endpoints, null until set (the Shop adapter names defaults). */
  shopMcpUrl: string | null;
  shopAuthUrl: string | null;
  /**
   * INTENT_SHOP_CLIENT_ID: the Shop OAuth client the gateway signs in as, a client id or the https URL of a client-ID
   * metadata document. No default: the gateway ships no Shop client of its own yet, so without it one-tap with Shop
   * is unavailable and purchases are handed off (ADR-0017).
   */
  shopClientId: string | null;
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
  /**
   * More INTENT_* variables, owned and read by the caller, to accept as known (the CLI's demo confirm page port, a
   * name this module must not hold: no confirm literal lives here, see config.test.ts). Each is still refused empty.
   */
  settings?: readonly string[];
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
  "INTENT_QUIET_TOKEN",
  "INTENT_WALLET_KEY_FILE",
  "INTENT_WALLET_KEY",
  "INTENT_SHOP_MCP_URL",
  "INTENT_SHOP_AUTH_URL",
  "INTENT_SHOP_CLIENT_ID",
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

  const known = new Set([...KNOWN_VARIABLES, ...(options.settings ?? [])]);
  const intent: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("INTENT_") || value === undefined) continue;
    if (!known.has(name)) {
      throw new ConfigError(`unknown environment variable ${name}; known: ${[...known].join(", ")}`);
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
    runtime === "container" ? containerDemo(env) : null,
  );

  return {
    runtime,
    dataDir,
    policyPath,
    cloud,
    http: httpConfig(intent),
    demo: flag("INTENT_DEMO", intent.INTENT_DEMO),
    debug: flag("INTENT_DEBUG", intent.INTENT_DEBUG),
    quietToken: flag("INTENT_QUIET_TOKEN", intent.INTENT_QUIET_TOKEN),
    tokenFile: runtime === "container" ? path.join(dataDir, "http-token") : null,
    wallet: walletConfig(intent, { platform, path, env, home, cwd, runtime, dataDir }),
  };
}

interface WalletPlace {
  platform: NodeJS.Platform;
  path: typeof posix;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd: string;
  runtime: Config["runtime"];
  dataDir: string;
}

/** The wallet vault key as text: 32 random bytes, as base64 (`openssl rand -base64 32`), base64url or 64 hex digits. */
export const WALLET_KEY_TEXT = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43}|[0-9a-fA-F]{64})$/;

function walletConfig(intent: Readonly<Record<string, string>>, at: WalletPlace): WalletConfig {
  const { path } = at;
  const envKey = intent.INTENT_WALLET_KEY?.trim();
  // Never echo the value: it is a key.
  if (envKey !== undefined && !WALLET_KEY_TEXT.test(envKey)) {
    throw new ConfigError("INTENT_WALLET_KEY must be 32 random bytes as base64 (openssl rand -base64 32); prefer INTENT_WALLET_KEY_FILE");
  }
  let key: WalletKeySource;
  if (intent.INTENT_WALLET_KEY_FILE !== undefined) {
    const file = path.resolve(at.cwd, userPath("INTENT_WALLET_KEY_FILE", intent.INTENT_WALLET_KEY_FILE));
    // A key beside the vault it opens protects nothing: whoever copies the data dir has both.
    if (inside(path, at.dataDir, file)) {
      throw new ConfigError(`INTENT_WALLET_KEY_FILE (${file}) is inside the data dir ${at.dataDir}; keep the wallet key outside it`);
    }
    key = { kind: "file", path: file };
  } else if (envKey !== undefined) {
    key = { kind: "env", value: new Secret(envKey) };
  } else if (at.runtime === "container") {
    key = { kind: "none", reason: "in the Docker image the wallet key must come from a secret: mount one and set INTENT_WALLET_KEY_FILE" };
  } else {
    const file = path.join(defaultConfigDir(at), "wallet-key");
    key = inside(path, at.dataDir, file)
      ? { kind: "none", reason: `the default wallet key file ${file} would sit inside the data dir; set INTENT_WALLET_KEY_FILE to a file outside it` }
      : { kind: "default", path: file };
  }
  return {
    key,
    envKeyIgnored: envKey !== undefined && key.kind === "file",
    shopMcpUrl: shopUrl("INTENT_SHOP_MCP_URL", intent.INTENT_SHOP_MCP_URL),
    shopAuthUrl: shopUrl("INTENT_SHOP_AUTH_URL", intent.INTENT_SHOP_AUTH_URL),
    shopClientId: shopClientId(intent.INTENT_SHOP_CLIENT_ID),
  };
}

/** A Shop OAuth client id: an opaque id (letters, digits, `-`, `_`, `.`), or the https URL of a client-ID metadata document. */
function shopClientId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (/^[A-Za-z0-9._-]{1,128}$/.test(value)) return value;
  if (/^[a-z]+:/i.test(value)) return shopUrl("INTENT_SHOP_CLIENT_ID", value);
  throw new ConfigError("INTENT_SHOP_CLIENT_ID must be a Shop client id or the https URL of a client-ID metadata document");
}

/** Whether `file` is `dir` itself or lies under it. */
function inside(path: typeof posix, dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The per-user config folder, apart from the data dir so the wallet key never sits beside the vault. */
function defaultConfigDir({ platform, path, env, home }: WalletPlace): string {
  if (platform === "darwin") return path.join(home, "Library", "Preferences", "intent-gateway");
  if (platform === "win32") {
    const roaming = env.APPDATA;
    const base = roaming !== undefined && roaming !== "" && path.isAbsolute(roaming) ? roaming : path.join(home, "AppData", "Roaming");
    return path.join(base, "intent-gateway");
  }
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg !== undefined && xdg !== "" && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "intent-gateway");
}

/** A Shop endpoint: https, or http on a loopback host (a fake Shop in tests). */
function shopUrl(name: string, raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not echoed: a mistyped value may carry a credential.
    throw new ConfigError(`${name} is not a URL; give a full https URL`);
  }
  const loopback = isLoopback(url.hostname.replace(/^\[(.*)\]$/, "$1"));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError(`${name} must use https (http only on a loopback host), got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new ConfigError(`${name} must not carry credentials or a fragment`);
  }
  return url.href;
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

/** `container`: in the Docker image, how to re-run it in demo mode (null on a host), for the unpinned-host hints. */
function cloudConfig(raw: string, trustKeys: string | undefined, requireTrust: boolean, container: string | null): Config["cloud"] {
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
    const staging = `this build has no trusted root key for ${url.host} yet. `;
    const reason =
      container !== null
        ? rootKeys === undefined
          ? `${url.host} is not a pinned Intent Cloud host; mount its root key file and pass it: ${IMAGE_TRUST_KEYS}. Or try everything locally: ${container}`
          : `${staging}Try everything locally now: ${container}; or, for a self-hosted Intent Cloud, mount its root key file: ${IMAGE_TRUST_KEYS}`
        : rootKeys === undefined
          ? `${url.host} is not a pinned Intent Cloud host; pass --trust-keys <path> to trust its root key`
          : `${staging}Try everything locally now with ${INTENT} demo, or pass --trust-keys <file> for a self-hosted Intent Cloud`;
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
  const port = intent.INTENT_HTTP_PORT === undefined ? DEFAULT_HTTP_PORT : parsePort("INTENT_HTTP_PORT", intent.INTENT_HTTP_PORT);
  const token = intent.INTENT_HTTP_TOKEN ?? null;
  if (token !== null && (token.length < MIN_TOKEN_LENGTH || /\s/.test(token))) {
    throw new ConfigError(`INTENT_HTTP_TOKEN must be at least ${String(MIN_TOKEN_LENGTH)} characters with no spaces`);
  }
  if (token === null && !isLoopback(host)) {
    throw new ConfigError(`INTENT_HTTP_TOKEN is required when INTENT_HTTP_HOST (${host}) is not a loopback address`);
  }
  return { host, port, token };
}

/** The port number `value` of the variable `name`, 1-65535 in plain digits; throws ConfigError naming the variable. */
export function parsePort(name: string, value: string): number {
  const port = /^[0-9]{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new ConfigError(`${name} must be a port number 1-65535, got ${JSON.stringify(value)}`);
  return port;
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
