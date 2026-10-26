// `intent verify` over disclosures to destinations other than Intent Cloud (ADR-0014). Hand-made chains, written by
// the real store, for each attack: an unredacted credential in any disclosure ("holds a credential"), a `redacted`
// item naming a path that holds no marker, a response answering an Intent Cloud disclosure, a receipt answering a
// wallet one. A chain from before destinations existed (the preview.3 demo fixture) still verifies.
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED } from "../../test/support/trust-kit.ts";
import { openStore, type Store, type StoreFs } from "../store/index.ts";
import { type PinnedRootKey, TEST_ROOT_KEY } from "../trust/index.ts";
import { formatReport, type Report, runVerify } from "./index.ts";

const fast: StoreFs = {
  ...fsp,
  open: (async (...args: Parameters<typeof fsp.open>) => Object.assign(await fsp.open(...args), { datasync: () => Promise.resolve() })),
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const marker = (text: string) => `[redacted sha256:${sha(text)}]`;
const digest = (bytes: Buffer) => `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`;

async function chain(write: (s: Store) => Promise<unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "verify-dest-"));
  dirs.push(dir);
  const store = await openStore(join(dir, "data"), { fs: fast });
  await write(store);
  await store.close();
  return join(dir, "data");
}
const verify = (dataDir: string, pinnedRootKeys: readonly PinnedRootKey[] = PINNED): Promise<Report> =>
  runVerify({ dataDir, pinnedRootKeys, now: new Date(), skipSupplyChain: true });
const failures = (report: Report) => report.checks.filter((c) => !c.ok).flatMap((c) => c.details);

/** A wallet disclosure in the disclosure module's shape, with `changes` applied. */
function walletDisclosure(payload: unknown, changes: Record<string, unknown> = {}) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    endpoint: "refresh",
    method: "POST",
    path: "/api/mcp",
    fields: [],
    body_b64: bytes.toString("base64"),
    headers: [["authorization", marker("Bearer t")]],
    content_digest: digest(bytes),
    destination: "shop_accounts",
    redacted: [{ at: "headers.authorization", sha256: sha("Bearer t") }],
    ...changes,
  };
}
const answer = (s: Store, seq: number) => s.append("response", { disclosure_seq: seq, status: 200, body_sha256: sha("{}"), bytes: 2 });

