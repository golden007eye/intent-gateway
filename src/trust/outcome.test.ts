// Outcome statements (Appendix G, as amended M2) replayed from vector o2: only the valid statement verifies, and each
// refusal names the rule of `refused_by`. Expected values come from Intent Cloud's vectors; attack cases are signed
// here with the published test approval key and fail exactly the rule under test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { at, PINNED, S1, seedOf, signOutcomeStatement, without } from "../../test/support/trust-kit.ts";
import { type SnapshotV2 } from "../contract/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { PINNED_HOSTS } from "../config/index.ts";
import { type KeySet, stagingSourceAllowed, verifyOutcomeStatement, verifyStatement } from "./index.ts";

interface O2 {
  input: { valid_at: number; approved_snapshot?: SnapshotV2; approved_snapshot_hash: string };
  cases: { name: string; statement: Record<string, unknown>; verifies: boolean; refused_by?: string }[];
}
const root = join(import.meta.dirname, "..", "..");
const load = (path: string): O2 => JSON.parse(readFileSync(join(root, path), "utf8")) as O2;
const AMENDED = load("contract/vectors/o2-outcome-statement.json");
const NOW = at(AMENDED.input.valid_at);
const SNAPSHOT = AMENDED.input.approved_snapshot as SnapshotV2;
const HASH = AMENDED.input.approved_snapshot_hash;
const HANDLE = "ap_TEST0003";
/** The vector's statements name `staging_webhook`, accepted under the s1 test root (stagingSourceAllowed). */
const STAGING_OK = { stagingSource: true } as const;
/** src/ lint forbids naming a property `binding` (it would also match `process.binding`). */
const BINDING = "binding";

function keys(): KeySet {
  const r = verifyStatement(S1.expected.statement, PINNED, NOW);
  if (!r.ok) throw new Error("s1 does not verify");
  return r.keySet;
}
const approval = { handle: HANDLE, snapshot: SNAPSHOT, snapshotHash: HASH };

describe("vector o2", () => {
  it("the approved snapshot hashes to approved_snapshot_hash", () => {
    expect(sha256Hex(canonicalize(SNAPSHOT))).toBe(HASH);
  });
  it("names every refusal category of the amendment", () => {
    expect(new Set(AMENDED.cases.flatMap((c) => (c.refused_by === undefined ? [] : [c.refused_by])))).toEqual(
      new Set(["cloud_signature", "snapshot_hash", "binding_result", "required_fields", "final_total", "mode", "order_ref", "assurance", "source"]),
    );
  });
  it.each(AMENDED.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const result = verifyOutcomeStatement(c.statement, approval, keys(), NOW, STAGING_OK);
    if (c.verifies) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, refused_by: c.refused_by });
  });
  it("1.6.1: two statements verify, the second naming a 14-digit Shopify order id (S1)", () => {
    const valid = AMENDED.cases.filter((c) => c.verifies);
    expect(valid).toHaveLength(2);
    expect((valid[1]?.statement.outcome as { order_ref?: unknown }).order_ref).toMatch(/^gid:\/\/shopify\/Order\/[0-9]{14}$/);
  });
  it("1.6.1: a statement for an approval whose snapshot is v3 is checked like v2 (only v1 has no statement)", () => {
    const v3 = { ...SNAPSHOT, v: 3 as const, myshopify_domain: "test-shop.myshopify.com" };
    const valid = AMENDED.cases.find((c) => c.verifies)?.statement as Record<string, unknown>;
    // The content rules read the total and the mode, which v3 keeps as v2 has them; only a v1 snapshot is refused.
    expect(verifyOutcomeStatement(valid, { handle: HANDLE, snapshot: v3, snapshotHash: HASH }, keys(), NOW, STAGING_OK)).toEqual({ ok: true });
  });
  it("content refusals are signed claims; signature and snapshot refusals are not", () => {
    for (const c of AMENDED.cases.filter((x) => !x.verifies)) {
      const result = verifyOutcomeStatement(c.statement, approval, keys(), NOW, STAGING_OK);
      expect(!result.ok && result.signed).toBe(c.refused_by !== "cloud_signature" && c.refused_by !== "snapshot_hash");
    }
  });
});

