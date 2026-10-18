// `intent demo`: the fake Intent Cloud in-process on 127.0.0.1 with the sample catalog and the published test keys,
// plus the local confirm page, so a developer can try the whole flow before any real Intent Cloud is reachable.
//
// The demo keeps its chain in `<data>/demo`, apart from the real one; the gateway marks it with a demo `session`
// entry and refuses to mix the two (GatewayOptions.demo). Its trust keys are returned, never added to PINNED_HOSTS.
import { createPrivateKey, generateKeyPairSync, randomInt } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, type Stats, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CatalogItem, catalogCategories, type FakeCloud, SAMPLE_CATALOG, SoftPasskey, startFakeCloud } from "../cloud-fake/index.ts";
import { connectShop } from "../disclosure/index.ts";
import type { OneTapOptions } from "../gateway/index.ts";
import { memoryCheckoutIds } from "../wallet/index.ts";
import { FAKE_STORE, FAKE_STOREFRONT, FAKE_VARIANT, type FakeShop, SHIPPING_MINOR, startFakeShop, UNIT_PRICE_MINOR } from "../wallet-shop-fake/index.ts";
import { EXCLUDED_CATEGORIES } from "../policy/index.ts";
import { type PinnedRootKey, TEST_ROOT_KEY } from "../trust/index.ts";
import { CONFIRM_PATH, type ConfirmPage, startConfirmPage } from "./confirm.ts";

export const DEMO_DIR = "demo";
/**
 * The confirm page's port unless INTENT_DEMO_CONFIRM_PORT names another. It is fixed so that `ssh -L 8788:127.0.0.1:8788`
 * can be set up before the demo starts, and so that the Docker image's `-p 127.0.0.1:8788:8788` maps it to the host.
 */
export const DEMO_CONFIRM_PORT = 8788;
const PASSKEY_FILE = "demo-passkey.json";

/**
 * The demo's one-tap item (plan G7c): sold by the demo Shop store, so a cart for it is completed by the gateway with
 * the fake Shop wallet instead of being handed off. Its price and variant are the fake Shop's.
 */
export const DEMO_ONE_TAP_ITEM: CatalogItem = Object.freeze<CatalogItem>({
  category: "stickers",
  tags: ["holographic", "sticker"],
  stock: 100,
  merchant: { name: "Sticker Store (demo Shop)", domain: new URL(FAKE_STOREFRONT).host },
  title: "Holographic sticker",
  variant: "Default",
  price: { amount_minor: UNIT_PRICE_MINOR, currency: "USD" },
  shipping: { amount_minor: SHIPPING_MINOR, currency: "USD" },
  total_kind: "exact",
  availability: "in_stock",
  variant_ref: FAKE_VARIANT,
  completion: ["shop_agent", "handoff"],
});
const DEMO_CATALOG: readonly CatalogItem[] = [...SAMPLE_CATALOG, DEMO_ONE_TAP_ITEM];
/** The demo code of the running demo (0600), for a person whose gateway was started by an agent, with no terminal. */
export const CODE_FILE = "approval-code";

export interface DemoOptions {
  /** The gateway's data dir; the demo uses `<dataDir>/demo`. */
  dataDir: string;
  /** The confirm page's port; 0 or absent picks a free one. */
  port?: number;
  /** When `port` is taken, listen on a free port instead of failing; Demo.confirmPortBusy then says so. */
  portFallback?: boolean;
  /** The confirm page's listen address (ConfirmPageOptions.bind); the Docker image passes 0.0.0.0. */
  bind?: string;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
  /**
   * The command a person runs to read the code file, shown on the confirm page: `cat` by default, or e.g.
   * `docker exec <container> cat` in the image.
   */
  readCommand?: string;
}

