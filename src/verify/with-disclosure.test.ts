// verify over a chain the real disclosure module wrote while talking to the fake Intent Cloud: the entry bodies
// verify reads are the ones disclosure writes, including the key-bootstrap receipts logged with `verified: false`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATEMENT_VALID_AT } from "../../test/support/trust-kit.ts";
import { type FakeCloud, startFakeCloud } from "../cloud-fake/index.ts";
import { connectCloud, DisclosureDiscardedError } from "../disclosure/index.ts";
import { createSession } from "../signing/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { type KeySet, verifyStatement } from "../trust/index.ts";
import { formatReport, runVerify } from "./index.ts";

vi.setConfig({ testTimeout: 20_000 });

const NOW_MS = STATEMENT_VALID_AT.getTime();
const SEARCH = { ship_to: { postal_code: "94110", country: "US" as const }, product: "trail shoe" };
const open: { cloud: FakeCloud; store: Store; dir: string }[] = [];
afterEach(async () => {
  for (const { cloud, store, dir } of open.splice(0)) {
    await store.close();
    await cloud.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Bootstraps the keys as the gateway does: meta and key statement unverified, then a `keys` entry, then a search. */
async function session() {
  const cloud = await startFakeCloud({ now: () => NOW_MS });
  const root = await mkdtemp(join(tmpdir(), "verify-disclosure-"));
  const dir = join(root, "data");
  const store = await openStore(dir, { clock: () => NOW_MS });
  open.push({ cloud, store, dir: root });
  let keySet: KeySet | null = null;
  const disclosed = connectCloud({ baseUrl: cloud.url, session: createSession(), now: () => NOW_MS }, store, { keySet: () => keySet, now: () => NOW_MS });
  await disclosed.meta();
  const fetched = await disclosed.keyStatement();
  const verified = verifyStatement(fetched.body, [cloud.keys.rootPin], new Date(NOW_MS));
  if (!verified.ok) throw new Error(`fake statement did not verify: ${verified.reason}`);
  await store.append("keys", { statement: fetched.body });
  keySet = verified.keySet;
  await disclosed.search(SEARCH);
  const verify = () => runVerify({ dataDir: dir, pinnedRootKeys: [cloud.keys.rootPin], now: new Date(NOW_MS), skipSupplyChain: true });
  return { cloud, store, disclosed, verify };
}

describe("runVerify over a chain written by the disclosure module", () => {
  it("verifies, re-checking the bootstrap receipts against the recorded statement", async () => {
    const { store, verify } = await session();
    expect(store.entries().map((e) => [e.kind, (e.body as { verified?: unknown }).verified])).toEqual([
      ["disclosure", undefined],
      ["receipt", false],
      ["disclosure", undefined],
      ["receipt", false],
      ["keys", undefined],
      ["disclosure", undefined],
      ["receipt", true],
    ]);
    const report = await verify();
    expect(formatReport(report)).toMatch(/verify: ok\n$/);
    expect(report).toMatchObject({ exitCode: 0, head: { seq: 6 }, counts: { disclosures: 3, receipts: 3 } });
  });

  it("a 2xx whose receipt was dropped is discarded, and verify fails", async () => {
    const { cloud, disclosed, verify } = await session();
    cloud.tamper.dropReceipt();
    await expect(disclosed.search(SEARCH)).rejects.toBeInstanceOf(DisclosureDiscardedError);
    const report = await verify();
    expect(report).toMatchObject({ exitCode: 1, counts: { discarded: 1 } });
    expect(formatReport(report)).toContain("seq 8: discarded: a response to the disclosure at seq 7 came without a valid receipt");
  });
});
