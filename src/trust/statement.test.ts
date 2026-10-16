// Appendix F: the key statement. Expected values come from vector s1 (computed by Intent Cloud) and from
// statements re-signed here with the published s1 test root, each failing exactly one rule.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { at, PINNED, ROOT, S1, signStatement, STATEMENT_VALID_AT, without } from "../../test/support/trust-kit.ts";
import { MAX_CLOCK_SKEW_MS, verifyStatement } from "./index.ts";

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const ISSUED = Date.parse("2026-09-01T00:00:00Z");
const keys = S1.input.unsigned.keys as { kid: string; x: string }[];

describe("verifyStatement: vector s1", () => {
  it("verifies s1 under the pinned cloud-root-1 and yields its keys, origin and rp_id", () => {
    const result = verifyStatement(S1.expected.statement, PINNED, STATEMENT_VALID_AT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ks = result.keySet;
    expect(ks.rootKid).toBe("cloud-root-1");
    expect([...ks.receiptKeys.keys()]).toEqual(["cloud-receipt-202610", "cloud-receipt-202611"]);
    expect([...ks.approvalKeys.keys()]).toEqual(["cloud-approval-202610", "cloud-approval-202611"]);
    expect(ks.receiptKeys.get("cloud-receipt-202610")?.export({ format: "jwk" }).x).toBe("JUO5L_EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0");
    expect(ks.confirmOrigin).toBe("https://confirm.example");
    expect(ks.rpId).toBe("example");
    expect(ks.issuedAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(ks.expiresAt.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(Object.isFrozen(ks)).toBe(true);
  });

  it("re-signing s1's unsigned fields with the s1 root reproduces its signature byte for byte", () => {
    expect(signStatement().signature).toBe(S1.expected.statement.signature);
  });

  const expectedReason: Record<string, [number, string]> = {
    "expired (now = expires_at)": [3, "expired"],
    "issued more than 5 minutes ahead": [3, "issued_in_future"],
    "field changed after signing": [2, "bad_signature"],
    "signed by a root key that is not pinned": [2, "bad_signature"],
    "kid not pinned": [2, "root_not_pinned"],
  };
  it("names every s1 refusal", () => {
    expect(S1.refusals.map((r) => r.name).sort()).toEqual(Object.keys(expectedReason).sort());
  });
  for (const refusal of S1.refusals) {
    it(`refuses: ${refusal.name}`, () => {
      const [step, reason] = expectedReason[refusal.name] ?? [0, ""];
      expect(verifyStatement(refusal.statement, PINNED, at(refusal.now))).toEqual({ ok: false, step, reason });
    });
  }
});

describe("verifyStatement: clock", () => {
  it("accepts issued_at exactly 5 minutes ahead, and refuses one second more", () => {
    expect(verifyStatement(S1.expected.statement, PINNED, new Date(ISSUED - MAX_CLOCK_SKEW_MS)).ok).toBe(true);
    expect(verifyStatement(S1.expected.statement, PINNED, new Date(ISSUED - MAX_CLOCK_SKEW_MS - 1000))).toMatchObject({ reason: "issued_in_future" });
  });
  it("accepts one second before expires_at and fails closed from expires_at on", () => {
    const expires = Date.parse("2026-11-30T00:00:00Z");
    expect(verifyStatement(S1.expected.statement, PINNED, new Date(expires - 1000)).ok).toBe(true);
    expect(verifyStatement(S1.expected.statement, PINNED, new Date(expires + DAY))).toEqual({ ok: false, step: 3, reason: "expired" });
  });
});

describe("verifyStatement: rules the schema leaves out", () => {
  const now = new Date(ISSUED + DAY);
  const lifetime = (days: number, extraMs = 0) => signStatement({ issued_at: iso(ISSUED), expires_at: iso(ISSUED + days * DAY + extraMs) });

  it("accepts a lifetime of exactly 90 and exactly 180 days", () => {
    expect(verifyStatement(lifetime(90), PINNED, now).ok).toBe(true);
    expect(verifyStatement(lifetime(180), PINNED, now).ok).toBe(true);
  });
  it("refuses a lifetime under 90 days or over 180 days, even when root-signed", () => {
    expect(verifyStatement(lifetime(90, -1000), PINNED, now)).toEqual({ ok: false, step: 1, reason: "lifetime" });
    expect(verifyStatement(lifetime(89), PINNED, now)).toEqual({ ok: false, step: 1, reason: "lifetime" });
    expect(verifyStatement(lifetime(180, 1000), PINNED, now)).toEqual({ ok: false, step: 1, reason: "lifetime" });
    expect(verifyStatement(lifetime(365), PINNED, now)).toEqual({ ok: false, step: 1, reason: "lifetime" });
    expect(verifyStatement(lifetime(-10), PINNED, now)).toEqual({ ok: false, step: 1, reason: "lifetime" });
  });
  it("refuses a timestamp that names no real date", () => {
    expect(verifyStatement(signStatement({ issued_at: "2026-02-30T00:00:00Z" }), PINNED, now)).toEqual({ ok: false, step: 1, reason: "bad_timestamp" });
  });

  const [r1, r2, a1, a2] = keys;
  const extra = (prefix: string) => ({ ...r1, kid: `${prefix}-209901` });
  it("refuses 3 keys for one use", () => {
    const st = signStatement({ keys: [r1, r2, extra("cloud-receipt"), a1] });
    expect(verifyStatement(st, PINNED, now)).toEqual({ ok: false, step: 1, reason: "key_count" });
  });
  it("refuses a statement with no approval key, or no receipt key", () => {
    expect(verifyStatement(signStatement({ keys: [r1, r2] }), PINNED, now)).toEqual({ ok: false, step: 1, reason: "key_count" });
    expect(verifyStatement(signStatement({ keys: [a1, a2] }), PINNED, now)).toEqual({ ok: false, step: 1, reason: "key_count" });
  });
  it("accepts one key per use", () => {
    expect(verifyStatement(signStatement({ keys: [r1, a1] }), PINNED, now).ok).toBe(true);
  });
  it("refuses a repeated kid", () => {
    const st = signStatement({ keys: [r1, { ...r2, kid: r1?.kid }, a1] });
    expect(verifyStatement(st, PINNED, now)).toEqual({ ok: false, step: 1, reason: "duplicate_kid" });
  });
  it("refuses a key whose x is not a canonical 32-byte encoding", () => {
    const x = `${r1?.x.slice(0, 42) ?? ""}1`;
    expect(verifyStatement(signStatement({ keys: [{ ...r1, x }, a1] }), PINNED, now)).toEqual({ ok: false, step: 1, reason: "bad_key" });
  });
  it("refuses what the schema refuses: an unknown field, a missing signature, a non-object", () => {
    expect(verifyStatement({ ...S1.expected.statement, extra: 1 }, PINNED, STATEMENT_VALID_AT)).toEqual({ ok: false, step: 1, reason: "schema" });
    expect(verifyStatement(without(S1.expected.statement, "signature"), PINNED, STATEMENT_VALID_AT)).toMatchObject({ reason: "schema" });
    expect(verifyStatement(null, PINNED, STATEMENT_VALID_AT)).toMatchObject({ reason: "schema" });
  });
});

describe("verifyStatement: root pin", () => {
  it("refuses a statement signed by any key but the pinned root, even under the pinned kid", () => {
    const attacker = generateKeyPairSync("ed25519").privateKey;
    expect(verifyStatement(signStatement({}, attacker), PINNED, STATEMENT_VALID_AT)).toEqual({ ok: false, step: 2, reason: "bad_signature" });
  });
  it("refuses everything when no root key is pinned", () => {
    expect(verifyStatement(S1.expected.statement, [], STATEMENT_VALID_AT)).toEqual({ ok: false, step: 2, reason: "root_not_pinned" });
  });
  it("refuses a pinned root that is not an Ed25519 key, or not a key at all", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    expect(verifyStatement(S1.expected.statement, [{ kid: "cloud-root-1", jwk: ec }], STATEMENT_VALID_AT)).toMatchObject({ reason: "root_not_pinned" });
    expect(verifyStatement(S1.expected.statement, [{ kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519" } }], STATEMENT_VALID_AT)).toMatchObject({
      reason: "root_not_pinned",
    });
  });
  it("uses the root key pinned under the statement's kid", () => {
    const other = { kid: "cloud-root-2", jwk: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) };
    expect(verifyStatement(S1.expected.statement, [other, ...PINNED], STATEMENT_VALID_AT).ok).toBe(true);
    expect(verifyStatement(signStatement({ kid: "cloud-root-2" }, ROOT), [other, ...PINNED], STATEMENT_VALID_AT)).toMatchObject({ reason: "bad_signature" });
  });
});
