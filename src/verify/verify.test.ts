// `intent verify` over fixture chains written by the real store and signed with the trust-kit test keys. Each tamper
// case must exit non-zero and name its failure; honest network failures (unacknowledged) must not.
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTarGz, routedFetch, sha512, type Route } from "../../test/support/fake-registry.ts";
import { createTestSigstore } from "../../test/support/sigstore-ca.ts";
import { makeProof, pendingEntry, PINNED, S1, SNAPSHOT, signReceipt, signStatement, STATEMENT_VALID_AT, TestPasskey } from "../../test/support/trust-kit.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { type Entry, type EntryKind, openStore, type Store, type StoreFs } from "../store/index.ts";
import { approverFingerprint } from "../trust/index.ts";
import * as fsp from "node:fs/promises";
import { formatReport, type Report, runVerify, type VerifyOptions } from "./index.ts";

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

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Writes a chain with the real store, one second per entry from the statement's valid_at. */
async function chain(write: (s: Store) => Promise<unknown>): Promise<string> {
  const dir = join(await tempDir("verify-"), "data");
  let t = STATEMENT_VALID_AT.getTime();
  const store = await openStore(dir, { clock: () => (t += 1000), fs: fast });
  await write(store);
  await store.close();
  return dir;
}

const verify = (dataDir: string, extra: Partial<VerifyOptions> = {}): Promise<Report> =>
  runVerify({ dataDir, pinnedRootKeys: PINNED, now: NOW, skipSupplyChain: true, ...extra });

const bodyOf = (n: number) => Buffer.from(`{"query":"lamp ${String(n)}"}`, "utf8");
const digestOf = (bytes: Buffer) => `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`;

/** The request the gateway signed and sent for body `n`; the digest is computed here, not by the code under test. */
function sent(n: number) {
  return { method: "POST", path: "/v1/catalog/search", content_digest: digestOf(bodyOf(n)), keyid: KEYID, nonce: `nonce-${String(n)}`.padEnd(22, "A"), created: 1790251200 + n };
}

/** The receipt-entry fields for a receipt over `request`, as the disclosure module logs them. */
function response(request: object, opts: { status?: number; kid?: string; key?: Parameters<typeof signReceipt>[1] } = {}) {
  const status = opts.status ?? 200;
  const signed = signReceipt({ v: 1, kid: opts.kid ?? "cloud-receipt-202610", request, status, received_at: "2026-09-24T12:00:01Z" }, opts.key);
  return { status, receipt_header: signed.receipt, receipt_signature: signed.signature, contract_version: "1.5.0", verified: true };
}

const keys = (s: Store, statement: unknown = S1.expected.statement) => s.append("keys", { statement });
/** A disclosure body in the disclosure module's shape (src/disclosure). */
const disclose = (s: Store, n: number, changes: Record<string, unknown> = {}) =>
  s.append("disclosure", {
    endpoint: "search",
    fields: ["query"],
    body_b64: bodyOf(n).toString("base64"),
    headers: [],
    ...sent(n),
    ...changes,
  });
const receipt = (s: Store, d: Entry, res: object) => s.append("receipt", { disclosure_seq: d.seq, ...res });
const followUp = (s: Store, kind: EntryKind, d: Entry, reason: string) => s.append(kind, { disclosure_seq: d.seq, reason });

/** A verified approval as the gateway chains it: pending, the pin for the first passkey, then {handle, proof}. */
async function approve(s: Store, passkey: TestPasskey, proof = makeProof({ passkey }), pin = true) {
  await s.append("approval_pending", pendingEntry().body);
  if (pin) await s.append("approver_pin", pinBody(passkey));
  await s.append("approval", { handle: "ap_TEST0001", proof });
}

const pinBody = (passkey: TestPasskey) => ({ fingerprint: approverFingerprint(passkey.jwk as never), credential_id: "Y3JlZC0y", credential_public_key: passkey.jwk });

const check = (report: Report, name: string) => report.checks.find((c) => c.name === name);
const failed = (report: Report) => report.checks.filter((c) => !c.ok).map((c) => c.name);

async function lastEntry(dir: string): Promise<Entry> {
  const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trimEnd().split("\n");
  return JSON.parse(lines.at(-1) ?? "") as Entry;
}

