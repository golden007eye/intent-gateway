// Appendix D: receipts. Expected values come from vector d1 (computed by Intent Cloud); the request the gateway
// "logged" is rebuilt here from each case's input, with the digest computed independently of the code under test.
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadVector, PINNED, S1, seedOf, signReceipt, STATEMENT_VALID_AT, without } from "../../test/support/trust-kit.ts";
import { type KeySet, type SentRequest, verifyReceipt, verifyStatement } from "./index.ts";

interface ReceiptVector {
  cases: {
    name: string;
    input: { method: string; path: string; body: string; signature_input: string | null; status: number };
    expected: { receipt: Record<string, unknown> & { request: Record<string, unknown> }; jcs: string; intent_receipt: string; intent_receipt_signature: string };
  }[];
}
const D1 = loadVector("d1-receipt.json") as ReceiptVector;

function keySetAt(now: Date): KeySet {
  const result = verifyStatement(S1.expected.statement, PINNED, now);
  if (!result.ok) throw new Error(`s1 did not verify: ${result.reason}`);
  return result.keySet;
}
const keySet = keySetAt(STATEMENT_VALID_AT);
const now = STATEMENT_VALID_AT;

/** What the gateway logged for a case: its own digest of the body and the signature parameters it signed with. */
function sentFor(input: ReceiptVector["cases"][number]["input"]): SentRequest {
  const content_digest = `sha-256=:${createHash("sha256").update(input.body, "utf8").digest("base64")}:`;
  const sent: SentRequest = { method: input.method, path: input.path, content_digest };
  if (input.signature_input === null) return sent;
  const param = (name: string) => new RegExp(`;${name}=("?)([^";]*)\\1`).exec(input.signature_input ?? "")?.[2] ?? "";
  return { ...sent, keyid: param("keyid"), nonce: param("nonce"), created: Number(param("created")) };
}

const [signedCase, unsignedCase] = D1.cases;
if (signedCase === undefined || unsignedCase === undefined) throw new Error("d1 has fewer cases than expected");
const signedSent = sentFor(signedCase.input);
const signedReceipt = signedCase.expected.receipt;
const response = (receipt: { receipt: string; signature: string }, status = signedCase.input.status) => ({ status, ...receipt });

describe("verifyReceipt: vector d1", () => {
  for (const c of D1.cases) {
    it(`verifies: ${c.name}`, () => {
      const result = verifyReceipt(
        { status: c.input.status, receipt: c.expected.intent_receipt, signature: c.expected.intent_receipt_signature },
        sentFor(c.input),
        keySet,
        now,
      );
      expect(result).toEqual({ ok: true, receipt: c.expected.receipt });
    });
  }
  it("the d1 headers decode to the vector's JCS", () => {
    expect(Buffer.from(signedCase.expected.intent_receipt, "base64url").toString("utf8")).toBe(signedCase.expected.jcs);
  });
});

