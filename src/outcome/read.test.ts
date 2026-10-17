// Rules O1, O2 and M1 on read (Appendix G): what the gateway shows for Intent Cloud's outcome, never more than the
// verified statement; R5a's precedence replayed from vector o4; and the local-evidence rule for spend-cap room.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chargedNothing, type OutcomeHead, readCloudOutcome, replaces, shownStatus } from "./index.ts";

const CHECKS_OK = { merchant_origin: "match", checkout_ref: "match", line: "match", ship_to: "match", total: "match" } as const;
const ORDERED = {
  state: "ordered",
  source: "signed_webhook",
  assurance: "verified",
  order_ref: "#1001",
  final_total: { amount_minor: 12500, currency: "USD" },
  binding: { rule_version: "binding-v1", result: "ok", checks: CHECKS_OK },
  observed_at: "2026-10-16T12:05:00Z",
};
const A = 12500;
/** src/ lint forbids naming a property `binding` (it would also match `process.binding`). */
const BINDING = "binding";
const OK = { ok: true } as const;

describe("readCloudOutcome", () => {
  it("a verified ordered whose binding holds locally is shown ordered, with the gateway's own binding", () => {
    expect(readCloudOutcome(ORDERED, A, OK)).toEqual({ state_shown: "ordered", local_binding: ORDERED[BINDING] });
  });
  it("attack (AC-G4.1): Intent Cloud signs ordered with final total A+1 (refused final_total): nothing shown, never ordered", () => {
    const over = { ...ORDERED, final_total: { amount_minor: A + 1, currency: "USD" } };
    const reading = readCloudOutcome(over, A, { ok: false, refused_by: "final_total", signed: true });
    expect(reading.state_shown).toBeNull();
    expect(reading.local_binding).toMatchObject({ result: "mismatch", checks: { total: "differs" } });
    // Even if a verifier let it through, the gateway's own total check would not show ordered.
    expect(readCloudOutcome(over, A, OK).state_shown).toBeNull();
  });
  it("attack (AC-G4.2): ordered dressed with assurance reported (refused o1), or from a reported-only source: nothing shown", () => {
    expect(readCloudOutcome({ ...ORDERED, assurance: "reported" }, A, { ok: false, refused_by: "o1", signed: true }).state_shown).toBeNull();
    expect(readCloudOutcome({ ...ORDERED, source: "checkout_page" }, A, { ok: false, refused_by: "assurance", signed: true }).state_shown).toBeNull();
  });
  it("M1: an unverified or unsigned statement shows nothing", () => {
    expect(readCloudOutcome(ORDERED, A, { ok: false, refused_by: "cloud_signature", signed: false }).state_shown).toBeNull();
    expect(readCloudOutcome(ORDERED, A, { ok: false, refused_by: "m1", signed: false }).state_shown).toBeNull();
    expect(readCloudOutcome(ORDERED, A, { ok: false, refused_by: "mode", signed: true }).state_shown).toBeNull();
    expect(readCloudOutcome({ state: "handed_off" }, A, { ok: false, refused_by: "final_total", signed: true }).state_shown).toBeNull();
    expect(readCloudOutcome({ state: "failed" }, A, { ok: false, refused_by: "o1", signed: true }).state_shown).toBeNull();
  });
  it("a verified ordered whose checks are incomplete locally shows nothing", () => {
    const incomplete = { ...ORDERED, binding: { ...ORDERED[BINDING], checks: { ...CHECKS_OK, ship_to: "unknown" } } };
    expect(readCloudOutcome(incomplete, A, OK).state_shown).toBeNull();
  });
  it("other verified states are shown as Intent Cloud stated them, with no binding when none came", () => {
    expect(readCloudOutcome({ state: "handed_off", source: "checkout_page", assurance: "reported" }, A, OK)).toEqual({ state_shown: "handed_off", local_binding: null });
    expect(readCloudOutcome({ state: "reported", source: "gateway_report" }, A, OK).state_shown).toBe("reported");
    expect(readCloudOutcome(null, A, { ok: false, refused_by: "schema", signed: false })).toEqual({ state_shown: null, local_binding: null });
  });
  it("shownStatus follows Appendix G's table", () => {
    expect(shownStatus("ordered", "shop_agent")).toBe("ordered");
    expect(shownStatus("mismatch", "handoff")).toBe("handed_off");
    expect(shownStatus("failed", "shop_agent")).toBe("approved");
  });
});

describe("vector o4: R5a precedence", () => {
  const o4 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "o4-report-transitions.json"), "utf8")) as {
    precedence: { current: OutcomeHead; new: OutcomeHead; replaces: boolean }[];
  };
  it("has rows", () => {
    expect(o4.precedence.length).toBeGreaterThan(30);
  });
  it.each(o4.precedence.map((r) => [`${r.current.state}/${r.current.source} <- ${r.new.state}/${r.new.source}`, r] as const))("%s", (_n, r) => {
    expect(replaces(r.current, r.new)).toBe(r.replaces);
  });
});

describe("chargedNothing: cap room only on local evidence (contract §6)", () => {
  const H = "ap_TEST0003";
  const local = (state: string, source: string) => ({ kind: "outcome", body: { handle: H, basis: "local", state, source, state_shown: state } });
  const cloud = (state: string) => ({
    kind: "outcome",
    body: { handle: H, basis: "cloud", outcome_hash: "0".repeat(64), cloud: { state, source: "merchant_api", assurance: "verified" }, statement_verified: true, state_shown: state },
  });
  it("attack (invariant 1): a verified Intent Cloud failed or checkout_expired frees nothing", () => {
    expect(chargedNothing([cloud("failed")], H)).toBe(false);
    expect(chargedNothing([cloud("checkout_expired")], H)).toBe(false);
  });
  it("Shop's terminal not-completed read frees the room", () => {
    expect(chargedNothing([local("failed", "shop_api")], H)).toBe(true);
  });
  it("the gateway's own refusal frees it only while no complete_checkout disclosure was logged after the approval (fail closed)", () => {
    const approval = { kind: "approval", body: { handle: H } };
    expect(chargedNothing([approval, local("failed", "gateway_precheck")], H)).toBe(true);
    const sent = { kind: "disclosure", body: { destination: "shop", endpoint: "complete_checkout", purchase: H } };
    expect(chargedNothing([approval, sent, local("failed", "gateway_precheck")], H)).toBe(false);
    // A send that names no purchase, or another one, still keeps the room: the branch does not rely on `purchase`.
    const unnamed = { kind: "disclosure", body: { destination: "shop", endpoint: "complete_checkout" } };
    expect(chargedNothing([approval, unnamed, local("failed", "gateway_precheck")], H)).toBe(false);
    const other = { kind: "disclosure", body: { destination: "shop", endpoint: "complete_checkout", purchase: "ap_OTHER0001" } };
    expect(chargedNothing([approval, other, local("failed", "gateway_precheck")], H)).toBe(false);
    // One logged before the approval belongs to an earlier purchase.
    expect(chargedNothing([other, approval, local("failed", "gateway_precheck")], H)).toBe(true);
  });
  it("the latest local outcome decides; indeterminate holds the room", () => {
    expect(chargedNothing([local("failed", "shop_api"), local("indeterminate", "shop_api")], H)).toBe(false);
    expect(chargedNothing([local("failed", "shop_api")], "ap_OTHER0001")).toBe(false);
  });
});
