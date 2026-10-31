// `intent pause`, `intent status`, `intent resume` and what `intent log` shows for a pause (ADR-0023), offline: with no
// account key the pause holds here only and nothing is sent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { openStore, readChain, type Entry } from "../store/index.ts";
import { checkChain, type Level } from "./doctor.ts";
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

const NO_KEY_LIFT =
  "The pause holds on this machine; Intent Cloud has not acknowledged it yet (it needs an account key on this machine: run `intent init`). Until it does, the pause can be lifted from this machine; after that, resuming needs your passkey.";

/** Records a send of the pause in effect with this result, as the pause sender does after Intent Cloud's answer. */
async function sendResult(dir: string, result: string, reason: string): Promise<void> {
  const pause = (readChain(dir) as Entry[]).filter((e) => e.kind === "pause").at(-1);
  const store = await openStore(dir, { clock: () => TS });
  await store.append("pause_sent", { pause_seq: pause?.seq, counter: 1, disclosure_seq: 0, result, reason });
  await store.close();
}

const acknowledge = (dir: string): Promise<void> => sendResult(dir, "acknowledged", "acknowledged");

describe("intent pause", () => {
  it("pauses at once, says the honest line, and says the pause holds here only without an account key", async () => {
    const s = setup();
    const result = await s.run(["pause"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Paused: from now on the gateway prepares no cart and completes no purchase.");
    expect(result.out).not.toContain("complete_checkout");
    expect(result.out).toContain("`intent pause` stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off agent payments in the Shop app.");
    expect(result.out).toContain("Not sent to Intent Cloud: no account key on this machine, so the pause holds here only.");
    expect(result.out).toContain(NO_KEY_LIFT);
    expect(result.out).toContain("To resume: run `intent resume`.");
    // Attack on the claim (invariant 5): this machine alone can lift this pause, so no line says a passkey is needed.
    expect(result.out).not.toContain("Resume needs your passkey");
    expect(kinds(s.dir)).toEqual(["pause", "pause_sent"]);
    const status = await s.run(["status"]);
    expect(status.out).toMatch(/^Paused since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\.$/m);
    expect(status.out).toContain(NO_KEY_LIFT);
    expect(status.out).not.toContain("Resume needs your passkey");
    expect(status.out).toContain("Purchases stopped: none was open.");
  });

  it("once Intent Cloud acknowledged the pause, status says resume needs your passkey", async () => {
    const s = setup();
    await s.run(["pause"]);
    await acknowledge(s.dir);
    const status = await s.run(["status"]);
    expect(status.out).toContain("Intent Cloud: acknowledged the pause.\nResume needs your passkey.\n");
  });

  it("before the first approved purchase (Intent Cloud answers 404), status says it can be lifted here until then", async () => {
    const s = setup();
    await s.run(["pause"]);
    await sendResult(s.dir, "retrying", "not_found");
    const status = await s.run(["status"]);
    expect(status.out).toContain("it accepts a pause from this machine only after your first approved purchase");
    expect(status.out).toContain(
      "The pause holds on this machine; Intent Cloud has not acknowledged it yet (it can once your first purchase is approved). Until it does, the pause can be lifted from this machine; after that, resuming needs your passkey.",
    );
    expect(status.out).not.toContain("Resume needs your passkey");
  });
});

describe("intent doctor while paused", () => {
  function lines(dir: string): [Level, string][] {
    const out: [Level, string][] = [];
    checkChain(dir, (level, text) => out.push([level, text]));
    return out;
  }
  /** The pause time, written by `intent pause` at the real clock, as `<time>`. */
  const at = (found: [Level, string][]): [Level, string][] => found.map(([l, t]) => [l, t.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/, "<time>")]);

  it("shows no pause line when purchases are not paused", async () => {
    const s = setup();
    const store = await openStore(s.dir, { clock: () => TS });
    await store.append("keys", { statement: { kid: "k" } });
    await store.close();
    expect(lines(s.dir).map(([, t]) => t).join("\n")).not.toContain("paused");
  });

  it("warns that purchases are paused, with what lifts the pause in each state", async () => {
    const s = setup();
    await s.run(["pause"]);
    expect(at(lines(s.dir))).toContainEqual(["warn", `purchases: paused since <time>. ${NO_KEY_LIFT} intent status says more.`]);
    await acknowledge(s.dir);
    expect(at(lines(s.dir))).toContainEqual(["warn", "purchases: paused since <time>. Resume needs your passkey. intent status says more."]);
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

  it("acknowledged, without a terminal: it names the passkey page and clears nothing", async () => {
    const s = setup();
    await paused(s);
    await acknowledge(s.dir);
    const result = await s.run(["resume"], { input: "resumed\n" });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^Paused since .+ UTC\. Resume needs your passkey\.$/m);
    expect(result.out).toContain("Open https://confirm.example/account and resume there with your passkey.");
    expect(result.err).toContain("resume needs a terminal: after resuming with your passkey");
    expect(kinds(s.dir)).not.toContain("resume");
  });

  it("acknowledged, at a terminal: it asks to confirm the passkey resume", async () => {
    const s = setup();
    await paused(s);
    await acknowledge(s.dir);
    const yes = await s.run(["resume"], { tty: true, input: "resumed\n" });
    expect(yes.out).toContain('Type "resumed" once you have resumed with your passkey on that page: ');
    expect(yes.out).toContain("Local pause cleared, unconfirmed");
  });

  it("not acknowledged yet: it says the pause can be lifted here, and that the passkey page is only for a pause Intent Cloud holds", async () => {
    const s = setup();
    await paused(s);
    await sendResult(s.dir, "retrying", "not_found");
    const noTerminal = await s.run(["resume"], { input: "resumed\n" });
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.out).toContain("Until it does, the pause can be lifted from this machine");
    expect(noTerminal.out).not.toContain("Resume needs your passkey");
    expect(noTerminal.out).not.toContain("resume there with your passkey");
    expect(noTerminal.out).toContain(
      "If Intent Cloud received it after all, the next purchase is answered paused and pauses here again; then resume with your passkey at https://confirm.example/account.",
    );
    expect(noTerminal.err).toContain("resume needs a terminal: run it again in a terminal to lift the pause on this machine");
    expect(kinds(s.dir)).not.toContain("resume");
    const yes = await s.run(["resume"], { tty: true, input: "resumed\n" });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain('Type "resumed" to lift the pause on this machine: ');
    expect(yes.out).toContain("Local pause cleared, unconfirmed");
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
