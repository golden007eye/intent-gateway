// `intent verify` over `observed` entries: a local summary of what Intent Cloud returned for one acknowledged request,
// never sent and never a follow-up. A good one passes and changes no count; every forged or misplaced one fails by
// name, and an edited one breaks the chain (attack cases). Fixture chains are written by the real store and signed
// with the trust-kit test keys.
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PINNED, S1, signReceipt, STATEMENT_VALID_AT } from "../../test/support/trust-kit.ts";
import { type Entry, type EntryKind, openStore, type Store, type StoreFs } from "../store/index.ts";
import { type Report, runVerify } from "./index.ts";

vi.setConfig({ testTimeout: 20_000 });

const KEYID = "gw-Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc";
const NOW = new Date(STATEMENT_VALID_AT.getTime() + 3_600_000);
const fast: StoreFs = {
  ...fsp,
  open: (async (...args: Parameters<typeof fsp.open>) => Object.assign(await fsp.open(...args), { datasync: () => Promise.resolve() })),
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function chain(write: (s: Store) => Promise<unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-observed-"));
  dirs.push(root);
  const dir = join(root, "data");
  let t = STATEMENT_VALID_AT.getTime();
  const store = await openStore(dir, { clock: () => (t += 1000), fs: fast });
  await write(store);
  await store.close();
  return dir;
}

const verify = (dataDir: string): Promise<Report> => runVerify({ dataDir, pinnedRootKeys: PINNED, now: NOW, skipSupplyChain: true });

const bodyOf = (n: number) => Buffer.from(`{"category":"lamp ${String(n)}"}`, "utf8");
const digestOf = (bytes: Buffer) => `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`;
const sent = (n: number) => ({ method: "POST", path: "/v1/catalog/search", content_digest: digestOf(bodyOf(n)), keyid: KEYID, nonce: `nonce-${String(n)}`.padEnd(22, "A"), created: 1790251200 + n });

function response(request: object, status = 200) {
  const signed = signReceipt({ v: 1, kid: "cloud-receipt-202610", request, status, received_at: "2026-09-24T12:00:01Z" });
  return { status, receipt_header: signed.receipt, receipt_signature: signed.signature, contract_version: "1.5.0", verified: true };
}

const keys = (s: Store) => s.append("keys", { statement: S1.expected.statement });
const search = (s: Store, n: number) =>
  s.append("disclosure", { endpoint: "searchCatalog", fields: ["category"], body_b64: bodyOf(n).toString("base64"), headers: [], ...sent(n) });
const receipt = (s: Store, d: Entry, res: object) => s.append("receipt", { disclosure_seq: d.seq, ...res });
const followUp = (s: Store, kind: EntryKind, d: Entry) => s.append(kind, { disclosure_seq: d.seq, reason: "no response" });

const OFFER = { offer_handle: "of_xxxxxxxxxxxxxxxxxxxx", title: "Budget Running Shoe", merchant: "Resale Hub", price_minor: 3999, shipping_minor: 199, currency: "USD" };
const observation = (d: Entry, changes: Record<string, unknown> = {}) => ({
  disclosure_seq: d.seq,
  endpoint: "searchCatalog",
  offers_count: 1,
  offers_hidden: 0,
  offers: [OFFER],
  ...changes,
});

const check = (report: Report, name: string) => report.checks.find((c) => c.name === name);
const failures = (report: Report) => (check(report, "requests")?.details ?? []).filter((d) => d.startsWith("seq "));
const NO_RECEIPT = (at: number) => `seq ${String(at)}: the observed entry summarises the disclosure at seq 1, which has no verified receipt before it`;

describe("runVerify: observations", () => {
  it("an observation after a verified receipt passes, is reported apart, and changes no count; so does a block's held value", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      await receipt(s, d, response(sent(1)));
      await s.append("observed", observation(d));
      await s.append("block", { endpoint: "searchCatalog", fields: ["category"], blocked: ["categories.block at category"], held: { category: "alcohol" } });
    });
    const report = await verify(dir);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.counts).toEqual({ disclosures: 1, receipts: 1, responses: 0, unacknowledged: 0, unanswered: 0, discarded: 0, redactions: 0, approvals: 0, outcomes: 0, flags: 0 });
    expect(check(report, "requests")?.details).toContain("answers summarised in the log (kept here, never sent): 1");
  });

  // Review of #134, HIGH 1: the free-text postcode rules ran here too, so a preview.6 log with a GPU title or a held
  // car-parts category failed verify. They run on the agent's tool input only.
  it("an old log whose observed offer reads like a postcode (\"AMD Radeon RX 7900 XT\") and a held \"1972 VW Beetle parts\" verifies ok", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      await receipt(s, d, response(sent(1)));
      await s.append("observed", observation(d, { offers: [{ ...OFFER, title: "AMD Radeon RX 7900 XT" }] }));
      await s.append("block", { endpoint: "searchCatalog", fields: ["category"], blocked: ["categories.block at category"], held: { category: "1972 VW Beetle parts" } });
    });
    const report = await verify(dir);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("attack: an observation never answers a request: one in place of the receipt fails, and the request stays unanswered", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await s.append("observed", observation(await search(s, 1)));
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(report.counts).toMatchObject({ receipts: 0, unanswered: 1 });
    expect(failures(report)).toEqual([NO_RECEIPT(2)]);
  });

  it("attack: an observation before its receipt, or after an unacknowledged or discarded answer, fails", async () => {
    const before = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      await s.append("observed", observation(d));
      await receipt(s, d, response(sent(1)));
    });
    expect(failures(await verify(before))).toEqual([NO_RECEIPT(2)]);
    for (const kind of ["unacknowledged", "discarded"] as const) {
      const dir = await chain(async (s) => {
        await keys(s);
        const d = await search(s, 1);
        await followUp(s, kind, d);
        await s.append("observed", observation(d));
      });
      expect(failures(await verify(dir))).toContain(NO_RECEIPT(3));
    }
  });

  it("attack: an observation of an error answer, or of a receipt that does not verify, fails", async () => {
    const error = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      await receipt(s, d, response(sent(1), 404));
      await s.append("observed", observation(d));
    });
    expect(failures(await verify(error))).toEqual(["seq 3: the observed entry summarises the disclosure at seq 1, whose receipt is for status 404, not a success"]);
    const forged = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      await receipt(s, d, response(sent(2)));
      await s.append("observed", observation(d));
    });
    expect(failures(await verify(forged))).toContain(NO_RECEIPT(3));
  });

  it("attack: an observation naming no earlier disclosure, another endpoint's, or one already observed fails", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      const r = await receipt(s, d, response(sent(1)));
      await s.append("observed", observation(d));
      await s.append("observed", observation(d));
      await s.append("observed", observation(r));
      await s.append("observed", { ...observation(d), disclosure_seq: 99 });
      await s.append("observed", { disclosure_seq: d.seq, endpoint: "getApproval", approval_handle: "ap_x", state: "approved", title: "Lamp", merchant: "M", total_minor: 1, currency: "USD" });
    });
    expect(failures(await verify(dir))).toEqual([
      "seq 4: the observed entry repeats an observation of the disclosure at seq 1",
      "seq 5: the observed entry names disclosure_seq 2, which is not an earlier disclosure",
      "seq 6: the observed entry names disclosure_seq 99, which is not an earlier disclosure",
      "seq 7: the observed entry is for getApproval, but the disclosure at seq 1 is searchCatalog",
    ]);
  });

  it("attack: a malformed observation, or one holding buyer identity, fails; so does a block that keeps identity", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      await receipt(s, d, response(sent(1)));
      await s.append("observed", observation(d, { buyer: "Jane" }));
      await s.append("observed", observation(d, { offers: [{ ...OFFER, title: "for jane@mail.example" }] }));
      await s.append("block", { endpoint: "searchCatalog", fields: ["product"], blocked: ["categories.block at category"], held: { product: "call (415) 555-2671" } });
    });
    const found = failures(await verify(dir));
    expect(found[0]).toMatch(/^seq 3: the observed entry is not an observation \(.*buyer/);
    expect(found[1]).toBe("seq 4: the observed entry holds what looks like buyer identity (email at $.offers[0].title)");
    expect(found[2]).toBe("seq 5: the block entry keeps what looks like buyer identity in held (phone)");
  });

  it("attack: editing an observation without re-hashing breaks the chain at its seq", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await search(s, 1);
      await receipt(s, d, response(sent(1)));
      await s.append("observed", observation(d));
    });
    const file = join(dir, "audit.jsonl");
    await writeFile(file, (await readFile(file, "utf8")).replace('"offers_count":1', '"offers_count":7'));
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "log")?.details[0]).toBe("broken at entry #3: hash does not match the entry");
  });
});
