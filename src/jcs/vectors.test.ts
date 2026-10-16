// The shared vectors of the Intent Cloud public contract (contract/vectors), reproduced byte for byte with src/jcs.
// Expected values come from the vector files, which Intent Cloud computed; nothing here is derived from the code under test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, JcsError, sha256Hex } from "./index.ts";

const vectors = join(import.meta.dirname, "..", "..", "contract", "vectors");
// JSON.parse keeps lone surrogates and exact integers, so each value reaches canonicalize as the vector wrote it.
const load = (name: string): unknown => JSON.parse(readFileSync(join(vectors, name), "utf8"));

interface SnapshotVector {
  input: { continue_url: string; snapshot: Record<string, unknown> };
  expected: {
    continue_url_hash: string;
    jcs: string;
    jcs_utf8_hex?: string;
    snapshot_hash: string;
    check_code: string;
    challenge: { approve: string; reject: string };
  };
}
interface LedgerVector {
  input: { entry: Record<string, unknown> };
  expected: { entry_hash: string };
}
interface JcsVector {
  cases: { name: string; value: unknown; canonical: string; canonical_utf8_hex: string }[];
  refusals: { name: string; value: unknown }[];
}

const utf8Hex = (text: string): string => Buffer.from(text, "utf8").toString("hex");
// Appendix A: challenge(action) = base64url(SHA-256(JCS({"action": action, "snapshot_hash": snapshot_hash}))).
const challenge = (action: string, snapshotHash: string): string =>
  Buffer.from(sha256Hex(canonicalize({ action, snapshot_hash: snapshotHash })), "hex").toString("base64url");

describe.each([
  ["a1-snapshot.json", "A1"],
  ["a2-snapshot-unicode.json", "A2"],
])("appendix A vector %s", (file) => {
  const { input, expected } = load(file) as SnapshotVector;

  it("reproduces the canonical form byte for byte", () => {
    const jcs = canonicalize(input.snapshot);
    expect(jcs).toBe(expected.jcs);
    if (expected.jcs_utf8_hex !== undefined) expect(utf8Hex(jcs)).toBe(expected.jcs_utf8_hex);
  });

  it("reproduces snapshot_hash and check_code", () => {
    const hash = sha256Hex(canonicalize(input.snapshot));
    expect(hash).toBe(expected.snapshot_hash);
    expect(hash.slice(0, 8)).toBe(expected.check_code);
  });

  it("reproduces continue_url_hash, which the snapshot carries", () => {
    expect(`sha256:${sha256Hex(input.continue_url)}`).toBe(expected.continue_url_hash);
    expect(input.snapshot.continue_url_hash).toBe(expected.continue_url_hash);
  });

  it("reproduces the approve and reject challenges", () => {
    expect(challenge("approve", expected.snapshot_hash)).toBe(expected.challenge.approve);
    expect(challenge("reject", expected.snapshot_hash)).toBe(expected.challenge.reject);
  });

  it("changes snapshot_hash when one field changes (attack: altered snapshot)", () => {
    const altered = { ...input.snapshot, quantity: 3 };
    expect(sha256Hex(canonicalize(altered))).not.toBe(expected.snapshot_hash);
  });
});

describe("appendix B vector b1-ledger.json", () => {
  const { input, expected } = load("b1-ledger.json") as LedgerVector;

  it("reproduces the genesis entry_hash over JCS(E)", () => {
    expect(sha256Hex(canonicalize(input.entry))).toBe(expected.entry_hash);
  });

  it("chains onto the a1 snapshot_hash", () => {
    const a1 = load("a1-snapshot.json") as SnapshotVector;
    expect(input.entry.snapshot_hash).toBe(a1.expected.snapshot_hash);
  });

  it("changes entry_hash when prev_hash changes (attack: re-parented entry)", () => {
    const altered = { ...input.entry, prev_hash: "1".padStart(64, "0") };
    expect(sha256Hex(canonicalize(altered))).not.toBe(expected.entry_hash);
  });
});

describe("JCS vector j1-jcs.json", () => {
  const { cases, refusals } = load("j1-jcs.json") as JcsVector;

  it("has cases and refusals", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(refusals.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))("canonicalises %s", (_name, c) => {
    const text = canonicalize(c.value);
    expect(text).toBe(c.canonical);
    expect(utf8Hex(text)).toBe(c.canonical_utf8_hex);
  });

  it.each(refusals.map((r) => [r.name, r] as const))("refuses %s with JcsError", (_name, r) => {
    expect(() => canonicalize(r.value)).toThrow(JcsError);
  });
});
