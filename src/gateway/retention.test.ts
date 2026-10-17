// The completer key retention rules (ADR-0016) on hand-made chains with a fixed clock: each rule keeps the key one
// second before its moment and deletes it at that moment.
import { describe, expect, it } from "vitest";
import type { Entry, EntryKind } from "../store/index.ts";
import { expiredCompleterKeys, ORPHAN_GRACE_MS, READ_WINDOW_MS } from "./retention.ts";

const T0 = Date.parse("2026-10-15T12:00:00Z");
const EXPIRES = T0 + 15 * 60_000;
const KEY = "gw-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HANDLE = "ap_TEST0001";
const at = (ms: number): string => new Date(ms).toISOString();

function chainOf(...items: [EntryKind, unknown, number?][]): Entry[] {
  return items.map(([kind, body, ts], seq) => ({ seq, prev: "", ts: at(ts ?? T0), kind, body, hash: "" }));
}
const pending = (mode = "handoff") =>
  ["approval_pending", { handle: HANDLE, expires_at: at(EXPIRES), total_minor: 100, completion_mode: mode, completer_keyid: KEY }] as [EntryKind, unknown];
const approval: [EntryKind, unknown] = ["approval", { handle: HANDLE, proof: {} }];
const observed = (state: string, outcome?: string, ts = T0): [EntryKind, unknown, number] => [
  "observed",
  { endpoint: "getApproval", approval_handle: HANDLE, state, ...(outcome === undefined ? {} : { outcome_state: outcome }) },
  ts,
];
/** A Cloud `outcome` entry (ADR-0015): what the gateway showed, and whether the statement verified. */
const outcomeEntry = (stateShown: string | null, verified: boolean, ts = T0): [EntryKind, unknown, number] => [
  "outcome",
  {
    handle: HANDLE,
    basis: "cloud",
    outcome_hash: "a".repeat(64),
    cloud: { state: stateShown ?? "ordered", source: "merchant_api", assurance: "verified" },
    statement_verified: verified,
    ...(verified ? {} : { refused_by: "cloud_signature" }),
    state_shown: stateShown,
  },
  ts,
];
const reportOf = (state: string, seqTs = T0): [EntryKind, unknown, number] => [
  "disclosure",
  { endpoint: "reportOutcome", path: `/v1/approvals/${HANDLE}/outcome-reports`, body_b64: Buffer.from(JSON.stringify({ state })).toString("base64") },
  seqTs,
];
const keys = [{ keyid: KEY, createdAt: T0 }];
const gone = (chain: Entry[], now: number): boolean => expiredCompleterKeys(chain, keys, now).includes(KEY);

