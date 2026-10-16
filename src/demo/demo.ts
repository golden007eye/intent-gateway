// `intent demo`: the fake Intent Cloud in-process on 127.0.0.1 with the sample catalog and the published test keys,
// plus the local confirm page, so a developer can try the whole flow before any real Intent Cloud is reachable.
//
// The demo keeps its chain in `<data>/demo`, apart from the real one; the gateway marks it with a demo `session`
// entry and refuses to mix the two (GatewayOptions.demo). Its trust keys are returned, never added to PINNED_HOSTS.
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, type Stats, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeCloud, SoftPasskey, startFakeCloud } from "../cloud-fake/index.ts";
import { type PinnedRootKey, TEST_ROOT_KEY } from "../trust/index.ts";
import { CONFIRM_PATH, startConfirmPage } from "./confirm.ts";

export const DEMO_DIR = "demo";
/** The confirm page's fixed port in the Docker image, which `-p 127.0.0.1:8788:8788` maps to the host. */
export const CONTAINER_CONFIRM_PORT = 8788;
const PASSKEY_FILE = "demo-passkey.json";

export interface DemoOptions {
  /** The gateway's data dir; the demo uses `<dataDir>/demo`. */
  dataDir: string;
  /** The confirm page's port; 0 or absent picks a free one. */
  port?: number;
  /** The confirm page's listen address (ConfirmPageOptions.bind); the Docker image passes 0.0.0.0. */
  bind?: string;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
}

export interface Demo {
  /** The demo Intent Cloud, `http://127.0.0.1:<port>`. */
  cloudUrl: string;
  /** The published test root, in the `--trust-keys` file shape. */
  trustKeys: { rootKeys: PinnedRootKey[] };
  /** Pass as GatewayOptions.demo.confirmBaseUrl: `http://127.0.0.1:<port>/confirm`. */
  confirmBaseUrl: string;
  /** `<dataDir>/demo`: open the store here. */
  dataDir: string;
  /** The demo passkey the confirm page signs with; the same key on every run over the same data dir. */
  passkey: SoftPasskey;
  /** For tests: the fake behind the demo. */
  cloud: FakeCloud;
  close(): Promise<void>;
}

/** The demo's data dir under the gateway's, for `--demo` on commands that only read the chain. */
export function demoDataDir(dataDir: string): string {
  return join(dataDir, DEMO_DIR);
}

/** The demo's trust keys (the published test root), for `--demo` on commands that only read the chain. */
export function demoTrustKeys(): { rootKeys: PinnedRootKey[] } {
  return { rootKeys: [TEST_ROOT_KEY] };
}

export async function startDemo(options: DemoOptions): Promise<Demo> {
  const dataDir = demoDataDir(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const passkey = demoPasskey(dataDir);
  const cloud = await startFakeCloud(options.now === undefined ? {} : { now: options.now });
  try {
    const page = await startConfirmPage({
      fake: cloud,
      passkey,
      port: options.port ?? 0,
      ...(options.bind === undefined ? {} : { bind: options.bind }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return {
      cloudUrl: cloud.url,
      trustKeys: { rootKeys: [cloud.keys.rootPin] },
      confirmBaseUrl: page.origin + CONFIRM_PATH,
      dataDir,
      passkey,
      cloud,
      close: async () => {
        await page.close();
        await cloud.close();
      },
    };
  } catch (error) {
    await cloud.close();
    throw error;
  }
}

interface PasskeyFile {
  v: 1;
  credential_id: string;
  sub: string;
  private_key_pem: string;
}

/** The demo passkey of this data dir: made on first use and kept (0600), so the approver pin holds across runs. */
function demoPasskey(dir: string): SoftPasskey {
  const file = join(dir, PASSKEY_FILE);
  const info = lstatOrNull(file);
  if (info === null) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fresh = new SoftPasskey({ sub: "demo-buyer", privateKey });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const saved: PasskeyFile = { v: 1, credential_id: fresh.credentialId, sub: fresh.sub, private_key_pem: pem };
    writeFileSync(file, `${JSON.stringify(saved)}\n`, { mode: 0o600, flag: "wx" });
    return fresh;
  }
  if (!info.isFile()) throw new Error(`${file} is not a regular file`);
  const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<PasskeyFile>;
  if (saved.v !== 1 || typeof saved.credential_id !== "string" || typeof saved.sub !== "string" || typeof saved.private_key_pem !== "string") {
    throw new Error(`${file} is not a demo passkey file; delete it to make a new demo passkey`);
  }
  return new SoftPasskey({ credentialId: saved.credential_id, sub: saved.sub, privateKey: createPrivateKey(saved.private_key_pem) });
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
