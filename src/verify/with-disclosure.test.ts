// verify over a chain the real disclosure module wrote while talking to the fake Intent Cloud: the entry bodies
// verify reads are the ones disclosure writes, including the key-bootstrap receipts logged with `verified: false`.
import * as fsp from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATEMENT_VALID_AT } from "../../test/support/trust-kit.ts";
import { type FakeCloud, startFakeCloud } from "../cloud-fake/index.ts";
import { connectCloud, DisclosureDiscardedError, DisclosureStoppedError } from "../disclosure/index.ts";
import { createSession } from "../signing/index.ts";
import { openStore, type Store, type StoreFs } from "../store/index.ts";
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
async function session(fs?: StoreFs, at?: { cloud: FakeCloud; root: string }) {
  const cloud = at?.cloud ?? (await startFakeCloud({ now: () => NOW_MS }));
  const root = at?.root ?? (await mkdtemp(join(tmpdir(), "verify-disclosure-")));
  const dir = join(root, "data");
  const store = await openStore(dir, { clock: () => NOW_MS, ...(fs === undefined ? {} : { fs }) });
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
  return { cloud, store, disclosed, verify, root };
}

/** The real fs, except that after `failAfter(k)` the (k+1)-th append-mode open of a log fails with EMFILE, once. */
function emfileLater(): StoreFs & { failAfter: (k: number) => void } {
  let skip = -1;
  return {
    ...fsp,
    open: async (...args: Parameters<typeof fsp.open>) => {
      if (skip >= 0 && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0 && String(args[0]).endsWith("audit.jsonl")) {
        if (skip-- === 0) throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
      }
      return fsp.open(...args);
    },
    failAfter: (k) => {
      skip = k;
    },
  };
}

describe("runVerify over a chain written by the disclosure module", () => {
  it("verifies, re-checking the bootstrap receipts against the recorded statement", async () => {
    const { store, verify } = await session();
    expect(store.entries().map((e) => [e.kind, (e.body as { verified?: unknown }).verified])).toEqual([
      ["session", undefined],
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
    expect(report).toMatchObject({ exitCode: 0, head: { seq: 7 }, counts: { disclosures: 3, receipts: 3 } });
  });

  it("a 2xx whose receipt was dropped is discarded, and verify fails", async () => {
    const { cloud, disclosed, verify } = await session();
    cloud.tamper.dropReceipt();
    await expect(disclosed.search(SEARCH)).rejects.toBeInstanceOf(DisclosureDiscardedError);
    const report = await verify();
    expect(report).toMatchObject({ exitCode: 1, counts: { discarded: 1 } });
    expect(formatReport(report)).toContain("seq 9: discarded: a response to the disclosure at seq 8 came without a valid receipt");
  });

  it("attack (F-m): the discarded entry cannot be appended; the gateway stops, and after a restart verify lists it as no answer recorded", async () => {
    const fs = emfileLater();
    const first = await session(fs);
    first.cloud.tamper.dropReceipt();
    fs.failAfter(1); // the disclosure goes on disk; its `discarded` follow-up does not
    await expect(first.disclosed.search(SEARCH)).rejects.toBeInstanceOf(DisclosureStoppedError);
    // Later calls are refused before anything is logged (so before anything is sent), though the open() failure
    // was transient. The disclosure module's own tests count the bytes that reach the network.
    const logged = first.store.entries().length;
    await expect(first.disclosed.search(SEARCH)).rejects.toBeInstanceOf(DisclosureStoppedError);
    expect(first.store.entries().length).toBe(logged);
    expect(first.store.entries().at(-1)?.kind).toBe("disclosure");
    const stopped = await first.verify();
    expect(stopped.exitCode).toBe(0);
    expect(stopped.counts).toMatchObject({ unanswered: 1 });

    // A restart starts a new gateway session: the unanswered disclosure stays the last of its own, and verify passes.
    await first.store.close();
    first.cloud.tamper.reset();
    const second = await session(undefined, { cloud: first.cloud, root: first.root });
    const report = await second.verify();
    expect(formatReport(report)).toMatch(/verify: ok\n$/);
    expect(report.counts).toMatchObject({ disclosures: 7, unanswered: 1 });
  });
});
