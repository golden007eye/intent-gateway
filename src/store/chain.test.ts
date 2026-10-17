// verifyChain over real store output with hand-made damage. Each expected brokenSeq is counted by hand from the
// damage done; the genesis hash is recomputed here with node:crypto from a hand-written canonical string.
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { ENTRY_KINDS, openStore, parseLines, readChain, verifyChain } from "./index.ts";

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
vi.setConfig({ testTimeout: 20_000 }); // the store writes with fdatasync, which a busy disk can stall for seconds
let dir: string;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "store-chain-"));
  let now = T0;
  const store = await openStore(dir, { clock: () => now });
  for (let i = 0; i < 5; i++) {
    await store.append("disclosure", { n: i, note: `entry ${String(i)}` });
    now += 1000;
  }
  await store.close();
  lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).split("\n").slice(0, -1);
});

const check = (text: string) => verifyChain(parseLines(text));
const joined = (ls: readonly string[]) => ls.map((l) => `${l}\n`).join("");
function rehash(line: string, change: (e: Record<string, unknown>) => void): string {
  const entry = JSON.parse(line) as Record<string, unknown>;
  change(entry);
  delete entry.hash;
  return canonicalize({ ...entry, hash: sha256Hex(canonicalize(entry)) });
}

describe("entry format", () => {
  it("hashes the canonical JSON of the entry without its hash, starting from 64 zeros", () => {
    const expected =
      '{"body":{"n":0,"note":"entry 0"},"kind":"disclosure","prev":"' +
      "0".repeat(64) +
      '","seq":0,"ts":"2026-10-15T12:00:00.000Z"}';
    const hash = createHash("sha256").update(expected).digest("hex");
    expect(lines[0]).toBe(
      `{"body":{"n":0,"note":"entry 0"},"hash":"${hash}","kind":"disclosure","prev":"${"0".repeat(64)}",` +
        `"seq":0,"ts":"2026-10-15T12:00:00.000Z"}`,
    );
    const second = JSON.parse(lines[1] as string) as { prev: string; seq: number };
    expect(second).toMatchObject({ prev: hash, seq: 1 });
  });

  it("lists exactly the seventeen entry kinds", () => {
    expect([...ENTRY_KINDS].sort()).toEqual(
      [
        "approval",
        "approval_pending",
        "approver_flag",
        "approver_pin",
        "block",
        "discarded",
        "disclosure",
        "keys",
        "observed",
        "receipt",
        "session",
        "unacknowledged",
        "response",
        "completion",
        "complete_attempt",
        "outcome",
        "wallet",
      ].sort(),
    );
  });
});

describe("verifyChain", () => {
  it("accepts the untouched chain and the empty chain", () => {
    expect(check(joined(lines))).toEqual({ ok: true });
    expect(verifyChain(readChain(dir))).toEqual({ ok: true });
    expect(check("")).toEqual({ ok: true });
  });

  it("names the entry whose byte was tampered with", () => {
    const tampered = [...lines];
    tampered[2] = (tampered[2] as string).replace("entry 2", "entry 7");
    expect(check(joined(tampered))).toMatchObject({ ok: false, brokenSeq: 2, reason: "hash does not match the entry" });
  });

  it("names the entry whose tampered byte broke the JSON", () => {
    const tampered = [...lines];
    tampered[3] = `[${(tampered[3] as string).slice(1)}`;
    expect(check(joined(tampered))).toMatchObject({ ok: false, brokenSeq: 3 });
  });

  it("names the entry after one that was forged with a recomputed hash", () => {
    const forged = [...lines];
    forged[2] = rehash(forged[2] as string, (e) => (e.body = { n: 2, note: "forged" }));
    expect(check(joined(forged))).toMatchObject({ ok: false, brokenSeq: 3, reason: "prev does not match the previous entry's hash" });
  });

  it("names the position of a deleted line", () => {
    const deleted = lines.filter((_, i) => i !== 2);
    expect(check(joined(deleted))).toMatchObject({ ok: false, brokenSeq: 2, reason: "seq is 3, expected 2" });
  });

  it("names the first position of two reordered lines", () => {
    const reordered = [lines[0], lines[1], lines[3], lines[2], lines[4]] as string[];
    expect(check(joined(reordered))).toMatchObject({ ok: false, brokenSeq: 2 });
  });

  it("names the entry cut mid-line by truncation", () => {
    const text = joined(lines);
    const cutLast = text.slice(0, text.length - 20);
    expect(check(cutLast)).toMatchObject({ ok: false, brokenSeq: 4, reason: "line is not a canonical JSON entry" });
    const cutMiddle = text.slice(0, text.indexOf(lines[2] as string) + 30);
    expect(check(cutMiddle)).toMatchObject({ ok: false, brokenSeq: 2 });
  });

  it("names a line that parses but is not canonical JSON", () => {
    const spaced = [...lines];
    spaced[1] = (spaced[1] as string).replace('"seq":1', '"seq": 1');
    expect(check(joined(spaced))).toMatchObject({ ok: false, brokenSeq: 1 });
    expect(check(`${joined(lines.slice(0, 2))}\n${joined(lines.slice(2))}`)).toMatchObject({ ok: false, brokenSeq: 2 });
  });

  it("accepts a chain whose last whole entries were dropped: only external evidence shows it (ADR-0007)", () => {
    expect(check(joined(lines.slice(0, 3)))).toEqual({ ok: true });
    expect(check("")).toEqual({ ok: true });
  });

  it("continues from a verified head and counts seq from it", () => {
    const head = JSON.parse(lines[1] as string) as { seq: number; hash: string };
    expect(verifyChain(parseLines(joined(lines.slice(2))), head)).toEqual({ ok: true });
    expect(verifyChain(parseLines(joined(lines.slice(3))), head)).toMatchObject({ ok: false, brokenSeq: 2 });
  });

  it("names entries that are well hashed but malformed", () => {
    const at1 = (change: (e: Record<string, unknown>) => void) => {
      const ls = [...lines];
      ls[1] = rehash(ls[1] as string, change);
      return check(joined(ls));
    };
    expect(at1((e) => (e.kind = "note"))).toMatchObject({ brokenSeq: 1, reason: "unknown kind" });
    expect(at1((e) => (e.ts = 5))).toMatchObject({ brokenSeq: 1, reason: "ts is not a string" });
    expect(at1((e) => (e.seq = "1"))).toMatchObject({ brokenSeq: 1, reason: "seq is not an integer" });
    expect(at1((e) => (e.extra = true))).toMatchObject({ brokenSeq: 1, reason: "entry fields are not seq, prev, ts, kind, body, hash" });
    expect(verifyChain([null])).toMatchObject({ brokenSeq: 0 });
    const notGenesis = rehash(lines[0] as string, (e) => (e.prev = "f".repeat(64)));
    expect(check(`${notGenesis}\n`)).toMatchObject({ brokenSeq: 0, reason: "prev does not match the previous entry's hash" });
  });
});