describe("completer key retention", () => {
  it("an orphan key (no approval_pending names it) goes an hour after it was made; an unreadable one at once", () => {
    expect(gone([], T0 + ORPHAN_GRACE_MS - 1)).toBe(false);
    expect(gone([], T0 + ORPHAN_GRACE_MS)).toBe(true);
    expect(expiredCompleterKeys([], [{ keyid: KEY, createdAt: Number.NaN }], T0)).toEqual([KEY]);
  });

  it("a cart never approved: the key goes at expires_at", () => {
    const chain = chainOf(pending(), observed("pending"));
    expect(gone(chain, EXPIRES - 1)).toBe(false);
    expect(gone(chain, EXPIRES)).toBe(true);
  });

  it("an approval shown but not chained (a flagged passkey): kept for the read window", () => {
    const chain = chainOf(pending(), observed("approved"));
    expect(gone(chain, EXPIRES + READ_WINDOW_MS - 1)).toBe(false);
    expect(gone(chain, EXPIRES + READ_WINDOW_MS)).toBe(true);
  });

  it("a handed-off purchase with no terminal outcome: kept 48 h past expires_at, then gone", () => {
    const chain = chainOf(pending(), approval, observed("handed_off", "handed_off"));
    expect(gone(chain, EXPIRES + 47 * 3_600_000)).toBe(false);
    expect(gone(chain, EXPIRES + READ_WINDOW_MS)).toBe(true);
  });

  it.each(["ordered", "checkout_expired", "mismatch"])("a hand-off purchase: gone once a verified statement showed %s", (outcome) => {
    const chain = chainOf(pending(), approval, outcomeEntry(outcome, true, T0 + 60_000));
    expect(gone(chain, T0 + 60_000)).toBe(true);
  });

  it("a verified non-terminal outcome (handed_off) keeps the key", () => {
    expect(gone(chainOf(pending(), approval, outcomeEntry("handed_off", true)), T0 + 60_000)).toBe(false);
  });

  it.each(["ordered", "checkout_expired", "mismatch"])("attack: a forged terminal %s (status observed, or statement not verified) does not delete a hand-off key early", (outcome) => {
    const chain = chainOf(
      pending(),
      approval,
      observed(outcome === "ordered" ? "ordered" : "handed_off", outcome, T0 + 60_000),
      outcomeEntry(null, false, T0 + 60_000),
    );
    expect(gone(chain, T0 + 60_000)).toBe(false);
    expect(gone(chain, EXPIRES + READ_WINDOW_MS)).toBe(true);
  });

  it("a shop_agent purchase: kept while its terminal report has no 201; gone once one does", () => {
    const sent = chainOf(pending("shop_agent"), approval, reportOf("ordered", T0 + 60_000));
    expect(gone(sent, T0 + 60_000)).toBe(false);
    const failed500 = [...sent, ...chainOf(["receipt", { disclosure_seq: 2, status: 500, verified: true }])].map((e, seq) => ({ ...e, seq }));
    expect(gone(failed500, EXPIRES + 47 * 3_600_000)).toBe(false);
    const accepted = [...failed500, ...chainOf(reportOf("ordered", T0 + 120_000), ["receipt", { disclosure_seq: 4, status: 201, verified: true }])].map((e, seq) => ({
      ...e,
      seq,
    }));
    expect(gone(accepted, T0 + 120_000)).toBe(true);
  });

  it("attack: a 201 with an unverified receipt does not count as the terminal report's answer", () => {
    const chain = chainOf(pending("shop_agent"), approval, reportOf("failed"), ["receipt", { disclosure_seq: 2, status: 201, verified: false }]);
    expect(gone(chain, T0)).toBe(false);
  });

  it("item 8: a shop_agent report that never got its 201 extends nothing: gone at expires_at + 48 h", () => {
    const late = EXPIRES + 3_600_000;
    const chain = chainOf(pending("shop_agent"), approval, reportOf("failed", late));
    expect(gone(chain, EXPIRES + READ_WINDOW_MS - 1)).toBe(false);
    expect(gone(chain, EXPIRES + READ_WINDOW_MS)).toBe(true);
  });

  it("item 8: no chain keeps a key past Intent Cloud's R7 limit (expires_at + 48 h, with no terminal at Intent Cloud)", () => {
    const chains = [
      chainOf(pending()),
      chainOf(pending(), observed("approved")),
      chainOf(pending(), approval),
      chainOf(pending(), approval, observed("handed_off", "handed_off", EXPIRES + 3_600_000)),
      chainOf(pending(), approval, observed("approved", "ordered", EXPIRES + 3_600_000)),
      chainOf(pending("shop_agent"), approval, reportOf("completing"), reportOf("ordered", EXPIRES + 40 * 3_600_000)),
    ];
    for (const chain of chains) expect(gone(chain, EXPIRES + READ_WINDOW_MS)).toBe(true);
  });

  it("a non-terminal report (completing, indeterminate) keeps the key for the window from expires_at", () => {
    const chain = chainOf(pending("shop_agent"), approval, reportOf("completing"), ["receipt", { disclosure_seq: 2, status: 201, verified: true }]);
    expect(gone(chain, EXPIRES + READ_WINDOW_MS - 1)).toBe(false);
    expect(gone(chain, EXPIRES + READ_WINDOW_MS)).toBe(true);
  });

  it("a malformed approval_pending keeps its key for the read window from the entry's time", () => {
    const chain = chainOf(["approval_pending", { completer_keyid: KEY }]);
    expect(gone(chain, T0 + READ_WINDOW_MS - 1)).toBe(false);
    expect(gone(chain, T0 + READ_WINDOW_MS)).toBe(true);
  });
});