describe("verify: disclosures to wallet destinations", () => {
  it("passes a redacted wallet disclosure answered by a response, and counts both", async () => {
    const dir = await chain(async (s) => {
      const d = await s.append("disclosure", walletDisclosure({ refresh_token: marker("r") }, {
        redacted: [{ at: "headers.authorization", sha256: sha("Bearer t") }, { at: "body.refresh_token", sha256: sha("r") }],
      }));
      await answer(s, d.seq);
    });
    const report = await verify(dir);
    expect(failures(report)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.counts).toMatchObject({ disclosures: 1, responses: 1, redactions: 2, unanswered: 0 });
    const text = formatReport(report);
    expect(text).toContain("answered, no signed receipt (that destination signs none; its answer is logged): 1");
    expect(text).toContain("credential values sent, repeats counted (the log keeps only their sha256): 2");
  });

  it("attack: an unredacted authorization header in any disclosure exits 1, holds a credential", async () => {
    const dir = await chain(async (s) => {
      const d = await s.append("disclosure", walletDisclosure({}, { headers: [["Authorization", "Bearer live-token"]], redacted: [] }));
      await answer(s, d.seq);
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(failures(report)).toContainEqual(expect.stringMatching(/seq 0: the disclosure holds a credential: the Authorization header is not redacted/));
  });

  it("attack: an unredacted refresh_token in a shop_accounts body exits 1, holds a credential", async () => {
    const dir = await chain(async (s) => {
      const d = await s.append("disclosure", walletDisclosure({ params: { arguments: { refresh_token: "live-refresh" } } }));
      await answer(s, d.seq);
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    expect(failures(report)).toContainEqual(expect.stringMatching(/holds a credential: body\.params\.arguments\.refresh_token is not redacted/));
  });

  it("attack: a secret key in an Intent Cloud disclosure fails too (any destination)", async () => {
    const dir = await chain(async (s) => {
      const bytes = Buffer.from('{"items":[{"apiKey":"k-123456"}]}', "utf8");
      await s.append("disclosure", { endpoint: "search", fields: [], body_b64: bytes.toString("base64"), headers: [], content_digest: digest(bytes) });
    });
    expect(failures(await verify(dir))).toContainEqual(expect.stringMatching(/holds a credential: body\.items\[0\]\.apiKey is not redacted/));
  });

  it("attack: verify shares the core's wider rules: credential headers, secret key spellings, an OAuth code, a query secret", async () => {
    const dir = await chain(async (s) => {
      const d = await s.append(
        "disclosure",
        walletDisclosure(
          { accessToken: "a", Refresh_Token: "r", password: "p", oauth: { grant_type: "authorization_code", code: "c" }, promo: { code: "SPRING10" } },
          {
            path: "/api/mcp?access_token=q",
            headers: [["Cookie", "s=1"], ["proxy-authorization", "Basic x"], ["X-Api-Key", "k"]],
            redacted: [],
          },
        ),
      );
      await answer(s, d.seq);
    });
    const found = failures(await verify(dir)).filter((f) => f.includes("holds a credential"));
    expect(found.map((f) => f.replace(/^seq 0: the disclosure holds a credential: /, ""))).toEqual([
      "the Cookie header is not redacted",
      "the proxy-authorization header is not redacted",
      "the X-Api-Key header is not redacted",
      "the query parameter access_token is not redacted",
      "body.accessToken is not redacted",
      "body.Refresh_Token is not redacted",
      "body.password is not redacted",
      "body.oauth.code is not redacted",
    ]);
  });

  it("attack: a redacted item naming a path with no marker, or with another digest, exits 1", async () => {
    const dir = await chain(async (s) => {
      const a = await s.append("disclosure", walletDisclosure({ code: marker("c") }, { redacted: [{ at: "body.missing", sha256: sha("c") }] }));
      await answer(s, a.seq);
      const b = await s.append("disclosure", walletDisclosure({ code: marker("c") }, { redacted: [{ at: "body.code", sha256: sha("other") }] }));
      await answer(s, b.seq);
      const c = await s.append("disclosure", walletDisclosure({}, { redacted: [{ at: "headers.cookie", sha256: sha("Bearer t") }, { at: "nowhere", sha256: sha("x") }, { at: "body", sha256: sha("x") }, { at: "body..x", sha256: sha("x") }] }));
      await answer(s, c.seq);
      const d = await s.append("disclosure", walletDisclosure({}, { redacted: "headers.authorization" }));
      await answer(s, d.seq);
    });
    const report = await verify(dir);
    expect(report.exitCode).toBe(1);
    const found = failures(report);
    expect(found).toContainEqual('seq 0: the disclosure\'s redacted names "body.missing", which holds no redacted value with that sha256 in the logged request');
    expect(found).toContainEqual('seq 2: the disclosure\'s redacted names "body.code", which holds no redacted value with that sha256 in the logged request');
    for (const at of ["headers.cookie", "nowhere", "body", "body..x"]) {
      expect(found).toContainEqual(`seq 4: the disclosure's redacted names ${JSON.stringify(at)}, which holds no redacted value with that sha256 in the logged request`);
    }
    expect(found).toContainEqual("seq 6: the disclosure's redacted is not a list of {at, sha256}");
  });

  it("attack: a response answering an Intent Cloud disclosure, or a receipt answering a wallet one, exits 1", async () => {
    const dir = await chain(async (s) => {
      const bytes = Buffer.from("{}", "utf8");
      const cloud = await s.append("disclosure", { endpoint: "search", fields: [], body_b64: bytes.toString("base64"), headers: [], content_digest: digest(bytes) });
      await answer(s, cloud.seq);
      const wallet = await s.append("disclosure", walletDisclosure({}));
      await s.append("receipt", { disclosure_seq: wallet.seq, status: 200, receipt_header: "x", receipt_signature: "y", contract_version: "1.5.0", verified: true });
      await answer(s, 99);
    });
    const found = failures(await verify(dir));
    expect(found).toContainEqual("seq 1: a response entry answers the disclosure at seq 0, which went to Intent Cloud: its answers are acknowledged by receipts");
    expect(found).toContainEqual("seq 3: a receipt entry answers the disclosure at seq 2, which went to shop_accounts: only Intent Cloud signs receipts");
    expect(found).toContainEqual("seq 4: response names disclosure_seq 99, which is not an earlier disclosure");
  });

  it("a preview.3 demo chain (written before destinations existed) verifies unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-preview3-"));
    dirs.push(dir);
    await fsp.copyFile(join(import.meta.dirname, "..", "..", "test", "fixtures", "preview3-demo-chain.jsonl"), join(dir, "audit.jsonl"));
    const report = await verify(dir, [TEST_ROOT_KEY]);
    expect(failures(report)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.counts).toMatchObject({ disclosures: 7, receipts: 7, responses: 0, redactions: 0, approvals: 1, unanswered: 0 });
    expect(formatReport(report)).not.toMatch(/no signed receipt|credential values sent/);
  });
});
