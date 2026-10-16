// A started gateway against the fake Intent Cloud, with a fresh data dir, for the MCP tests and the stdio entry.
// TEST KEYS ONLY.
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeCloud, startFakeCloud } from "../../src/cloud-fake/index.ts";
import { connectCloud } from "../../src/disclosure/index.ts";
import { createGateway, type Gateway } from "../../src/gateway/index.ts";
import { loadPolicy } from "../../src/policy/index.ts";
import { createSession } from "../../src/signing/index.ts";
import { openStore, type Store } from "../../src/store/index.ts";

export interface TestGateway {
  gateway: Gateway;
  fake: FakeCloud;
  store: Store;
  close(): Promise<void>;
}

/** The search the fake catalogue answers with running shoes. */
export const SHOES = { category: "running-shoes", budget_usd: 200, zip: "94103" } as const;

export async function startTestGateway(options: { log?: (line: string) => void } = {}): Promise<TestGateway> {
  const fake = await startFakeCloud({});
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "mcp-gateway-")), "data");
  const store = await openStore(dir);
  const session = createSession();
  const gateway = createGateway({
    cloud: (keySet) => connectCloud({ baseUrl: fake.url, session }, store, { keySet }),
    store,
    policy: loadPolicy("version: 1\napproval: passkey\n"),
    pinnedRootKeys: [fake.keys.rootPin],
    ...(options.log === undefined ? {} : { logger: { warn: options.log } }),
  });
  await gateway.start();
  return {
    gateway,
    fake,
    store,
    close: async () => {
      await store.close();
      await fake.close();
    },
  };
}