describe("runVerify: a clean chain", () => {
  it("exits 0 and reports the head seq and hash", async () => {
    const passkey = new TestPasskey("ES256");
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await disclose(s, 1);
      await receipt(s, d, response(sent(1)));
      await approve(s, passkey);
    });
    const report = await verify(dir);
    const head = await lastEntry(dir);
    expect(failed(report)).toEqual([]);
    expect(report).toMatchObject({ ok: true, exitCode: 0, head: { seq: 5, hash: head.hash } });
    expect(report.counts).toEqual({ disclosures: 1, receipts: 1, unacknowledged: 0, unanswered: 0, discarded: 0, approvals: 1, flags: 0 });
    const text = formatReport(report);
    expect(text).toContain(`head: seq 5 hash ${head.hash}\n`);
    expect(text).toContain("sent, not acknowledged: 0\n");
    expect(text).toContain("acknowledged by a receipt from Intent Cloud's public edge: 1\n");
    expect(text).toMatch(/verify: ok\n$/);
  });

  it("an unacknowledged send exits 0 and prints sent, not acknowledged: 1", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await followUp(s, "unacknowledged", await disclose(s, 1), "no response");
      const d = await disclose(s, 2);
      await receipt(s, d, response(sent(2)));
    });
    const report = await verify(dir);
    expect(report).toMatchObject({ ok: true, exitCode: 0 });
    expect(report.counts).toMatchObject({ disclosures: 2, receipts: 1, unacknowledged: 1 });
    expect(formatReport(report)).toContain("  sent, not acknowledged: 1\n");
  });

  it("an empty chain verifies with the genesis head", async () => {
    const dir = join(await tempDir("verify-"), "data");
    await mkdir(dir);
    await writeFile(join(dir, "audit.jsonl"), "");
    expect(await verify(dir)).toMatchObject({ exitCode: 0, head: { seq: -1, hash: "0".repeat(64) } });
  });

  it("an approver flag is reported, and is not a failure by itself", async () => {
    const pinned = new TestPasskey("ES256");
    const dir = await chain(async (s) => {
      await keys(s);
      await approve(s, pinned);
      await s.append("approver_flag", pinBody(new TestPasskey("ES256")));
    });
    const report = await verify(dir);
    expect(report).toMatchObject({ exitCode: 0, counts: { approvals: 1, flags: 1 } });
    expect(formatReport(report)).toMatch(/approver flags: ok\n {2}flagged: 1\n {2}seq 4: a passkey other than the pinned approver signed an approval, not counted as approved \(fingerprint /);
  });
});

describe("runVerify: a gateway that stopped mid-request (F-l)", () => {
  /** What a gateway killed after logging a send and before recording its answer leaves: a disclosure, then nothing. */
  async function killedMidRequest(after: (s: Store) => Promise<unknown> = () => Promise.resolve()): Promise<string> {
    return chain(async (s) => {
      await keys(s);
      await receipt(s, await disclose(s, 1), response(sent(1)));
      await disclose(s, 2);
      await after(s);
    });
  }

  it("passes, and reports the request as logged, maybe sent, with no answer recorded; never as sent or acknowledged", async () => {
    const dir = await killedMidRequest();
    const report = await verify(dir);
    expect(failed(report)).toEqual([]);
    expect(report).toMatchObject({ ok: true, exitCode: 0, head: { seq: 3 } });
    expect(report.counts).toMatchObject({ disclosures: 2, receipts: 1, unacknowledged: 0, unanswered: 1 });
    const text = formatReport(report);
    expect(text).toContain("  sent: 1\n");
    expect(text).toContain("  logged, maybe sent, no answer recorded (the gateway stopped before it finished, or is still waiting): 1 (seq 3)\n");
    expect(text).toContain("  sent, not acknowledged: 0\n");
    expect(text).toMatch(/verify: ok\n$/);
  });

  it("passes when the next start appended after it (the request stays unanswered, inside the chain)", async () => {
    const dir = await killedMidRequest(async (s) => {
      await keys(s);
      await receipt(s, await disclose(s, 3), response(sent(3)));
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(0);
    expect(check(report, "disclosures")?.details).toContain(
      "logged, maybe sent, no answer recorded (the gateway stopped before it finished, or is still waiting): 1 (seq 3)",
    );
  });

  it("hides no other failure: a discarded response elsewhere still fails", async () => {
    const dir = await killedMidRequest(async (s) => {
      await followUp(s, "discarded", await disclose(s, 3), "200 without a receipt");
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "disclosures")?.details).toContain(
      "seq 5: discarded: a response to the disclosure at seq 4 came without a valid receipt (200 without a receipt)",
    );
  });

  it("attack: a forged `interrupted` entry is no entry kind, so it breaks the chain instead of closing anything", async () => {
    const dir = await killedMidRequest();
    const head = await lastEntry(dir);
    const fields = { seq: head.seq + 1, prev: head.hash, ts: "2026-09-24T12:00:09.000Z", kind: "interrupted", body: { disclosure_seq: 3 } };
    await writeFile(join(dir, "audit.jsonl"), `${canonicalize({ ...fields, hash: sha256Hex(canonicalize(fields)) })}\n`, { flag: "a" });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "chain")?.details[0]).toBe("broken at seq 4: unknown kind");
  });

  it("attack: a forged follow-up cannot turn a discarded response into ok: two follow-ups fail", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await disclose(s, 1);
      await followUp(s, "discarded", d, "200 without a receipt");
      await followUp(s, "unacknowledged", d, "the gateway stopped");
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain("seq 1: the disclosure has 2 follow-up entries (seq 2, 3); expected one");
    expect(details).toContain("seq 2: discarded: a response to the disclosure at seq 1 came without a valid receipt (200 without a receipt)");
  });

  it("attack: editing the unanswered disclosure still breaks the chain", async () => {
    const dir = await killedMidRequest();
    const file = join(dir, "audit.jsonl");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace('"fields":["query"]', '"fields":["nothing"]'));
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "chain")?.ok).toBe(false);
  });

  it("dropping an answer from the end leaves an unanswered disclosure, and a head that no longer matches an earlier copy", async () => {
    const full = await killedMidRequest(async (s) => followUp(s, "discarded", s.entries().at(-1) as Entry, "200 without a receipt"));
    const before = await verify(full);
    expect(before.exitCode).toBe(1);
    const file = join(full, "audit.jsonl");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    await writeFile(file, `${lines.slice(0, -1).join("\n")}\n`);
    const after = await verify(full);
    // ADR-0007: only the file is checked, so a cut tail verifies; the reported head is what tells it apart.
    expect(after.exitCode).toBe(0);
    expect(after.head.seq).toBe(before.head.seq - 1);
    expect(after.head.hash).not.toBe(before.head.hash);
  });
});

