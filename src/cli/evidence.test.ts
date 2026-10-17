// `intent evidence` and `intent verify --evidence` through the CLI (plan G9 acceptance 1): the pack is written from
// the chain, and checked with no data dir and no network, against an Intent Cloud host that cannot be reached.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purchaseChain } from "../../test/support/purchase-chain.ts";
import { type Io, main } from "./index.ts";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(argv: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env,
    stdin: new PassThrough(),
    stdout: { write: (t: string) => out.push(t) },
    stderr: { write: (t: string) => err.push(t) },
    isTTY: { stdin: false, stdout: false },
    cwd,
  };
  const outcome = await main(argv, io);
  return { code: outcome.code, out: out.join(""), err: err.join("") };
}

describe("intent evidence, then intent verify --evidence, offline", () => {
  it("writes a pack that verifies with no network and no data dir; a changed byte fails; nothing is overwritten", async () => {
    const chain = await purchaseChain();
    const handle = await chain.buy(0, { ordered: true });
    await chain.close();
    const work = mkdtempSync(join(tmpdir(), "evidence-cli-"));
    const keys = join(work, "keys.json");
    writeFileSync(keys, JSON.stringify({ rootKeys: [chain.rootPin] }));
    // Any attempt to reach the network fails the test run.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network used")));
    const env = { INTENT_DATA_DIR: chain.dir, INTENT_CLOUD_URL: "https://127.0.0.1:9" };

    const exported = await run(["evidence", handle, "--trust-keys", keys], env, work);
    expect(exported.err).toBe("");
    expect(exported.code).toBe(0);
    const file = join(work, `evidence-${handle}.json`);
    expect(exported.out).toContain(`evidence: wrote ${file}\n`);
    expect(exported.out).toMatch(new RegExp(`purchase ${handle}: \\d+ of the \\d+ entries of the chain; head seq \\d+ hash [0-9a-f]{64}\\n`));
    expect(exported.out).toContain(`Anyone can check it offline: intent verify --evidence ${file}`);

    // The verifier has no chain at all: a data dir that does not exist.
    const elsewhere = { INTENT_DATA_DIR: join(work, "none"), INTENT_CLOUD_URL: "https://127.0.0.1:9" };
    const verified = await run(["verify", "--evidence", file, "--trust-keys", keys], elsewhere, work);
    expect(verified.code).toBe(0);
    expect(verified.out).toMatch(/^evidence pack: ok\n/);
    expect(verified.out).toContain("approvals: ok\n  verified: 1\n");
    expect(verified.out).toContain("re-checked: 2 (handed_off: 1, ordered: 1)");
    expect(verified.out).not.toContain("self-check");
    expect(verified.out).toMatch(/verify: ok\n$/);

    const text = readFileSync(file, "utf8");
    const at = text.indexOf('"title":"') + 9;
    writeFileSync(file, text.slice(0, at) + (text[at] === "X" ? "Y" : "X") + text.slice(at + 1));
    const tampered = await run(["verify", "--evidence", file, "--trust-keys", keys], elsewhere, work);
    expect(tampered.code).toBe(1);
    expect(tampered.out).toMatch(/entries\[\d+\]: hash does not match the entry/);
    expect(tampered.out).toMatch(/verify: FAILED\n$/);

    const again = await run(["evidence", handle, "--trust-keys", keys], env, work);
    expect(again.code).toBe(1);
    expect(again.err).toContain(`${file} exists; remove it or pass --out <file>`);
    const named = await run(["evidence", handle, "--trust-keys", keys, "--out", "second.json"], env, work);
    expect(named.code).toBe(0);
    expect(readFileSync(join(work, "second.json"), "utf8")).toBe(text);
  });

  it("refuses what it cannot export, with the fix", async () => {
    const chain = await purchaseChain();
    await chain.buy(0);
    await chain.close();
    const work = mkdtempSync(join(tmpdir(), "evidence-cli-"));
    const keys = join(work, "keys.json");
    writeFileSync(keys, JSON.stringify({ rootKeys: [chain.rootPin] }));
    const env = { INTENT_DATA_DIR: chain.dir, INTENT_CLOUD_URL: "https://127.0.0.1:9" };
    const unknown = await run(["evidence", "ap_NOTINTHISCHAIN0000", "--trust-keys", keys], env, work);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/^intent: no purchase ap_NOTINTHISCHAIN0000 to export: no approval_pending entry names it; .*; run intent verify\n$/);
    const bad = await run(["evidence", "../etc/passwd", "--trust-keys", keys], env, work);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("is not an approval handle");
    const mixed = await run(["verify", "--evidence", "x.json", "--skip-install-check", "--trust-keys", keys], env, work);
    expect(mixed.code).toBe(2);
    expect(mixed.err).toContain("--evidence checks a pack file only; it takes no --skip-install-check");
    const missing = await run(["verify", "--evidence", "x.json", "--trust-keys", keys], env, work);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--evidence x.json: no such file");
  });
});