describe("verifyReceipt: refusals", () => {
  const vectorHeaders = { receipt: signedCase.expected.intent_receipt, signature: signedCase.expected.intent_receipt_signature };

  it("refuses a missing receipt or a missing signature", () => {
    expect(verifyReceipt({ status: 201, receipt: undefined, signature: undefined }, signedSent, keySet, now)).toEqual({ ok: false, step: 1, reason: "missing" });
    expect(verifyReceipt({ ...response(vectorHeaders), signature: undefined }, signedSent, keySet, now)).toMatchObject({ step: 1, reason: "missing" });
    expect(verifyReceipt({ ...response(vectorHeaders), receipt: undefined }, signedSent, keySet, now)).toMatchObject({ step: 1, reason: "missing" });
  });
  it("refuses headers that are not strict base64url", () => {
    expect(verifyReceipt(response({ ...vectorHeaders, receipt: `${vectorHeaders.receipt}=` }), signedSent, keySet, now)).toMatchObject({ reason: "bad_encoding" });
    expect(verifyReceipt(response({ ...vectorHeaders, signature: `${vectorHeaders.signature.slice(0, 85)}+` }), signedSent, keySet, now)).toMatchObject({
      reason: "bad_encoding",
    });
    expect(verifyReceipt(response({ ...vectorHeaders, receipt: "" }), signedSent, keySet, now)).toMatchObject({ reason: "bad_encoding" });
  });
  it("refuses a body that is not UTF-8 JSON", () => {
    expect(verifyReceipt(response(signReceipt("not json")), signedSent, keySet, now)).toEqual({ ok: false, step: 2, reason: "not_json" });
    const bad = { receipt: Buffer.from([0xff, 0xfe, 0x7b]).toString("base64url"), signature: vectorHeaders.signature };
    expect(verifyReceipt(response(bad), signedSent, keySet, now)).toEqual({ ok: false, step: 2, reason: "not_json" });
  });
  it("refuses a signed receipt that is not canonical JSON", () => {
    expect(verifyReceipt(response(signReceipt(JSON.stringify(signedReceipt, null, 1))), signedSent, keySet, now)).toEqual({ ok: false, step: 2, reason: "not_canonical" });
    expect(verifyReceipt(response(signReceipt(`{"v":1.5}`)), signedSent, keySet, now)).toMatchObject({ reason: "not_canonical" });
  });
  it("refuses a signed receipt outside the schema", () => {
    expect(verifyReceipt(response(signReceipt({ ...signedReceipt, extra: true })), signedSent, keySet, now)).toEqual({ ok: false, step: 2, reason: "schema" });
    const partial = without(signedReceipt.request, "keyid");
    expect(verifyReceipt(response(signReceipt({ ...signedReceipt, request: partial })), signedSent, keySet, now)).toMatchObject({ reason: "schema" });
  });
  it("refuses a receipt kid the statement does not list (wrong kid)", () => {
    const r = signReceipt({ ...signedReceipt, kid: "cloud-receipt-202612" });
    expect(verifyReceipt(response(r), signedSent, keySet, now)).toEqual({ ok: false, step: 3, reason: "unknown_kid" });
  });
  it("refuses a receipt signed with an approval key or any key but the listed one", () => {
    expect(verifyReceipt(response(signReceipt(signedReceipt, seedOf("cloud-approval-202610"))), signedSent, keySet, now)).toEqual({
      ok: false,
      step: 3,
      reason: "bad_signature",
    });
    expect(verifyReceipt(response(signReceipt(signedReceipt, seedOf("cloud-receipt-202611"))), signedSent, keySet, now)).toMatchObject({ reason: "bad_signature" });
    expect(verifyReceipt(response(signReceipt(signedReceipt, generateKeyPairSync("ed25519").privateKey)), signedSent, keySet, now)).toMatchObject({
      reason: "bad_signature",
    });
  });
  it("refuses a signature over another receipt", () => {
    const other = D1.cases[2];
    const swapped = { receipt: vectorHeaders.receipt, signature: other?.expected.intent_receipt_signature ?? "" };
    expect(verifyReceipt(response(swapped), signedSent, keySet, now)).toMatchObject({ step: 3, reason: "bad_signature" });
  });
  it("accepts a receipt signed with the next listed receipt key", () => {
    const r = signReceipt({ ...signedReceipt, kid: "cloud-receipt-202611" }, seedOf("cloud-receipt-202611"));
    expect(verifyReceipt(response(r), signedSent, keySet, now).ok).toBe(true);
  });

  const mismatches: [string, Partial<SentRequest>, string][] = [
    ["wrong digest", { content_digest: `sha-256=:${createHash("sha256").update("other").digest("base64")}:` }, "digest_mismatch"],
    ["wrong nonce", { nonce: "bm9uY2UtdGVzdC0wMDAwMw==" }, "nonce_mismatch"],
    ["wrong keyid", { keyid: "gw-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, "keyid_mismatch"],
    ["wrong created", { created: 1790251201 }, "created_mismatch"],
    ["wrong method", { method: "GET" }, "method_mismatch"],
    ["wrong path", { path: "/v1/carts/other" }, "path_mismatch"],
  ];
  for (const [name, change, reason] of mismatches) {
    it(`refuses a valid receipt for another request: ${name}`, () => {
      expect(verifyReceipt(response(vectorHeaders), { ...signedSent, ...change }, keySet, now)).toEqual({ ok: false, step: 4, reason });
    });
  }
  it("refuses a receipt with signature parameters for a request sent unsigned, and the reverse", () => {
    const unsigned: SentRequest = { method: signedSent.method, path: signedSent.path, content_digest: signedSent.content_digest };
    expect(verifyReceipt(response(vectorHeaders), unsigned, keySet, now)).toMatchObject({ step: 4, reason: "keyid_mismatch" });
    const unsignedHeaders = { receipt: unsignedCase.expected.intent_receipt, signature: unsignedCase.expected.intent_receipt_signature };
    const sentSigned = { ...sentFor(unsignedCase.input), keyid: signedSent.keyid ?? "", nonce: "x", created: 1 };
    expect(verifyReceipt({ status: 200, ...unsignedHeaders }, sentSigned, keySet, now)).toMatchObject({ step: 4, reason: "keyid_mismatch" });
  });
  it("refuses a receipt for another status (the 429 receipt on a 201 response)", () => {
    const refused = D1.cases[2];
    const headers = { receipt: refused?.expected.intent_receipt ?? "", signature: refused?.expected.intent_receipt_signature ?? "" };
    expect(verifyReceipt({ status: 201, ...headers }, signedSent, keySet, now)).toEqual({ ok: false, step: 5, reason: "status_mismatch" });
  });
});

describe("verifyReceipt: key set", () => {
  const headers = { status: 201, receipt: signedCase.expected.intent_receipt, signature: signedCase.expected.intent_receipt_signature };
  it("fails closed once the statement has expired", () => {
    expect(verifyReceipt(headers, signedSent, keySet, new Date(keySet.expiresAt.getTime()))).toEqual({ ok: false, step: 3, reason: "statement_expired" });
  });
  it("refuses a key set that verifyStatement did not make", () => {
    const forged: KeySet = { ...keySet };
    expect(verifyReceipt(headers, signedSent, forged, now)).toEqual({ ok: false, step: 3, reason: "not_verified" });
  });
  it("ignores keys added to a key set's public view after verification", () => {
    const own = keySetAt(now);
    const attacker = generateKeyPairSync("ed25519");
    (own.receiptKeys as Map<string, unknown>).set("cloud-receipt-209901", attacker.publicKey);
    const r = signReceipt({ ...signedReceipt, kid: "cloud-receipt-209901" }, attacker.privateKey);
    expect(verifyReceipt(response(r), signedSent, own, now)).toMatchObject({ step: 3, reason: "unknown_kid" });
  });
});
