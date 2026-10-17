// Contract suite, meta and trust (G23, AC-R1): the host serves the contract this gateway vendors, and its key
// statement verifies against the root key pinned for it. Runs against TARGET (see target.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION, ErrorBody, Jwks, KeyStatement, Meta } from "../../src/contract/index.ts";
import { type KeySet, verifyStatement } from "../../src/trust/index.ts";
import { closeTargets, openTarget, prepared, receiptProblem, sendRaw, sourceSums, TARGET, type Target, trustedKeySet } from "./target.ts";

/** The released 1.5.0 `SHA256SUMS` sha256 (contract/SOURCE.md). */
const SUMS_1_5_0 = "c6fc6ffea8b7cb9053a74e0a3aa340d73d1c2800fcc4c47669707400d06410d2";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let target: Target;
let keySet: KeySet;

beforeAll(async () => {
  target = await openTarget();
  keySet = await trustedKeySet(target);
});
afterAll(closeTargets);

describe(`meta (${TARGET})`, () => {
  it("reports the vendored contract: contract_sums_sha256 equals contract/SOURCE.md, and the version header", async () => {
    const result = await target.connect().meta();
    expect(result.status).toBe(200);
    if (!result.ok) throw new Error("meta failed");
    const meta = Meta.parse(result.body);
    expect(meta.contract_sums_sha256).toBe(sourceSums());
    expect(meta.contract_version).toBe(CONTRACT_VERSION);
    expect(meta.rule_versions).toEqual(["recheck-v1"]);
    expect(meta.limits).toEqual({ requests_per_minute: 120, carts_per_hour: 10, carts_per_hour_passkey: 50, approvals_per_day: 20 });
    expect(meta).not.toHaveProperty("enrol_origin");
    expect(result.contractVersion).toBe(CONTRACT_VERSION);
    expect(receiptProblem(result, keySet, target.now())).toBeNull();
  });

  // Contract 1.6.0 §V1: the caller picks its version with the header; published 1.5.0 gateways send none.
  it("answers a request without Intent-Contract-Version as 1.5.0, with the released 1.5.0 sums", async () => {
    const signed = await prepared((beforeSend) => target.connect().meta({ beforeSend }));
    const request = { ...signed, headers: signed.headers.filter(([name]) => name !== "host" && name !== "intent-contract-version") };
    const reply = await sendRaw(target, request);
    expect(reply.status).toBe(200);
    expect(reply.headers["intent-contract-version"]).toBe("1.5.0");
    expect(Meta.parse(reply.json)).toMatchObject({ contract_version: "1.5.0", contract_sums_sha256: SUMS_1_5_0 });
  });

  it("refuses a version it does not serve with 400 unsupported contract version", async () => {
    const signed = await prepared((beforeSend) => target.connect().meta({ beforeSend }));
    const request = {
      ...signed,
      headers: signed.headers.filter(([name]) => name !== "host").map(([n, v]) => [n, n === "intent-contract-version" ? "9.9.9" : v] as const),
    };
    const reply = await sendRaw(target, request);
    expect(reply.status).toBe(400);
    expect(ErrorBody.parse(reply.json)).toEqual({ error: "bad_request", message: "unsupported contract version" });
  });
});

describe("key statement", () => {
  it("verifies against the pinned root key and parses with the contract schema", async () => {
    const result = await target.connect().keyStatement();
    expect(result.status).toBe(200);
    if (!result.ok) throw new Error("key statement failed");
    KeyStatement.parse(result.body);
    expect(verifyStatement(result.body, target.rootKeys, target.now()).ok).toBe(true);
    expect(receiptProblem(result, keySet, target.now())).toBeNull();
  });

  it("does not verify against another root key (attack: a statement the pin did not sign)", async () => {
    const result = await target.connect().keyStatement();
    const other = [{ kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32, 7).toString("base64url") } }];
    expect(verifyStatement(result.body, other, target.now())).toMatchObject({ ok: false, step: 2 });
  });

  it("serves at /v1/signature-keys only the approval key, as the verified statement lists it", async () => {
    const [statement, keys] = [await target.connect().keyStatement(), await target.connect().signatureKeys()];
    expect(keys.status).toBe(200);
    if (!statement.ok || !keys.ok) throw new Error("key reads failed");
    const listed = new Map(statement.body.keys.map((k) => [k.kid, k.x]));
    const served = Jwks.parse(keys.body).keys;
    expect(served.length).toBeGreaterThan(0);
    for (const key of served) {
      expect(key.kid).toMatch(/^cloud-approval-\d{6}$/);
      expect(listed.get(key.kid), key.kid).toBe(key.x);
    }
    expect(receiptProblem(keys, keySet, target.now())).toBeNull();
  });
});
