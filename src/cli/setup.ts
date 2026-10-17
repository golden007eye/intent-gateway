// What several commands share: the config (with demo mode applied), the trusted root keys, the active policy, and
// a store plus disclosed cloud to reach Intent Cloud through.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Config, ConfigError, DOCKER_EXEC, loadConfig, parsePort, type RootKey } from "../config/index.ts";
import { type Demo, DEMO_CONFIRM_PORT, demoDataDir, demoTrustKeys, startDemo } from "../demo/index.ts";
import { connectCloud, type DisclosedCloud, type DisclosureOptions, type HttpCloudOptions } from "../disclosure/index.ts";
import { loadPolicy, type Policy } from "../policy/index.ts";
import { createSession } from "../signing/index.ts";
import type { Store } from "../store/index.ts";
import { isTestRoot } from "../trust/index.ts";
import { CliError, type Io } from "./io.ts";

/** The package root: `policies/` and `package.json` sit here, beside both `src/` and `dist/`. */
export const PACKAGE_ROOT = new URL("../../", import.meta.url);

/** The config for a command. In demo mode the data dir (and a default policy path) move to `<data>/demo`. */
export function cliConfig(io: Io, argv: readonly string[], demo: boolean, requireTrust: boolean): Config {
  // Demo mode brings its own Intent Cloud and root key, so the configured host's pin does not matter.
  const config = loadConfig(io.env, argv, { requireTrust: requireTrust && !demo && io.env.INTENT_DEMO !== "1", settings: [CONFIRM_PORT], ...cwd(io) });
  chosenConfirmPort(io); // a typo fails at start, as every other setting does
  if (!demo && !config.demo) return config;
  const dataDir = demoDataDir(config.dataDir);
  const policyPath = io.env.INTENT_POLICY === undefined ? join(dataDir, "policy.yaml") : config.policyPath;
  return { ...config, demo: true, dataDir, policyPath };
}

function cwd(io: Io): { cwd?: string } {
  return io.cwd === undefined ? {} : { cwd: io.cwd };
}