describe("runVerify: tampered chains exit non-zero with a named failure", () => {
  it("an edited disclosure body breaks the chain at its seq", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await receipt(s, await disclose(s, 1), response(sent(1)));
    });
    const file = join(dir, "audit.jsonl");
    await writeFile(file, (await readFile(file, "utf8")).replace('"fields":["query"]', '"fields":["zip"]'));
    const report = await verify(dir);
    expect(report).toMatchObject({ ok: false, exitCode: 1, head: { seq: 0 } });
    expect(check(report, "chain")?.details[0]).toBe("broken at seq 1: hash does not match the entry");
    expect(formatReport(report)).toContain("chain: FAILED\n  broken at seq 1:");
  });

  it("a rechained disclosure whose logged request was edited no longer matches its receipt", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await receipt(s, await disclose(s, 1, { path: "/v1/carts" }), response(sent(1)));
      await receipt(s, await disclose(s, 2, { body_b64: bodyOf(3).toString("base64"), content_digest: digestOf(bodyOf(3)) }), response(sent(2)));
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "disclosures")?.details).toContain("seq 2: the receipt for the disclosure at seq 1 does not verify (step 4: path_mismatch)");
    expect(check(report, "disclosures")?.details).toContain("seq 4: the receipt for the disclosure at seq 3 does not verify (step 4: digest_mismatch)");
  });

  it("a rechained disclosure whose logged body was edited no longer matches its content_digest", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await receipt(s, await disclose(s, 1, { body_b64: bodyOf(2).toString("base64") }), response(sent(1)));
      await receipt(s, await disclose(s, 2, { body_b64: "not base64!" }), response(sent(2)));
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain("seq 1: the disclosure body does not match its content_digest");
    expect(details).toContain("seq 3: the disclosure body_b64 is not base64");
  });

  it("a receipt cut from inside the chain breaks it at the gap", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await receipt(s, await disclose(s, 1), response(sent(1)));
      await receipt(s, await disclose(s, 2), response(sent(2)));
    });
    const file = join(dir, "audit.jsonl");
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.splice(2, 1);
    await writeFile(file, lines.join("\n"));
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "chain")?.details[0]).toBe("broken at seq 2: seq is 3, expected 2");
  });

  it("swapped receipts each fail against the other disclosure", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d1 = await disclose(s, 1);
      const d2 = await disclose(s, 2);
      await receipt(s, d1, response(sent(2)));
      await receipt(s, d2, response(sent(1)));
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain("seq 3: the receipt for the disclosure at seq 1 does not verify (step 4: digest_mismatch)");
    expect(details).toContain("seq 4: the receipt for the disclosure at seq 2 does not verify (step 4: digest_mismatch)");
  });

  it("a receipt signed under a key that is not in the recorded statement fails", async () => {
    const outsider = generateKeyPairSync("ed25519").privateKey;
    const dir = await chain(async (s) => {
      await keys(s);
      await receipt(s, await disclose(s, 1), response(sent(1), { kid: "cloud-receipt-202612", key: outsider }));
      await receipt(s, await disclose(s, 2), response(sent(2), { key: outsider }));
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain("seq 2: the receipt for the disclosure at seq 1 does not verify (step 3: unknown_kid)");
    expect(details).toContain("seq 4: the receipt for the disclosure at seq 3 does not verify (step 3: bad_signature)");
  });

  it("a receipt for another status, or one that names no earlier disclosure, fails", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await disclose(s, 1);
      await receipt(s, d, { ...response(sent(1), { status: 201 }), status: 200 });
      await s.append("receipt", { disclosure_seq: 0, reason: "received", response: response(sent(1)) });
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain("seq 2: the receipt for the disclosure at seq 1 does not verify (step 5: status_mismatch)");
    expect(details).toContain("seq 3: receipt names disclosure_seq 0, which is not an earlier disclosure");
  });

  it("a second follow-up for one disclosure fails", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const d = await disclose(s, 1);
      await receipt(s, d, response(sent(1)));
      await followUp(s, "unacknowledged", d, "no response");
    });
    expect(check(await verify(dir), "disclosures")?.details).toContain(
      "seq 1: the disclosure has 2 follow-up entries (seq 2, 3); expected one",
    );
  });

  it("a receipt without a logged request or without a response fails", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      const bare = await s.append("disclosure", { endpoint: "search", fields: ["query"] });
      await receipt(s, bare, response(sent(1)));
      await s.append("receipt", { disclosure_seq: (await disclose(s, 2)).seq });
      await receipt(s, await disclose(s, 3), { status: 200 });
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain("seq 1: the disclosure holds no body_b64 and content_digest");
    expect(details).toContain("seq 2: the receipt for the disclosure at seq 1 cannot be checked: the disclosure holds no logged request");
    expect(details).toContain("seq 4: the receipt for the disclosure at seq 3 holds no status");
    expect(details).toContain("seq 6: the receipt for the disclosure at seq 5 does not verify (step 1: missing)");
  });

  it("a changed recorded statement fails against the pinned root, and nothing verifies under it", async () => {
    const dir = await chain(async (s) => {
      await keys(s, { ...S1.expected.statement, confirm_origin: "https://attacker.example" });
      await receipt(s, await disclose(s, 1), response(sent(1)));
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "key statements")?.details).toContain(
      "seq 0: the recorded key statement does not verify against the pinned root (step 2: bad_signature)",
    );
    expect(check(report, "disclosures")?.details).toContain(
      "seq 2: the receipt for the disclosure at seq 1 cannot be checked: the key statement at seq 0 did not verify",
    );
  });

  it("a statement signed by another root fails", async () => {
    const dir = await chain(async (s) => {
      await keys(s, signStatement({}, generateKeyPairSync("ed25519").privateKey));
    });
    expect(check(await verify(dir), "key statements")?.details).toContain(
      "seq 0: the recorded key statement does not verify against the pinned root (step 2: bad_signature)",
    );
  });

  it("a receipt in a chain that records no statement fails", async () => {
    const dir = await chain(async (s) => {
      await receipt(s, await disclose(s, 1), response(sent(1)));
    });
    expect(check(await verify(dir), "disclosures")?.details).toContain(
      "seq 1: the receipt for the disclosure at seq 0 cannot be checked: the chain records no key statement",
    );
  });

  it("a bootstrap receipt logged before the first statement is checked against that statement", async () => {
    const outsider = generateKeyPairSync("ed25519").privateKey;
    const good = await chain(async (s) => {
      await receipt(s, await disclose(s, 1), { ...response(sent(1)), verified: false });
      await keys(s);
    });
    expect(await verify(good)).toMatchObject({ exitCode: 0, counts: { receipts: 1 } });
    const forged = await chain(async (s) => {
      await receipt(s, await disclose(s, 1), { ...response(sent(1), { key: outsider }), verified: false });
      await keys(s);
    });
    expect(check(await verify(forged), "disclosures")?.details).toContain(
      "seq 1: the receipt for the disclosure at seq 0 does not verify (step 3: bad_signature)",
    );
  });

  it("a discarded entry fails", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await followUp(s, "discarded", await disclose(s, 1), "2xx without a receipt");
    });
    const report = await verify(dir);
    expect(report).toMatchObject({ exitCode: 1, counts: { discarded: 1 } });
    expect(check(report, "disclosures")?.details).toContain(
      "seq 2: discarded: a response to the disclosure at seq 1 came without a valid receipt (2xx without a receipt)",
    );
  });

  it("a forged approval entry fails", async () => {
    const passkey = new TestPasskey("ES256");
    const dir = await chain(async (s) => {
      await keys(s);
      await approve(s, passkey, makeProof({ passkey, cloudKey: generateKeyPairSync("ed25519").privateKey }));
    });
    const report = await verify(dir);
    expect(report).toMatchObject({ exitCode: 1, counts: { approvals: 0 } });
    expect(check(report, "approvals")?.details).toContain("seq 3: the approval for ap_TEST0001 does not verify (step 2: bad_signature)");
  });

  it("an approval without a proof, a pending entry or a handle fails with a clear reason", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await s.append("approval", { handle: "ap_TEST0001" });
      await s.append("approval", { handle: "ap_TEST0001", proof: makeProof() });
      await s.append("approval", { proof: makeProof() });
    });
    const details = check(await verify(dir), "approvals")?.details ?? [];
    expect(details).toContain("seq 1: the approval for ap_TEST0001 holds no proof (expected body {handle, proof})");
    expect(details).toContain("seq 2: the approval for ap_TEST0001 has no approval_pending entry before it");
    expect(details).toContain("seq 3: the approval has no handle");
  });

  it("an approval with no statement recorded before it fails", async () => {
    const passkey = new TestPasskey("ES256");
    const dir = await chain((s) => approve(s, passkey));
    expect(check(await verify(dir), "approvals")?.details).toContain(
      "seq 2: the approval for ap_TEST0001 cannot be checked: no key statement was recorded before it",
    );
  });

  it("a replayed approval fails", async () => {
    const passkey = new TestPasskey("ES256");
    const proof = makeProof({ passkey });
    const dir = await chain(async (s) => {
      await keys(s);
      await approve(s, passkey, proof);
      await s.append("approval", { handle: "ap_TEST0001", proof });
    });
    expect(check(await verify(dir), "approvals")?.details).toContain("seq 4: the approval for ap_TEST0001 does not verify (step null: replay)");
  });

  it("a flagged approval counted as approved fails", async () => {
    const pinned = new TestPasskey("ES256");
    const other = new TestPasskey("ES256");
    const dir = await chain(async (s) => {
      await keys(s);
      await s.append("approver_pin", pinBody(pinned));
      await s.append("approver_flag", pinBody(other));
      await approve(s, other, makeProof({ passkey: other }), false);
    });
    const report = await verify(dir);
    expect(report).toMatchObject({ exitCode: 1, counts: { flags: 1, approvals: 0 } });
    expect(check(report, "approvals")?.details).toContain(
      `seq 4: the approval for ap_TEST0001 is counted as approved, but its passkey is not the pinned approver (fingerprint ${approverFingerprint(other.jwk as never)})`,
    );
  });

  it("an approval chained before any approver pin fails", async () => {
    const passkey = new TestPasskey("ES256");
    const dir = await chain(async (s) => {
      await keys(s);
      await approve(s, passkey, makeProof({ passkey }), false);
    });
    expect(check(await verify(dir), "approvals")?.details).toContain("seq 2: the approval for ap_TEST0001 was chained before any approver pin");
  });
});

