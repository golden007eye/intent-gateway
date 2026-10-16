// Contract suite, meta and trust (G23, AC-R1): the host serves the contract this gateway vendors, and its key
// statement verifies against the root key pinned for it. Runs against TARGET (see target.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION, Jwks, KeyStatement, Meta } from "../../src/contract/index.ts";
import { type KeySet, verifyStatement } from "../../src/trust/index.ts";
import { closeTargets, openTarget, receiptProblem, sourceSums, TARGET, type Target, trustedKeySet } from "./target.ts";

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
    expect(result.contractVersion).toBe(CONTRACT_VERSION);
    expect(receiptProblem(result, keySet, target.now())).toBeNull();
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

  it("serves at /v1/signature-keys only keys the verified statement lists", async () => {
    const [statement, keys] = [await target.connect().keyStatement(), await target.connect().signatureKeys()];
    expect(keys.status).toBe(200);
    if (!statement.ok || !keys.ok) throw new Error("key reads failed");
    const listed = new Map(statement.body.keys.map((k) => [k.kid, k.x]));
    for (const key of Jwks.parse(keys.body).keys) expect(listed.get(key.kid), key.kid).toBe(key.x);
    expect(receiptProblem(keys, keySet, target.now())).toBeNull();
  });
});
