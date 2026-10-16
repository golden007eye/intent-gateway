// `intent verify` over fixture chains written by the real store and signed with the trust-kit test keys. Each tamper
// case must exit non-zero and name its failure; honest network failures (unacknowledged) must not.
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTarGz, routedFetch, sha512, type Route } from "../../test/support/fake-registry.ts";
import { createTestSigstore } from "../../test/support/sigstore-ca.ts";
import { makeProof, pendingEntry, PINNED, S1, signReceipt, signStatement, STATEMENT_VALID_AT, TestPasskey } from "../../test/support/trust-kit.ts";
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

/** The request the gateway signed and sent for body `n`; the digest is computed here, not by the code under test. */
function sent(n: number) {
  const content_digest = `sha-256=:${createHash("sha256").update(`{"query":"lamp ${String(n)}"}`, "utf8").digest("base64")}:`;
  return { method: "POST", path: "/v1/search", content_digest, keyid: KEYID, nonce: `nonce-${String(n)}`.padEnd(22, "A"), created: 1790251200 + n };
}

function response(request: object, opts: { status?: number; kid?: string; key?: Parameters<typeof signReceipt>[1] } = {}) {
  const status = opts.status ?? 200;
  const receipt = { v: 1, kid: opts.kid ?? "cloud-receipt-202610", request, status, received_at: "2026-09-24T12:00:01Z" };
  return { status, ...signReceipt(receipt, opts.key) };
}

const keys = (s: Store, statement: unknown = S1.expected.statement) => s.append("keys", { statement });
const disclose = (s: Store, n: number, request: object = sent(n)) =>
  s.append("disclosure", { endpoint: "search", fields: ["query"], blocked: [], request });
const receipt = (s: Store, d: Entry, res: object) => s.append("receipt", { disclosure_seq: d.seq, reason: "received", response: res });
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
    expect(report.counts).toEqual({ disclosures: 1, receipts: 1, unacknowledged: 0, discarded: 0, approvals: 1, flags: 0 });
    const text = formatReport(report);
    expect(text).toContain(`head: seq 5 hash ${head.hash}\n`);
    expect(text).toContain("sent, not acknowledged: 0\n");
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
      await receipt(s, await disclose(s, 1, { ...sent(1), content_digest: sent(2).content_digest }), response(sent(1)));
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "disclosures")?.details).toContain("seq 2: the receipt for the disclosure at seq 1 does not verify (step 4: digest_mismatch)");
  });

  it("a dropped receipt leaves its disclosure without a follow-up", async () => {
    const dir = await chain(async (s) => {
      await keys(s);
      await disclose(s, 1);
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(check(report, "disclosures")?.details).toContain("seq 1: the disclosure has no receipt, unacknowledged or discarded entry");
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
      const bare = await s.append("disclosure", { endpoint: "search", fields: ["query"], blocked: [] });
      await receipt(s, bare, response(sent(1)));
      await s.append("receipt", { disclosure_seq: (await disclose(s, 2)).seq, reason: "received" });
    });
    const details = check(await verify(dir), "disclosures")?.details ?? [];
    expect(details).toContain("seq 2: the receipt for the disclosure at seq 1 cannot be checked: the disclosure holds no logged request");
    expect(details).toContain("seq 4: the receipt for the disclosure at seq 3 holds no response {status, receipt, signature}");
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

  it("a receipt with no statement recorded before it fails", async () => {
    const dir = await chain(async (s) => {
      await receipt(s, await disclose(s, 1), response(sent(1)));
    });
    expect(check(await verify(dir), "disclosures")?.details).toContain(
      "seq 1: the receipt for the disclosure at seq 0 cannot be checked: no key statement was recorded before it",
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

describe("runVerify: usage and configuration errors exit 2", () => {
  it("refuses to run with no pinned root key", async () => {
    const report = await verify(await chain(keys), { pinnedRootKeys: [] });
    expect(report).toMatchObject({ ok: false, exitCode: 2, checks: [{ name: "usage", ok: false }] });
    expect(formatReport(report)).toMatch(/usage: FAILED\n {2}no root key is pinned.*\n[\s\S]*verify: usage error\n$/);
  });

  it("reports a data dir without a chain", async () => {
    const report = await verify(join(await tempDir("verify-"), "missing"));
    expect(report.exitCode).toBe(2);
    expect(check(report, "usage")?.details[0]).toMatch(/^cannot read the chain in /);
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
    expect(formatReport(await verify(dir, { skipSupplyChain: false }))).toContain("self-check: not run: running from source");
  });

  it("reaches the network only through the injected self-check transport", async () => {
    const { pkgDir, selfCheck } = await release();
    await verify(await chain(keys), { skipSupplyChain: false, install: { kind: "npm", pkgDir }, selfCheck });
    expect(selfCheck.fetch.calls.map((c) => new URL(c.url).host)).toEqual(["registry.npmjs.org", "registry.npmjs.org", "registry.npmjs.org"]);
  });
});