/** Starts the demo Intent Cloud and confirm page for a demo-mode config (whose dataDir is already `<data>/demo`). */
export async function startDemoFor(config: Config, io: Io): Promise<Demo> {
  // cliConfig moved dataDir to demoDataDir(<data>); startDemo takes <data> and adds the demo folder itself.
  // The confirm page listens on a known port (8788, or INTENT_DEMO_CONFIRM_PORT), so an `ssh -L` forward or a
  // Docker `-p` mapping can be set up before it starts. On a host it binds 127.0.0.1, and a taken default port falls
  // back to a free one (said on stderr); a port the developer chose is never swapped for another.
  // In the Docker image the host's browser must reach the confirm page through a port mapping, so it listens on
  // all interfaces there with no fallback; its links still say 127.0.0.1:<port> (map it to the same port on the host).
  const chosen = chosenConfirmPort(io);
  const port = chosen ?? DEMO_CONFIRM_PORT;
  const container = config.runtime === "container";
  const where = container ? { bind: "0.0.0.0", readCommand: `${DOCKER_EXEC} cat` } : { portFallback: chosen === null };
  try {
    return await startDemo({ dataDir: dirname(config.dataDir), port, ...where, ...(io.now === undefined ? {} : { now: io.now }) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EADDRINUSE") throw error;
    const named = chosen === null ? "" : ` (${CONFIRM_PORT})`;
    throw new CliError(`the demo confirm page cannot listen on port ${String(port)}${named}: that port is taken; stop what uses it or set ${CONFIRM_PORT} to another port`);
  }
}

/**
 * The demo confirm page's port setting. The CLI owns it rather than src/config, which holds no confirm literal
 * (confirm origins come only from Intent Cloud's signed statement); loadConfig accepts the name through `settings`.
 */
const CONFIRM_PORT = "INTENT_DEMO_CONFIRM_PORT";

function chosenConfirmPort(io: Io): number | null {
  const value = io.env[CONFIRM_PORT];
  return value === undefined ? null : parsePort(CONFIRM_PORT, value);
}

/** The root keys a command trusts: the demo's published test root in demo mode, else rootKeys(config). */
export async function trustedKeys(config: Config): Promise<readonly RootKey[]> {
  return config.demo ? demoTrustKeys().rootKeys : rootKeys(config);
}

const TrustFile = z.strictObject({
  rootKeys: z
    .array(
      z.strictObject({
        kid: z.string().min(1),
        jwk: z.strictObject({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      }),
    )
    .min(1),
});

/**
 * The root keys to trust for the configured host: the build's pin, or the `--trust-keys` file. `contacts` is true
 * for a command that reaches the host (serve, doctor): only then is the published test root refused for a host on
 * the network (L5). Reading the local chain (verify, panel) trusts no host.
 */
export async function rootKeys(config: Config, options: { contacts?: boolean } = {}): Promise<readonly RootKey[]> {
  const { trust } = config.cloud;
  if (trust.kind === "pinned") return trust.rootKeys;
  if (trust.kind === "unpinned") throw new ConfigError(trust.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(trust.path, "utf8"));
  } catch (error) {
    const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : "not JSON";
    throw new CliError(`--trust-keys ${trust.path}: ${why}; pass a key file of the form {"rootKeys":[{"kid":"cloud-root-1","jwk":{…}}]}`, 2);
  }
  const keys = TrustFile.safeParse(parsed);
  if (!keys.success) {
    throw new CliError(
      `--trust-keys ${trust.path} is not a root key file; it must be {"rootKeys":[{"kid":"cloud-root-1","jwk":{"kty":"OKP","crv":"Ed25519","x":"…"}}]}`,
      2,
    );
  }
  // Amendment L5: the published test root's private seed is public, so it is trusted only for a local fake
  // (http on 127.0.0.1 or [::1], as in demo mode and tests), never for a host on the network.
  if (options.contacts === true && keys.data.rootKeys.some(isTestRoot) && !isLoopbackHttp(config.cloud.url)) {
    throw new CliError(
      `--trust-keys ${trust.path} holds the published test root key (cloud-root-1 of the test vectors), whose private key is public; ` +
        `it is trusted only in demo mode or for a local fake on 127.0.0.1, not for ${config.cloud.url}`,
      2,
    );
  }
  return keys.data.rootKeys;
}

/** http on a loopback address: only a local fake Intent Cloud answers there. */
function isLoopbackHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

export interface ActivePolicy {
  policy: Policy;
  text: string;
  /** The bundled library policy used because no policy file exists, or null when the file is used. */
  bundled: string | null;
}

/**
 * The library policy that applies when there is no policy file, in every mode: zip-only, the cloud baseline plus
 * a 5-digit ZIP, the least a search needs. strict-default shares no ship-to at all, so no search could be sent
 * under it; it stays available through `intent policy add strict-default`.
 */
export const DEFAULT_POLICY = "zip-only";

/** The policy at `policyPath`, or the bundled DEFAULT_POLICY when there is no file. A bad file is an error. */
export async function activePolicy(policyPath: string): Promise<ActivePolicy> {
  let text: string;
  let bundled: string | null = null;
  try {
    text = await readFile(policyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    bundled = DEFAULT_POLICY;
    text = await readFile(new URL(`policies/${bundled}/policy.yaml`, PACKAGE_ROOT), "utf8");
  }
  return { policy: loadPolicy(text), text, bundled };
}

/** The disclosed cloud for this config: every request is logged to `store` before it is sent. */
export function cloudFor(io: Io, store: Store, baseUrl: string, options: DisclosureOptions, slow?: HttpCloudOptions["slow"]): DisclosedCloud {
  const http = { baseUrl, session: createSession(), ...(io.now === undefined ? {} : { now: io.now }), ...(slow === undefined ? {} : { slow }) };
  return (io.connect ?? connectCloud)(http, store, options);
}
