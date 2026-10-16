// What several commands share: the config (with demo mode applied), the trusted root keys, the active policy, and
// a store plus disclosed cloud to reach Intent Cloud through.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Config, ConfigError, loadConfig, type RootKey } from "../config/index.ts";
import { connectCloud, type DisclosedCloud, type DisclosureOptions } from "../disclosure/index.ts";
import { loadPolicy, type Policy } from "../policy/index.ts";
import { createSession } from "../signing/index.ts";
import type { Store } from "../store/index.ts";
import { CliError, type Io, line } from "./io.ts";

/** The package root: `policies/` and `package.json` sit here, beside both `src/` and `dist/`. */
export const PACKAGE_ROOT = new URL("../../", import.meta.url);
const STRICT_DEFAULT = new URL("policies/strict-default/policy.yaml", PACKAGE_ROOT);

export const DEMO_BANNER = "DEMO: test keys, sample catalog, nothing can be bought";

/** A running demo Intent Cloud (src/demo, task G29). */
export interface Demo {
  cloudUrl: string;
  trustKeys: { rootKeys: readonly RootKey[] };
  confirmBaseUrl: string;
  close(): Promise<void>;
}

interface DemoModule {
  startDemo(options: { port?: number; dataDir: string }): Promise<Demo>;
}

/** The config for a command. In demo mode the data dir (and a default policy path) move to `<data>/demo`. */
export function cliConfig(io: Io, argv: readonly string[], demo: boolean, requireTrust: boolean): Config {
  // Demo mode brings its own Intent Cloud and root key, so the configured host's pin does not matter.
  const config = loadConfig(io.env, argv, { requireTrust: requireTrust && !demo && io.env.INTENT_DEMO !== "1", ...cwd(io) });
  if (!demo && !config.demo) return config;
  const dataDir = join(config.dataDir, "demo");
  const policyPath = io.env.INTENT_POLICY === undefined ? join(dataDir, "policy.yaml") : config.policyPath;
  return { ...config, demo: true, dataDir, policyPath };
}

function cwd(io: Io): { cwd?: string } {
  return io.cwd === undefined ? {} : { cwd: io.cwd };
}

/** Starts the demo Intent Cloud, or explains that this build has none. */
export async function startDemo(config: Config, io: Io): Promise<Demo> {
  let module: DemoModule;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- src/demo is built in parallel (G29); until it lands this build has no demo
    // @ts-ignore
    module = (await import("../demo/index.ts")) as DemoModule;
  } catch (error) {
    if (!isMissingModule(error)) throw error;
    throw new CliError(
      "demo mode is not available in this build; update the gateway (npx -y intent-gateway@latest), or run against Intent Cloud with --trust-keys <file>",
      2,
    );
  }
  const demo = await module.startDemo({ dataDir: config.dataDir });
  line(io.stderr, `intent-gateway ${DEMO_BANNER}`);
  line(io.stderr, `intent-gateway demo Intent Cloud at ${demo.cloudUrl}; approve carts at ${demo.confirmBaseUrl}`);
  return demo;
}

function isMissingModule(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return code === "ERR_MODULE_NOT_FOUND" || (/demo[\\/]index/.test(message) && /find|load|resolve/i.test(message));
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

/** The root keys to trust for the configured host: the build's pin, or the `--trust-keys` file. */
export async function rootKeys(config: Config): Promise<readonly RootKey[]> {
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
  return keys.data.rootKeys;
}

export interface ActivePolicy {
  policy: Policy;
  text: string;
  /** True when no policy file exists and the bundled strict-default is used. */
  bundled: boolean;
}

/** The policy at `policyPath`, or the bundled strict-default when there is no file. A bad file is an error. */
export async function activePolicy(policyPath: string): Promise<ActivePolicy> {
  let text: string;
  let bundled = false;
  try {
    text = await readFile(policyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = await readFile(STRICT_DEFAULT, "utf8");
    bundled = true;
  }
  return { policy: loadPolicy(text), text, bundled };
}

/** The disclosed cloud for this config: every request is logged to `store` before it is sent. */
export function cloudFor(io: Io, store: Store, baseUrl: string, options: DisclosureOptions): DisclosedCloud {
  const http = { baseUrl, session: createSession(), ...(io.now === undefined ? {} : { now: io.now }) };
  return (io.connect ?? connectCloud)(http, store, options);
}