describe("staging_webhook: only for Intent Cloud staging, or under the test root", () => {
  const valid = AMENDED.cases.find((c) => c.verifies)?.statement as Record<string, unknown>;
  it("attack: a staging_webhook outcome is refused (source) when the pinned host is not staging or the test root", () => {
    expect(verifyOutcomeStatement(valid, approval, keys(), NOW, { stagingSource: false })).toEqual({ ok: false, refused_by: "source", signed: true });
    expect(verifyOutcomeStatement(valid, approval, keys(), NOW, { stagingSource: true })).toEqual({ ok: true });
  });
  it("stagingSourceAllowed: the test root and the staging host's pinned root, nothing else", () => {
    expect(stagingSourceAllowed(PINNED)).toBe(true);
    const staging = PINNED_HOSTS["staging-api.intentai.shop"]?.rootKeys ?? [];
    expect(stagingSourceAllowed(staging)).toBe(true);
    const other = { kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } };
    expect(stagingSourceAllowed([other])).toBe(false);
    expect(stagingSourceAllowed([...staging, other])).toBe(false);
    expect(stagingSourceAllowed([])).toBe(false);
  });
});

describe("outcome statements: attacks and rules beyond the vector", () => {
  const valid = AMENDED.cases.find((c) => c.verifies)?.statement as Record<string, unknown>;
  const unsigned = without(valid, "cloud_signature") as Record<string, unknown>;
  const outcome = valid.outcome as Record<string, unknown>;
  const resign = (changes: Record<string, unknown>, outcomeChanges: Record<string, unknown> = {}) =>
    signOutcomeStatement({ ...unsigned, ...changes, outcome: { ...outcome, ...outcomeChanges } });
  const check = (statement: unknown, a = approval) => verifyOutcomeStatement(statement, a, keys(), NOW, STAGING_OK);

  it("re-signing the valid statement's fields reproduces its signature", () => {
    expect(signOutcomeStatement(unsigned).cloud_signature).toBe(valid.cloud_signature);
  });
  it("attack: signed without the prefix is refused (cloud_signature)", () => {
    expect(check(signOutcomeStatement(unsigned, seedOf("cloud-approval-202610"), ""))).toEqual({ ok: false, refused_by: "cloud_signature", signed: false });
  });
  it("attack: signed by a receipt key, under its own kid or an approval kid, is refused", () => {
    expect(check(signOutcomeStatement({ ...unsigned, kid: "cloud-receipt-202610" }, seedOf("cloud-receipt-202610")))).toMatchObject({ refused_by: "schema" });
    expect(check(signOutcomeStatement(unsigned, seedOf("cloud-receipt-202610")))).toMatchObject({ refused_by: "cloud_signature" });
  });
  it("attack: an approval kid the key statement does not list is refused", () => {
    expect(check(resign({ kid: "cloud-approval-209901" }))).toMatchObject({ refused_by: "unknown_kid" });
  });
  it("a statement for another approval, or for a v1 snapshot, is refused", () => {
    expect(check(resign({ approval_handle: "ap_OTHER0001" }))).toMatchObject({ refused_by: "approval_handle" });
    const v1 = { ...approval, snapshot: { ...SNAPSHOT, v: 1 } as never };
    expect(check(valid, v1)).toMatchObject({ refused_by: "v1_snapshot" });
  });
  it("needs a key set verifyStatement made, and one still valid", () => {
    expect(verifyOutcomeStatement(valid, approval, { ...keys() }, NOW, STAGING_OK)).toMatchObject({ refused_by: "not_verified" });
    expect(verifyOutcomeStatement(valid, approval, keys(), new Date(Date.parse("2026-12-01T00:00:00Z")), STAGING_OK)).toMatchObject({ refused_by: "statement_expired" });
  });
  it("not an object, extra fields or a lone surrogate: schema", () => {
    expect(check(null)).toMatchObject({ refused_by: "schema" });
    expect(check({ ...valid, extra: 1 })).toMatchObject({ refused_by: "schema" });
    expect(check({ ...valid, outcome: { ...outcome, order_ref: "\ud800" } })).toMatchObject({ refused_by: "schema" });
  });
  it("attack (O1): a signed ordered with assurance reported is refused o1, a signed contradiction", () => {
    expect(check(resign({}, { assurance: "reported" }))).toEqual({ ok: false, refused_by: "o1", signed: true });
  });
  it("attack: a gateway report dressed as a verified order is refused by the source's cap", () => {
    const reported = { state: "ordered", source: "shop_api", order_ref: "#1001", final_total: outcome.final_total };
    expect(check(resign({}, { source: "gateway_report", reported }))).toMatchObject({ refused_by: "assurance", signed: true });
  });
  it("a reported state claims verified: assurance; a gateway_report without its reported block: required_fields", () => {
    const base = { state: "reported", source: "checkout_page", assurance: "verified", observed_at: outcome.observed_at };
    expect(check(signOutcomeStatement({ ...unsigned, outcome: base }))).toMatchObject({ refused_by: "assurance" });
    expect(check(signOutcomeStatement({ ...unsigned, outcome: { ...base, source: "gateway_report", assurance: "reported" } }))).toMatchObject({ refused_by: "required_fields" });
  });
  it("a final total in another currency: final_total", () => {
    expect(check(resign({}, { final_total: { amount_minor: 12500, currency: "CAD" } }))).toMatchObject({ refused_by: "final_total" });
  });

  describe("shop_agent: Intent Cloud's stored gateway reports (R5, Update 2 item 5)", () => {
    const shopSnapshot = { ...SNAPSHOT, completion_mode: "shop_agent" } as SnapshotV2;
    const shop = { handle: HANDLE, snapshot: shopSnapshot, snapshotHash: sha256Hex(canonicalize(shopSnapshot)) };
    const stored = (state: string, reportedState: string, extra: Record<string, unknown> = {}) =>
      signOutcomeStatement({
        ...unsigned,
        snapshot_hash: shop.snapshotHash,
        outcome: { state, source: "gateway_report", assurance: "reported", observed_at: outcome.observed_at, reported: { state: reportedState, source: "shop_api", ...extra } },
      });
    it.each(["completing", "indeterminate", "failed"])("a stored %s verifies", (state) => {
      expect(check(stored(state, state), shop)).toEqual({ ok: true });
    });
    it("a stored gateway ordered is `reported` and verifies; its reported block's binding must be consistent", () => {
      const reported = { order_ref: "gid://shopify/Order/1001", final_total: outcome.final_total, binding: outcome[BINDING] };
      expect(check(stored("reported", "ordered", reported), shop)).toEqual({ ok: true });
      const contradicting = { ...reported, binding: { rule_version: "binding-v1", result: "ok", checks: { ...(outcome[BINDING] as { checks: object }).checks, line: "differs" } } };
      expect(check(stored("reported", "ordered", contradicting), shop)).toMatchObject({ refused_by: "binding_result" });
      expect(check(stored("reported", "ordered", { ...reported, order_ref: "buyer@example.com" }), shop)).toMatchObject({ refused_by: "order_ref" });
    });
    it("a reported block naming a non-gateway source or an unknown state is refused", () => {
      const bad = signOutcomeStatement({
        ...unsigned,
        snapshot_hash: shop.snapshotHash,
        outcome: { state: "failed", source: "gateway_report", assurance: "reported", observed_at: outcome.observed_at, reported: { state: "failed", source: "merchant_api" } },
      });
      expect(check(bad, shop)).toMatchObject({ refused_by: "required_fields" });
      expect(check(stored("failed", "handed_off"), shop)).toMatchObject({ refused_by: "required_fields" });
    });
    it("handed_off is not a shop_agent state: mode", () => {
      const s = signOutcomeStatement({ ...unsigned, snapshot_hash: shop.snapshotHash, outcome: { state: "handed_off", source: "checkout_page", assurance: "reported", observed_at: outcome.observed_at } });
      expect(check(s, shop)).toMatchObject({ refused_by: "mode" });
    });
  });
});
