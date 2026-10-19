// The two halves of linking Shop (startShopLink, then finishShopLink) through the disclosure core, against the fake
// Shop. Attack (invariant 2): when the append of a token poll's disclosure fails, that poll is never sent.
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store, type StoreFs } from "../store/index.ts";
import { type FakeShop, startFakeShop } from "../wallet-shop-fake/index.ts";
import { finishShopLink, openPendingShopLink, openWalletSession, ShopPendingError, startShopLink } from "./index.ts";

let shop: FakeShop | undefined;
let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  await shop?.close();
  store = undefined;
  shop = undefined;
});

/** A store whose appends fail with ENOSPC while `fail.on` is set. */
async function failingStore(fail: { on: boolean }): Promise<Store> {
  const fs: StoreFs = {
    ...fsp,
    open: (async (...args: Parameters<typeof fsp.open>) => {
      const handle = await fsp.open(...args);
      if (String(args[0]).endsWith("audit.jsonl") && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0) {
        const write = handle.write.bind(handle);
        return Object.assign(handle, {
          write: (...w: Parameters<typeof write>) => (fail.on ? Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })) : write(...w)),
        });
      }
      return handle;
    }),
  };
  return openStore(join(await fsp.mkdtemp(join(tmpdir(), "shop-link-")), "data"), { fs });
}

describe("startShopLink and finishShopLink", () => {
  it("attack: the token poll's disclosure cannot be appended, so no token request leaves", async () => {
    shop = await startFakeShop();
    const fail = { on: false };
    store = await failingStore(fail);
    const session = openWalletSession(store);
    const where = { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, clientId: shop.clientId };
    let now = 0;
    const started = await startShopLink(session, { ...where, now: () => now });
    expect(shop.oauthRequests.map((q) => q.path)).toEqual(["/oauth/device"]);
    expect(started.pendingText).toContain(shop.deviceCode);
    const pending = openPendingShopLink(started.pendingText, where);
    expect(JSON.stringify(pending)).not.toContain(shop.deviceCode);
    fail.on = true;
    const sleep = (ms: number): Promise<void> => {
      now += ms;
      return Promise.resolve();
    };
    await expect(finishShopLink(session, pending, { ...where, sleep, now: () => now })).rejects.toThrow("ENOSPC");
    expect(shop.oauthRequests.map((q) => q.path)).toEqual(["/oauth/device"]);
  });

  it("a pending grant is opened only with the client, account server and resource it was made with", async () => {
    shop = await startFakeShop();
    store = await failingStore({ on: false });
    const where = { mcpUrl: shop.mcpUrl, authUrl: shop.authUrl, clientId: shop.clientId };
    const { pendingText } = await startShopLink(openWalletSession(store), { ...where, now: () => 0 });
    expect(() => openPendingShopLink(pendingText, { ...where, clientId: "other" })).toThrow(ShopPendingError);
    expect(() => openPendingShopLink(pendingText, { ...where, authUrl: "https://elsewhere.example/" })).toThrow(ShopPendingError);
    expect(() => openPendingShopLink(pendingText, { ...where, mcpUrl: "https://elsewhere.example/mcp" })).toThrow(ShopPendingError);
    expect(() => openPendingShopLink("{}", where)).toThrow(ShopPendingError);
    for (const bad of [() => openPendingShopLink(pendingText, { ...where, clientId: "other" }), () => openPendingShopLink("{}", where)]) {
      try {
        bad();
      } catch (error) {
        expect(String(error)).not.toContain(shop.deviceCode);
      }
    }
    expect(openPendingShopLink(pendingText, where).clientId).toBe(shop.clientId);
  });
});
