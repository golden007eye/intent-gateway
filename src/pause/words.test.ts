// What every surface says lifts a pause (ADR-0023, invariant 5): "Resume needs your passkey" only once Intent Cloud
// holds the pause; until then, that it holds on this machine and can be lifted here. QA on preview.6: a new user
// pauses before any purchase, so Intent Cloud cannot hold it yet, and every surface still said the passkey was needed.
import { describe, expect, it } from "vitest";
import { heldByCloud, liftWords, type PauseEntry, pausedRefusalWords, pauseState } from "./index.ts";

let seq = 0;
const entry = (kind: string, body: unknown): PauseEntry => ({ seq: seq++, ts: "2026-10-18T12:00:00.000Z", kind, body });
const sent = (pauseSeq: number, result: string, reason: string): PauseEntry => entry("pause_sent", { pause_seq: pauseSeq, counter: 1, disclosure_seq: 0, result, reason });

function chain(...rest: ((pauseSeq: number) => PauseEntry)[]): PauseEntry[] {
  seq = 0;
  const pause = entry("pause", { from: "cli" });
  return [pause, ...rest.map((make) => make(pause.seq))];
}

const PASSKEY = "Resume needs your passkey.";

describe("what lifts the pause, by state", () => {
  it("acknowledged by Intent Cloud: resume needs the passkey", () => {
    const state = pauseState(chain((p) => sent(p, "acknowledged", "acknowledged")));
    expect(heldByCloud(state)).toBe(true);
    expect(liftWords(state)).toBe(PASSKEY);
    expect(pausedRefusalWords(state)).toBe("Not sent: the developer paused purchases through intent (`intent pause`). Nothing is bought until they resume with their passkey; do not retry.");
  });

  it("paused by Intent Cloud's own answer (another device): resume needs the passkey", () => {
    seq = 0;
    const state = pauseState([entry("pause", { from: "intent_cloud", disclosure_seq: 0 })]);
    expect(heldByCloud(state)).toBe(true);
    expect(liftWords(state)).toBe(PASSKEY);
  });

  it.each([
    ["not sent yet", chain(), ""],
    ["Intent Cloud does not know the key yet (404, before the first approved purchase)", chain((p) => sent(p, "retrying", "not_found")), " (it can once your first purchase is approved)"],
    ["no account key on this machine", chain((p) => sent(p, "retrying", "no_account_key")), " (it needs an account key on this machine: run `intent init`)"],
    ["no connection", chain((p) => sent(p, "retrying", "unreachable")), ""],
    ["refused for good (400)", chain((p) => sent(p, "failed", "bad_request")), ""],
  ])("not acknowledged (%s): it holds on this machine and can be lifted here", (_label, entries, when) => {
    const state = pauseState(entries);
    expect(heldByCloud(state)).toBe(false);
    expect(liftWords(state)).toBe(
      `The pause holds on this machine; Intent Cloud has not acknowledged it yet${when}. Until it does, the pause can be lifted from this machine; after that, resuming needs your passkey.`,
    );
    // Attack on the claim (invariant 5): no surface says the passkey is needed now when this machine alone can lift it.
    expect(liftWords(state)).not.toContain("Resume needs your passkey");
    expect(pausedRefusalWords(state)).toBe("Not sent: the developer paused purchases through intent (`intent pause`). Nothing is bought until they lift it (`intent resume`); do not retry.");
  });

  it("an acknowledgement of an earlier pause does not count for a new one", () => {
    seq = 0;
    const first = entry("pause", { from: "cli" });
    const entries = [first, sent(first.seq, "acknowledged", "acknowledged"), entry("resume", { from: "cli", confirmed: false, pending: "next submit" }), entry("pause", { from: "cli" })];
    expect(heldByCloud(pauseState(entries))).toBe(false);
  });

  it("no agent-facing pause text names a tool the agent does not have", () => {
    for (const state of [pauseState(chain()), pauseState(chain((p) => sent(p, "acknowledged", "acknowledged")))]) {
      expect(pausedRefusalWords(state)).not.toContain("complete_checkout");
    }
  });
});
