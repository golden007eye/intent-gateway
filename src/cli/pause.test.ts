// `intent pause`, `intent status`, `intent resume` and what `intent log` shows for a pause (ADR-0023), offline: with no
// account key the pause holds here only and nothing is sent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { openStore, readChain, type Entry } from "../store/index.ts";
import { type Io, main } from "./index.ts";

vi.setConfig({ testTimeout: 30_000 });

const TS = Date.parse("2026-10-18T12:00:00.000Z");

function setup() {
  const dir = join(mkdtempSync(join(tmpdir(), "cli-pause-")), "data");
  const env = { INTENT_DATA_DIR: dir };
  return {
    dir,
    async run(argv: string[], options: { input?: string; tty?: boolean } = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const stdin = new PassThrough();
      if (options.input !== undefined) stdin.end(options.input);
      const tty = options.tty ?? false;
      const io: Io = {
        env,
        stdin,
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        isTTY: { stdin: tty, stdout: tty },
        now: () => TS,
        accountKey: () => Promise.resolve(null),
      };
      const outcome = await main(argv, io);
      return { code: outcome.code, out: out.join(""), err: err.join("") };
    },
  };
}

const kinds = (dir: string): string[] => (readChain(dir) as Entry[]).map((e) => e.kind);

describe("intent pause", () => {
  it("pauses at once, says the honest line, and says the pause holds here only without an account key", async () => {
    const s = setup();
    const result = await s.run(["pause"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Paused: from now on the gateway refuses create_cart and complete_checkout.");
    expect(result.out).toContain("`intent pause` stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off agent payments in the Shop app.");
    expect(result.out).toContain("Not sent to Intent Cloud: no account key on this machine, so the pause holds here only.");
    expect(kinds(s.dir)).toEqual(["pause", "pause_sent"]);
    const status = await s.run(["status"]);
    expect(status.out).toMatch(/Paused since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\. Resume needs your passkey\./);
    expect(status.out).toContain("Resume needs your passkey.");
    expect(status.out).toContain("Purchases stopped: none was open.");
  });

  it("intent log shows the pause and every refusal as `refused: paused`", async () => {
    const s = setup();
    await s.run(["pause"]);
    const store = await openStore(s.dir, { clock: () => TS });
    await store.append("refused", { step: "create_cart", reason: "paused", source: "gateway" });
    await store.append("refused", { step: "create_cart", reason: "paused", source: "intent_cloud", disclosure_seq: 0 });
    await store.close();
    const log = await s.run(["log", "--utc", "--no-color"]);
    expect(log.out).toContain("paused    purchases paused · from the CLI");
    expect(log.out).toContain("12:00:00  refused   create_cart");
    expect(log.out).toContain("✗ refused: paused (by the gateway, nothing sent)");
    expect(log.out).toContain("✗ refused: paused (by Intent Cloud)");
    const verbose = await s.run(["log", "-v", "--utc", "--no-color"]);
    expect(verbose.out).toContain("create_cart: refused: paused (by the gateway; nothing sent)");
  });
});

describe("intent resume", () => {
  async function paused(s: ReturnType<typeof setup>): Promise<void> {
    const store = await openStore(s.dir, { clock: () => TS });
    await store.append("keys", { statement: { kid: "k", confirm_origin: "https://confirm.example" } });
    await store.close();
    await s.run(["pause"]);
  }

  it("without a terminal it names the passkey page and clears nothing", async () => {
    const s = setup();
    await paused(s);
    const result = await s.run(["resume"], { input: "resumed\n" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("Open https://confirm.example/account and resume there with your passkey.");
    expect(result.err).toContain("resume needs a terminal");
    expect(kinds(s.dir)).not.toContain("resume");
  });

  it("at a terminal it clears the local pause only after the developer confirms, and only as unconfirmed", async () => {
    const s = setup();
    await paused(s);
    const no = await s.run(["resume"], { tty: true, input: "not yet\n" });
    expect(no.code).toBe(1);
    expect(no.out).toContain("Not resumed: the pause holds.");
    expect(kinds(s.dir)).not.toContain("resume");
    const yes = await s.run(["resume"], { tty: true, input: "resumed\n" });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain("Local pause cleared, unconfirmed");
    expect((readChain(s.dir) as Entry[]).at(-1)).toMatchObject({ kind: "resume", body: { from: "cli", confirmed: false, pending: "next submit" } });
    expect((await s.run(["status"])).out).toContain("Not paused: resumed, unconfirmed until the next submit.");
  });
});