export interface Demo {
  /** The demo Intent Cloud, `http://127.0.0.1:<port>`. */
  cloudUrl: string;
  /** The published test root, in the `--trust-keys` file shape. */
  trustKeys: { rootKeys: PinnedRootKey[] };
  /** Pass as GatewayOptions.demo.confirmBaseUrl: `http://127.0.0.1:<port>/confirm`. */
  confirmBaseUrl: string;
  /** The port asked for, when it was taken and the confirm page fell back to a free one (portFallback); else null. */
  confirmPortBusy: number | null;
  /** `<dataDir>/demo`: open the store here. */
  dataDir: string;
  /** The demo passkey the confirm page signs with; the same key on every run over the same data dir. */
  passkey: SoftPasskey;
  /** The six-digit code Approve needs, new on every start: print it on stderr, never in a tool result. */
  code: string;
  /** `<dataDir>/demo/approval-code`, which holds `code`. */
  codeFile: string;
  /**
   * Pass as GatewayOptions.demo.catalogNote: the line a search that finds nothing adds, "The demo catalog has: …",
   * so the agent can try a kind of product the sample catalog holds.
   */
  catalogNote: string;
  /** For tests: the fake behind the demo. */
  cloud: FakeCloud;
  /** One-tap with the demo Shop wallet (a fake Shop on 127.0.0.1): pass as GatewayOptions.oneTap. */
  oneTap: OneTapOptions;
  /** For tests: the fake Shop behind one-tap. */
  shop: FakeShop;
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
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const codeFile = join(dataDir, CODE_FILE);
  writePrivate(codeFile, `${code}\n`);
  const cloud = await startFakeCloud({
    catalog: DEMO_CATALOG,
    oneTap: true,
    // As Intent Cloud does: an item in an excluded category is never returned, whatever the search says.
    excludedCategories: EXCLUDED_CATEGORIES,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let shop: FakeShop | null = null;
  try {
    shop = await startFakeShop();
    const demoShop = shop;
    // The demo wallet's tokens are the fake's own; its checkout ids stay in memory (a demo restart hands off anew).
    const vaultText = JSON.stringify({ v: 1, client_id: demoShop.clientId, access_token: demoShop.accessToken, refresh_token: demoShop.refreshToken });
    const oneTap: OneTapOptions = {
      connect: (owner) => connectShop(owner, { mcpUrl: demoShop.mcpUrl, authUrl: demoShop.authUrl, vaultText, checkoutIds: memoryCheckoutIds() }),
      storeFor: (origin) => (origin === FAKE_STOREFRONT ? FAKE_STORE : null),
    };
    const pageOn = (port: number): Promise<ConfirmPage> =>
      startConfirmPage({
        fake: cloud,
        passkey,
        code,
        codeHint: `${options.readCommand ?? "cat"} ${codeFile}`,
        port,
        ...(options.bind === undefined ? {} : { bind: options.bind }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    const wanted = options.port ?? 0;
    let page: ConfirmPage;
    let confirmPortBusy: number | null = null;
    try {
      page = await pageOn(wanted);
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";
      if (!(busy && options.portFallback === true && wanted !== 0)) throw error;
      page = await pageOn(0);
      confirmPortBusy = wanted;
    }
    return {
      cloudUrl: cloud.url,
      trustKeys: { rootKeys: [cloud.keys.rootPin] },
      confirmBaseUrl: page.origin + CONFIRM_PATH,
      confirmPortBusy,
      dataDir,
      passkey,
      code,
      codeFile,
      catalogNote: demoCatalogNote(),
      cloud,
      oneTap,
      shop: demoShop,
      close: async () => {
        await page.close();
        await demoShop.close();
        await cloud.close();
      },
    };
  } catch (error) {
    await shop?.close();
    await cloud.close();
    throw error;
  }
}

/** "The demo catalog has: running shoes, water bottles, …": the sample catalog's kinds of product, excluded ones left out. */
export function demoCatalogNote(): string {
  return `The demo catalog has: ${catalogCategories(DEMO_CATALOG, EXCLUDED_CATEGORIES).join(", ")}.`;
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

/** Replaces `file` with `text`, readable by its owner only. */
function writePrivate(file: string, text: string): void {
  const info = lstatOrNull(file);
  if (info !== null && !info.isFile()) throw new Error(`${file} is not a regular file`);
  const tmp = `${file}.${String(process.pid)}`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
