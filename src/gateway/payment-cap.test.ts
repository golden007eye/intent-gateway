// The per-order cap at payment for a purchase outside the US (one tap, after the passkey). Contract 1.7.0's approval
// status carries its display total as USD-only Money, so a CAD or AUD approval cannot be read back through
// get_approval_status yet; these tests drive the lowest level that holds the rule instead: the cap the gateway hands
// the completion (paymentCapMinor, paymentOffer) and the completion's budget step itself (advanceCompletion).
// Attack cases: a total over the cap put in CAD (or AUD) is refused before anything is paid, and CAD is never counted
// as if it were USD.
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BindableApprovalProof, SnapshotV4 } from "../contract/index.ts";
import type { DisclosedCloud } from "../disclosure/index.ts";
import { evaluate, loadPolicy } from "../policy/index.ts";
import { type Entry, openStore, type Store } from "../store/index.ts";
import type { KeySet } from "../trust/index.ts";
import type { WalletAccount, WalletAdapter } from "../wallet/index.ts";
import { advanceCompletion } from "./complete.ts";
import { paymentCapMinor, paymentOffer } from "./gateway.ts";

/** Intent Cloud's currency table (minor units). */
const TABLE = { USD: { order: 5000, week: 10_000 }, CAD: { order: 7000, week: 14_000 }, AUD: { order: 7500, week: 15_000 } };
const T0 = Date.parse("2026-10-18T12:00:00Z");
const A4 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "a4-snapshot-v4.json"), "utf8")) as {
  cases: { input: { snapshot: SnapshotV4 } }[];
};
/** Vector a4's shop_agent snapshot (total 18.07), shipped to `country` in `currency`. */
function snapshotIn(currency: string, country: "CA" | "AU"): SnapshotV4 {
  const s = A4.cases[0]?.input.snapshot as SnapshotV4;
  return { ...s, currency, ship_to: { country, postal_code_coarse: country === "CA" ? "K1A" : "2000" } };
}
const spend = (usd: number) => loadPolicy(`version: 1\napproval: passkey\nspend:\n  per_order_usd: ${String(usd)}\n`).spend;

describe("the per-order cap handed to the completion, in the approved currency", () => {
  it.each([
    // $10 is CAD 14.00 (× 7000/5000) and AUD 15.00 (× 7500/5000); counted as USD it would be 10.00.
    ["CAD", "CA", 1400],
    ["AUD", "AU", 1500],
  ] as const)("%s: the cap is scaled, never the USD amount", (currency, country, minor) => {
    expect(paymentCapMinor(spend(10), snapshotIn(currency, country), TABLE)).toBe(minor);
  });

  it("attack: a cap that cannot be put in the currency is 0 (nothing is paid), and no cap stays none", () => {
    expect(paymentCapMinor(spend(10), snapshotIn("CAD", "CA"), null)).toBe(0);
    expect(paymentCapMinor(spend(10), snapshotIn("CAD", "CA"), { USD: TABLE.USD })).toBe(0);
    expect(paymentCapMinor(loadPolicy("version: 1\napproval: passkey\n").spend, snapshotIn("CAD", "CA"), TABLE)).toBeNull();
  });

  it("the purchase is counted against the daily and weekly caps in its own currency (paymentOffer)", () => {
    const offer = paymentOffer(snapshotIn("CAD", "CA"));
    expect(offer).toMatchObject({ currency: "CAD", quantity: 1 });
    // CAD 18.07 against a $10 daily cap: over CAD 14, though 18.07 would pass a $20 cap counted as USD.
    const daily = loadPolicy("version: 1\napproval: passkey\nspend:\n  per_day_usd: 10\n");
    expect(evaluate(daily, { kind: "cart", offer }, [], T0, TABLE).blocked.map((b) => b.reason)).toEqual(["over the CAD 14 per day limit"]);
    const twenty = loadPolicy("version: 1\napproval: passkey\nspend:\n  per_day_usd: 13\n");
    // $13 is CAD 18.20: the CAD 18.07 total fits, as it would not against USD 13.00.
    expect(evaluate(twenty, { kind: "cart", offer }, [], T0, TABLE).send).toBe(true);
  });
});

let stores: Store[] = [];
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
});

/** The completion's budget step for one CAD or AUD purchase, with a wallet that shows `budget` in its currency. */
async function budgetStep(snapshot: SnapshotV4, capMinor: number | null) {
  const store = await openStore(join(await fsp.mkdtemp(join(tmpdir(), "payment-cap-")), "data"), { clock: () => T0 });
  stores.push(store);
  const account: WalletAccount = { budgetRemaining: { amountMinor: 50_000, currency: snapshot.currency }, budgetLimit: null, manageUrl: null, connected: true };
  const wallet = { rail: "shop", account: () => Promise.resolve(account) } as unknown as WalletAdapter;
  const pending = { seq: 0, kind: "approval_pending", body: { handle: snapshot.approval } } as unknown as Entry;
  const proof = { snapshot } as unknown as BindableApprovalProof;
  return advanceCompletion(
    {
      store,
      cloud: {} as DisclosedCloud,
      wallet,
      // No storefront: a purchase past the budget step stops at the store pair check, before anything is sent.
      storefront: null,
      oneTapAllowed: true,
      perOrderCapMinor: capMinor,
      signer: undefined,
      keys: {} as KeySet,
      now: () => T0,
    },
    { handle: snapshot.approval, pending, proof },
  );
}

describe("the completion's budget step outside the US", () => {
  it.each([
    ["CAD", "CA"],
    ["AUD", "AU"],
  ] as const)("attack (%s): a total over the scaled cap is refused at payment, before any checkout read or payment", async (currency, country) => {
    const s = snapshotIn(currency, country);
    // $10 → CAD 14.00 / AUD 15.00, below the 18.07 total.
    const view = await budgetStep(s, paymentCapMinor(spend(10), s, TABLE));
    expect(view).toMatchObject({ state: "failed", reason: "budget" });
  });

  it.each([
    ["CAD", "CA"],
    ["AUD", "AU"],
  ] as const)("%s: a total under the scaled cap passes the budget step (it stops later, at the store pair check)", async (currency, country) => {
    const s = snapshotIn(currency, country);
    // $13 → CAD 18.20 / AUD 19.50: the 18.07 total fits, as it would not against USD 13.00.
    const view = await budgetStep(s, paymentCapMinor(spend(13), s, TABLE));
    expect(view.reason).not.toBe("budget");
    expect(view).toMatchObject({ state: "failed", reason: "store_pair:fetch_failed" });
  });
});
