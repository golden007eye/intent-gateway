// A data dir whose chain the real gateway wrote against the fake Intent Cloud: searches, carts, passkey approvals and,
// on request, the hand-off and the merchant's order (outcome entries). For the evidence pack tests. TEST KEYS ONLY.
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeCloud, SoftPasskey, startFakeCloud } from "../../src/cloud-fake/index.ts";
import { connectCloud } from "../../src/disclosure/index.ts";
import { createGateway, type Gateway } from "../../src/gateway/index.ts";
import { loadPolicy } from "../../src/policy/index.ts";
import { createSession, openCompleterKeys } from "../../src/signing/index.ts";
import { openStore, type Store } from "../../src/store/index.ts";
import type { PinnedRootKey } from "../../src/trust/index.ts";

export interface PurchaseChain {
  readonly dir: string;
  readonly rootPin: PinnedRootKey;
  readonly gateway: Gateway;
  readonly fake: FakeCloud;
  readonly store: Store;
  /** Searches, carts the offer at `index` and approves it with the one passkey; `ordered` also hands off and orders. Returns the approval handle. */
  buy(index: number, options?: { ordered?: boolean }): Promise<string>;
  /** Closes the store and the fake; the data dir stays for the test to read. */
  close(): Promise<void>;
}

const SHOES = { category: "running-shoes", budget_usd: 200, zip: "94103" } as const;

export async function purchaseChain(): Promise<PurchaseChain> {
  const fake = await startFakeCloud({});
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "evidence-")), "data");
  const store = await openStore(dir);
  const session = createSession();
  const passkey = new SoftPasskey();
  const gateway = createGateway({
    cloud: (keySet) => connectCloud({ baseUrl: fake.url, session }, store, { keySet }),
    store,
    completerKeys: openCompleterKeys(dir),
    policy: loadPolicy("version: 1\napproval: passkey\n"),
    pinnedRootKeys: [fake.keys.rootPin],
    logger: { warn: () => undefined },
  });
  await gateway.start();
  const status = (handle: string) => gateway.getApprovalStatus({ approval_handle: handle });
  return {
    dir,
    rootPin: fake.keys.rootPin,
    gateway,
    fake,
    store,
    async buy(index, options = {}) {
      const found = await gateway.findOffers(SHOES);
      if (found.status !== "offers") throw new Error(`no offers: ${found.message}`);
      const offer = found.offers[index];
      if (offer === undefined) throw new Error(`no offer ${String(index)}`);
      const cart = await gateway.createCart({ offer_handle: offer.offer_handle });
      if (cart.status !== "approval_needed") throw new Error(`no approval: ${cart.message}`);
      const handle = cart.approval_handle;
      if (fake.approveWithPasskey(handle, passkey).status !== 200) throw new Error("the fake refused the approval");
      if ((await status(handle)).status !== "approved") throw new Error("not approved");
      if (options.ordered === true) {
        fake.handoff(handle);
        await status(handle);
        fake.order(handle);
        await status(handle);
      }
      return handle;
    },
    async close() {
      await store.close();
      await fake.close();
    },
  };
}