describe("runVerify: the passkey signature counter", () => {
  /** The pending entry and proof for approval `handle` by `passkey` with counter `signCount`. */
  function counted(passkey: TestPasskey, handle: string, signCount: number) {
    const snapshot = { ...SNAPSHOT, approval: handle };
    const snapshotHash = sha256Hex(canonicalize(snapshot));
    return { pending: pendingEntry(handle, snapshotHash).body, proof: makeProof({ passkey, handle, snapshot, snapshotHash, signCount }) };
  }
  /** Two approvals as the gateway chains them now: the pin and each approval record the counter. */
  const twoApprovals = (second: number) => {
    const passkey = new TestPasskey("ES256");
    return chain(async (s) => {
      await keys(s);
      const a = counted(passkey, "ap_TEST0001", 5);
      await s.append("approval_pending", a.pending);
      await s.append("approver_pin", { ...pinBody(passkey), sign_count: 5, handle: "ap_TEST0001" });
      await s.append("approval", { handle: "ap_TEST0001", proof: a.proof, sign_count: 5 });
      const b = counted(passkey, "ap_TEST0002", second);
      await s.append("approval_pending", b.pending);
      await s.append("approval", { handle: "ap_TEST0002", proof: b.proof, sign_count: second });
    });
  };

  it("verifies a chain whose counter goes up, including the approval that wrote the pin", async () => {
    const report = await verify(await twoApprovals(6));
    expect(failed(report)).toEqual([]);
    expect(report.counts).toMatchObject({ approvals: 2, flags: 0 });
  });

  it("fails an approval chained with a counter that did not go up (attack: a cloned passkey's approval inserted)", async () => {
    const report = await verify(await twoApprovals(5));
    expect(failed(report)).toEqual(["approvals"]);
    expect(check(report, "approvals")?.details.join("\n")).toMatch(/the approval for ap_TEST0002 is counted as approved, but its passkey's signature counter did not go up/);
  });

  it("reports a counter flag as such", async () => {
    const passkey = new TestPasskey("ES256");
    const dir = await chain(async (s) => {
      await keys(s);
      await approve(s, passkey);
      await s.append("approver_flag", { ...pinBody(passkey), sign_count: 0, handle: "ap_TEST0002", reason: "sign_count" });
    });
    const report = await verify(dir);
    expect(report).toMatchObject({ exitCode: 0, counts: { approvals: 1, flags: 1 } });
    expect(formatReport(report)).toContain("the pinned approver's passkey signed an approval with a signature counter that did not go up");
  });
});

describe("runVerify: usage and configuration errors exit 2", () => {
  it("refuses to run with no pinned root key", async () => {
    const report = await verify(await chain(keys), { pinnedRootKeys: [] });
    expect(report).toMatchObject({ ok: false, exitCode: 2, checks: [{ name: "usage", ok: false }] });
    expect(formatReport(report)).toMatch(/usage: FAILED\n {2}no root key is pinned.*\n[\s\S]*verify: usage error\n$/);
  });

  it("still fails when the chain is there but cannot be read (a directory, no permission)", async () => {
    const dir = await tempDir("verify-");
    await mkdir(join(dir, "audit.jsonl"));
    const report = await verify(dir);
    expect(report.exitCode).toBe(2);
    expect(check(report, "usage")?.details[0]).toMatch(/^cannot read the chain in .*EISDIR/);
    if (process.getuid?.() !== 0 && process.platform !== "win32") {
      const locked = await tempDir("verify-");
      await writeFile(join(locked, "audit.jsonl"), "", { mode: 0o000 });
      const denied = await verify(locked);
      expect(denied.exitCode).toBe(2);
      expect(check(denied, "usage")?.details[0]).toMatch(/^cannot read the chain in .*EACCES/);
    }
  });
});

describe("runVerify: no chain yet", () => {
  it("passes the chain part for a data dir with no chain file: nothing has been sent", async () => {
    for (const dir of [join(await tempDir("verify-"), "missing"), await tempDir("verify-")]) {
      const report = await verify(dir);
      expect(report).toMatchObject({ ok: true, exitCode: 0, head: { seq: -1 } });
      expect(check(report, "usage")).toBeUndefined();
      expect(check(report, "chain")).toMatchObject({ ok: true });
      expect(check(report, "chain")?.details[0]).toMatch(/^No entries yet: the gateway has sent nothing\. Start it with .* serve, or try .* demo\.$/);
      expect(formatReport(report)).not.toMatch(/ENOENT|FAILED|usage/);
    }
  });

  it("an empty chain file reads the same as a missing one", async () => {
    const dir = await tempDir("verify-");
    await writeFile(join(dir, "audit.jsonl"), "");
    const report = await verify(dir);
    expect(report).toMatchObject({ ok: true, exitCode: 0 });
    expect(check(report, "chain")?.details[0]).toMatch(/^No entries yet/);
  });
});

describe("runVerify: the supply-chain self-check", () => {
  const VERSION = "1.2.3";
  const REGISTRY = "https://registry.npmjs.org";
  const sigstore = createTestSigstore();
  const PACKED = { "package.json": JSON.stringify({ name: "intent-gateway", version: VERSION }), "dist/main.js": "export {};\n" };

  /** An installed package and an offline registry serving its signed provenance. */
  async function release(installed: Record<string, string> = PACKED) {
    const tgz = makeTarGz(PACKED);
    const digest = sha512(tgz);
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: `pkg:npm/intent-gateway@${VERSION}`, digest: { sha512: digest.toString("hex") } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {},
    };
    const bundle = sigstore.attest(statement, {
      san: `https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v${VERSION}`,
      issuer: "https://token.actions.githubusercontent.com",
    });
    const tarball = `${REGISTRY}/intent-gateway/-/intent-gateway-${VERSION}.tgz`;
    const fetch = routedFetch(
      new Map<string, Route>([
        [`${REGISTRY}/intent-gateway`, { versions: { [VERSION]: { dist: { integrity: `sha512-${digest.toString("base64")}`, tarball } } } }],
        [`${REGISTRY}/-/npm/v1/attestations/intent-gateway@${VERSION}`, { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle }] }],
        [tarball, tgz],
      ]),
    );
    const pkgDir = await tempDir("verify-pkg-");
    for (const [path, content] of Object.entries(installed)) {
      await mkdir(dirname(join(pkgDir, path)), { recursive: true });
      await writeFile(join(pkgDir, path), content);
    }
    return { pkgDir, selfCheck: { fetch, trustedRoot: sigstore.trustedRoot } };
  }

  it("a valid npm install is labelled self-check, names the outside check, and exits 0", async () => {
    const { pkgDir, selfCheck } = await release();
    const report = await verify(await chain(keys), { skipSupplyChain: false, install: { kind: "npm", pkgDir }, selfCheck });
    expect(report.exitCode).toBe(0);
    const text = formatReport(report);
    expect(text).toContain(`self-check: npm provenance of intent-gateway@${VERSION}: ok\n`);
    expect(text).toContain("  This check runs inside the installed code. Confirm it from outside with:\n    npm audit signatures\n");
  });

  it("an altered install fails the self-check with its reason", async () => {
    const { pkgDir, selfCheck } = await release({ ...PACKED, "dist/main.js": "stealCards();\n" });
    const report = await verify(await chain(keys), { skipSupplyChain: false, install: { kind: "npm", pkgDir }, selfCheck });
    expect(report).toMatchObject({ exitCode: 1 });
    expect(check(report, "self-check")).toMatchObject({ ok: false, details: expect.arrayContaining(["  file-mismatch: dist/main.js"]) as unknown });
    expect(formatReport(report)).toContain(`self-check: npm provenance of intent-gateway@${VERSION}: FAILED\n`);
  });

  it("a wrong image reference is a usage error, still labelled self-check", async () => {
    const report = await verify(await chain(keys), {
      skipSupplyChain: false,
      install: { kind: "image", ref: "docker.io/someone/else:latest", version: VERSION },
      selfCheck: { fetch: routedFetch(new Map()) },
    });
    expect(report.exitCode).toBe(2);
    expect(check(report, "self-check")?.details[0]).toMatch(/^self-check: image signature and SBOM of .*: FAILED$/);
    expect(check(report, "self-check")?.details[1]).toMatch(/^ {2}ref-invalid: /);
  });

  it("says so when the self-check was skipped or there is no installed artifact", async () => {
    const dir = await chain(keys);
    expect(formatReport(await verify(dir))).toContain("self-check: skipped on request");
    expect(formatReport(await verify(dir, { skipSupplyChain: true, skipReason: "--skip-install-check" }))).toContain(
      "self-check: skipped on request (--skip-install-check); npm provenance and the image signature were not checked",
    );
    const source = await verify(dir, { skipSupplyChain: false });
    expect(source.exitCode).toBe(0);
    expect(formatReport(source)).toContain("self-check: not run: this install is not a published release (no build-info.json: running from source)");
  });

  it("a build the registry has never heard of (404) is not run, not failed: exit 0 when the chain checks pass", async () => {
    const { pkgDir } = await release();
    const report = await verify(await chain(keys), {
      skipSupplyChain: false,
      install: { kind: "npm", pkgDir },
      selfCheck: { fetch: routedFetch(new Map()), trustedRoot: sigstore.trustedRoot },
    });
    expect(report.exitCode).toBe(0);
    expect(check(report, "self-check")).toEqual({
      name: "self-check",
      ok: true,
      details: [`self-check: not run: this install is not a published release (intent-gateway@${VERSION}: the registry has no package intent-gateway (HTTP 404))`],
    });
  });

  it("a version the registry does not list is not run either; a broken chain still fails", async () => {
    const { pkgDir } = await release();
    const fetch = routedFetch(new Map<string, Route>([[`${REGISTRY}/intent-gateway`, { versions: { "9.9.9": {} } }]]));
    const opts = { skipSupplyChain: false, install: { kind: "npm" as const, pkgDir }, selfCheck: { fetch, trustedRoot: sigstore.trustedRoot } };
    const dir = await chain(keys);
    const report = await verify(dir, opts);
    expect(report.exitCode).toBe(0);
    expect(formatReport(report)).toContain(`not a published release (intent-gateway@${VERSION}: the registry lists no intent-gateway@${VERSION})`);
    // Not-run never masks the chain checks.
    const file = join(dir, "audit.jsonl");
    await writeFile(file, (await readFile(file, "utf8")).replace('"kind":"keys"', '"kind":"keyz"'));
    const broken = await verify(dir, opts);
    expect(broken.exitCode).toBe(1);
    expect(check(broken, "chain")?.ok).toBe(false);
  });

  it("attack: a tampered published install still fails, and so does a registry that is reachable but broken", async () => {
    const tampered = await release({ ...PACKED, "dist/main.js": "stealCards();\n" });
    expect((await verify(await chain(keys), { skipSupplyChain: false, install: { kind: "npm", pkgDir: tampered.pkgDir }, selfCheck: tampered.selfCheck })).exitCode).toBe(1);
    const { pkgDir } = await release();
    for (const route of [500, "<html>", { versions: { [VERSION]: { dist: {} } } }] as Route[]) {
      const fetch = routedFetch(new Map<string, Route>([[`${REGISTRY}/intent-gateway`, route]]));
      const report = await verify(await chain(keys), { skipSupplyChain: false, install: { kind: "npm", pkgDir }, selfCheck: { fetch, trustedRoot: sigstore.trustedRoot } });
      expect(report.exitCode).toBe(1);
      expect(check(report, "self-check")?.details[1]).toMatch(/^ {2}registry-error: /);
    }
    // A published version whose attestation listing 404s is missing its provenance, not unpublished.
    const full = await release();
    const listing = `${REGISTRY}/-/npm/v1/attestations/intent-gateway@${VERSION}`;
    const real = full.selfCheck.fetch;
    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      (typeof input === "string" ? input : input instanceof URL ? input.href : input.url) === listing
        ? Promise.resolve(new Response("not found", { status: 404 }))
        : real(input, init)) as typeof real;
    const missing = await verify(await chain(keys), { skipSupplyChain: false, install: { kind: "npm", pkgDir: full.pkgDir }, selfCheck: { fetch, trustedRoot: sigstore.trustedRoot } });
    expect(missing.exitCode).toBe(1);
    expect(check(missing, "self-check")?.details[1]).toMatch(/^ {2}registry-error: .*HTTP 404/);
  });

  it("reaches the network only through the injected self-check transport", async () => {
    const { pkgDir, selfCheck } = await release();
    await verify(await chain(keys), { skipSupplyChain: false, install: { kind: "npm", pkgDir }, selfCheck });
    expect(selfCheck.fetch.calls.map((c) => new URL(c.url).host)).toEqual(["registry.npmjs.org", "registry.npmjs.org", "registry.npmjs.org"]);
  });
});

