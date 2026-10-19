// The pending sign-in grant in the wallet vault: sealed 0600 like the tokens, claimed by one process at a time, put
// back or deleted, never read through a link, and a file that does not open is deleted, never handed out.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimPendingGrant, pendingGrantPath, savePendingGrant, saveSecret, WalletKey, WalletVaultError } from "./index.ts";

const GRANT = '{"v":1,"device_code":"device-code-SECRET-0123456789"}';
const dataDir = (): string => join(mkdtempSync(join(tmpdir(), "wallet-pending-")), "data");
const key = (): WalletKey => new WalletKey(randomBytes(32), "test");
const names = (dir: string): string[] => readdirSync(join(dir, "wallet")).sort();
const posix = process.platform !== "win32";

describe("the pending grant", () => {
  it.runIf(posix)("is sealed 0600 under the wallet key; a claim takes it once, and discard deletes it", async () => {
    const dir = dataDir();
    const k = key();
    expect(await savePendingGrant(dir, "shop", k, GRANT)).toEqual({ replaced: false });
    const file = pendingGrantPath(dir, "shop");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).toString("latin1")).not.toContain("device-code-SECRET");
    const claim = await claimPendingGrant(dir, "shop", k);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(claim.grant.text).toBe(GRANT);
    // Held by this (running) process: a second claim is told it is busy.
    expect(await claimPendingGrant(dir, "shop", k)).toEqual({ kind: "busy", pid: process.pid });
    await claim.grant.discard();
    expect(names(dir)).toEqual([]);
    expect(await claimPendingGrant(dir, "shop", k)).toEqual({ kind: "none" });
  });

  it("release puts it back, unless a newer grant was saved meanwhile", async () => {
    const dir = dataDir();
    const k = key();
    await savePendingGrant(dir, "shop", k, GRANT);
    const first = await claimPendingGrant(dir, "shop", k);
    if (first.kind !== "claimed") throw new Error("not claimed");
    await first.grant.release();
    expect(names(dir)).toEqual(["shop-pending.enc"]);
    const again = await claimPendingGrant(dir, "shop", k);
    if (again.kind !== "claimed") throw new Error("not claimed");
    await savePendingGrant(dir, "shop", k, '{"v":1,"newer":true}');
    await again.grant.release();
    const newest = await claimPendingGrant(dir, "shop", k);
    expect(newest.kind === "claimed" && newest.grant.text).toBe('{"v":1,"newer":true}');
  });

  it("attack: a pending file that does not open (another key, a changed byte, another rail's file) is deleted and refused", async () => {
    const dir = dataDir();
    await savePendingGrant(dir, "shop", key(), GRANT);
    await expect(claimPendingGrant(dir, "shop", key())).rejects.toBeInstanceOf(WalletVaultError);
    expect(names(dir)).toEqual([]);
    // The tokens' file copied over the pending name: the AAD differs, so it does not open.
    const k = key();
    await saveSecret(dir, "shop", k, GRANT);
    writeFileSync(pendingGrantPath(dir, "shop"), readFileSync(join(dir, "wallet", "shop.enc")), { mode: 0o600 });
    await expect(claimPendingGrant(dir, "shop", k)).rejects.toBeInstanceOf(WalletVaultError);
  });

  it.runIf(posix)("attack: a pending file that is a symbolic link is never read through", async () => {
    const dir = dataDir();
    const k = key();
    await savePendingGrant(dir, "shop", k, GRANT);
    const elsewhere = join(dir, "elsewhere.enc");
    writeFileSync(elsewhere, readFileSync(pendingGrantPath(dir, "shop")), { mode: 0o600 });
    unlinkSync(pendingGrantPath(dir, "shop"));
    symlinkSync(elsewhere, pendingGrantPath(dir, "shop"));
    // The rename moves the link itself; opening the claim refuses it as a link.
    await expect(claimPendingGrant(dir, "shop", k)).rejects.toThrow(/symbolic link/);
  });
});