describe("runVerify: a disclosure with no follow-up inside its gateway session (F-m)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const start = (s: Store, id: string) => s.append("session", { id });
  /** A disclosure as the disclosure module logs it: number `n` of session `id`, with the session's open n's. */
  const discloseIn = (s: Store, body: number, id: string, n: number, open: number[] = []) => disclose(s, body, { session: { id, n, open } });
  const answered = async (s: Store, body: number, id: string, n: number, open: number[] = []) =>
    receipt(s, await discloseIn(s, body, id, n, open), response(sent(body)));
  const unansweredLine = (seqs: string) =>
    `logged, maybe sent, no answer recorded (the gateway stopped before it finished, or is still waiting): ${seqs}`;

  /** The chain's lines as entries. */
  async function lines(dir: string): Promise<Entry[]> {
    return (await readFile(join(dir, "audit.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Entry);
  }
  /** Rewrites the chain from `entries`, re-numbering and re-hashing every entry: what an attacker with the file can do. */
  async function rehash(dir: string, entries: readonly Entry[]): Promise<void> {
    let prev = "0".repeat(64);
    const out: string[] = [];
    for (const [seq, { ts, kind, body }] of entries.entries()) {
      const fields = { seq, prev, ts, kind, body };
      prev = sha256Hex(canonicalize(fields));
      out.push(canonicalize({ ...fields, hash: prev }));
    }
    await writeFile(join(dir, "audit.jsonl"), `${out.join("\n")}\n`);
  }

  it("attack: fails when a later disclosure of the same session counts the unanswered one as answered", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await start(s, A);
      await answered(s, 1, A, 0);
      await discloseIn(s, 2, A, 1);
      await answered(s, 3, A, 2);
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(failed(report)).toEqual(["disclosures"]);
    expect(check(report, "disclosures")?.details).toContain(
      "seq 4: the disclosure has no follow-up entry, but the disclosure at seq 5 of the same gateway session counts it as answered: its answer is missing from the chain",
    );
  });

  it("passes when the unanswered disclosure is the last of its session, with a later session after it", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await start(s, A);
      await answered(s, 1, A, 0);
      await discloseIn(s, 2, A, 1);
      await start(s, B);
      await answered(s, 3, B, 0);
    });
    const report = await verify(dir);
    expect(failed(report)).toEqual([]);
    expect(report.counts).toMatchObject({ disclosures: 3, unanswered: 1 });
    expect(check(report, "disclosures")?.details).toContain(unansweredLine("1 (seq 4)"));
  });

  it("passes when a later disclosure of the session was sent while the unanswered one was still open (stopped with two in flight)", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await start(s, A);
      await discloseIn(s, 1, A, 0);
      await answered(s, 2, A, 1, [0]);
    });
    const report = await verify(dir);
    expect(failed(report)).toEqual([]);
    expect(check(report, "disclosures")?.details).toContain(unansweredLine("1 (seq 2)"));
  });

  it("passes when two sessions on one data dir interleave and one is still waiting", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await start(s, A);
      await start(s, B);
      const waiting = await discloseIn(s, 1, A, 0);
      await answered(s, 2, B, 0);
      await answered(s, 3, A, 1, [0]);
      await answered(s, 4, B, 1);
      await discloseIn(s, 5, B, 2);
      await receipt(s, waiting, response(sent(1)));
    });
    const report = await verify(dir);
    expect(failed(report)).toEqual([]);
    expect(report.counts).toMatchObject({ disclosures: 5, receipts: 4, unanswered: 1 });
  });

  it("attack: a disclosure missing from the middle of a session fails, by its number", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await start(s, A);
      await answered(s, 1, A, 0);
      await answered(s, 3, A, 2);
    });
    expect(check(await verify(dir), "disclosures")?.details).toContain(
      "seq 4: the disclosure is number 2 of its gateway session, expected 1: a disclosure of that session is missing from the chain",
    );
  });

  it("attack: a session no session entry starts, a malformed session and a repeated session id all fail", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await answered(s, 1, A, 0);
      await disclose(s, 2, { session: { id: B, n: "0", open: [] } });
      await start(s, B);
      await start(s, B);
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain(`seq 1: the disclosure names gateway session ${A}, which no earlier session entry starts`);
    expect(details).toContain("seq 3: the disclosure's session is not {id, n, open}");
    expect(details).toContain(`seq 5: the session entry repeats the id of an earlier gateway session (${B})`);
  });

  it("attack: forging a session id or an open list without re-hashing breaks the chain", async () => {
    const write = async (s: Store) => {
      await keys(s);
      await start(s, A);
      await answered(s, 1, A, 0);
      await discloseIn(s, 2, A, 1);
      await answered(s, 3, A, 2);
    };
    for (const forge of [
      (text: string) => text.replace('"open":[]', '"open":[0]'),
      (text: string) => text.replaceAll(A, B),
    ]) {
      const dir = await chain(write);
      const file = join(dir, "audit.jsonl");
      const text = await readFile(file, "utf8");
      const forged = forge(text);
      expect(forged).not.toBe(text);
      await writeFile(file, forged);
      const report = await verify(dir);
      expect(report.exitCode).toBe(1);
      expect(check(report, "chain")?.ok).toBe(false);
    }
  });

  it("attack (F2): a receipt spliced out and the rest re-hashed fails mid-session; at the session's end only the saved head shows it", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await start(s, A);
      await answered(s, 1, A, 0);
      await answered(s, 2, A, 1);
      await start(s, B);
      await answered(s, 3, B, 0);
    });
    const saved = (await verify(dir)).head;
    const entries = await lines(dir);
    const receiptOf = (seq: number) => entries.findIndex((e) => e.kind === "receipt" && (e.body as { disclosure_seq?: unknown }).disclosure_seq === seq);

    // Mid-session: the receipt for A's first disclosure (seq 2), with A's next disclosure after it.
    await rehash(dir, entries.filter((_, i) => i !== receiptOf(2)).map((e) => fixRef(e, 3)));
    const mid = await verify(dir);
    expect(mid.exitCode).toBe(1);
    expect(check(mid, "disclosures")?.details).toContain(
      "seq 2: the disclosure has no follow-up entry, but the disclosure at seq 3 of the same gateway session counts it as answered: its answer is missing from the chain",
    );
    expect(mid.head.hash).not.toBe(saved.hash);

    // Last of its session: the receipt for A's last disclosure (seq 4). The file verifies; the head does not match.
    await rehash(dir, entries.filter((_, i) => i !== receiptOf(4)).map((e) => fixRef(e, 5)));
    const last = await verify(dir);
    expect(last.exitCode).toBe(0);
    expect(check(last, "disclosures")?.details).toContain(unansweredLine("1 (seq 4)"));
    expect(last.head.seq).toBe(saved.seq - 1);
    expect(last.head.hash).not.toBe(saved.hash);
  });
});

/** After an entry at `removedAt` was spliced out, a follow-up's disclosure_seq past it moves down by one. */
function fixRef(entry: Entry, removedAt: number): Entry {
  const body = entry.body as { disclosure_seq?: unknown };
  if (typeof body.disclosure_seq !== "number" || body.disclosure_seq < removedAt) return entry;
  return { ...entry, body: { ...body, disclosure_seq: body.disclosure_seq - 1 } };
}
