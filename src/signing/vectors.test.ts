// Contract vector c2 (appendix C), reproduced byte for byte. Expected values come from the vector file, which
// Intent Cloud computed; nothing here is derived from the code under test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentDigest, createNonceCache, type RejectCode, sessionFromSeed, signRequest, verifyRequest } from "./index.ts";
import { signatureBase } from "./profile.ts";

interface C2 {
  input: { ed25519_seed_hex: string; method: string; path: string; body: string; created: number; nonce: string };
  expected: {
    keyid: string;
    content_digest: string;
    signature_params: string;
    signature_base: string;
    signature_input_header: string;
    signature_header: string;
    replay: { now: number; status: number };
  };
  refusals: { name: string; headers: Record<string, string>; body: string; now: number; status: number }[];
}

const c2 = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "c2-http-signature.json"), "utf8"),
) as C2;
const { input, expected } = c2;
const session = sessionFromSeed(Buffer.from(input.ed25519_seed_hex, "hex"));
const body = Buffer.from(input.body, "utf8");
const request = { method: input.method, path: input.path, body };
const signed = signRequest(session, { ...request, created: input.created, nonce: input.nonce });

describe("vector c2", () => {
  it("derives the keyid from the seed", () => {
    expect(session.keyid).toBe(expected.keyid);
  });

  it("reproduces the digest, signature base and both signature headers", () => {
    expect(contentDigest(body)).toBe(expected.content_digest);
    expect(signed["content-digest"]).toBe(expected.content_digest);
    expect(signatureBase(input.method, input.path, expected.content_digest, expected.signature_params)).toBe(
      expected.signature_base,
    );
    expect(signed["signature-input"]).toBe(expected.signature_input_header);
    expect(signed.signature).toBe(expected.signature_header);
  });

  it("verifies, then refuses the same request as a replay", () => {
    const seenNonce = createNonceCache();
    expect(verifyRequest(signed, request, { now: input.created, seenNonce })).toEqual({
      ok: true,
      keyid: expected.keyid,
      nonce: input.nonce,
      created: input.created,
    });
    const replay = verifyRequest(signed, request, { now: expected.replay.now, seenNonce });
    expect(replay).toEqual({ ok: false, code: "replay", status: expected.replay.status });
  });

  const codes: Record<string, RejectCode> = {
    "another tag (intent-gateway-v0), correctly signed": "wrong_tag",
    "body changed after signing": "digest_mismatch",
    "created older than 60 s": "created_too_old",
    "created more than 5 s ahead": "created_in_future",
    "keyid with non-zero padding bits (not canonical)": "bad_keyid",
    "signature by another key under this keyid": "bad_signature",
  };

  it("names a code for every refusal in the vector", () => {
    expect(c2.refusals.map((r) => r.name).sort()).toEqual(Object.keys(codes).sort());
  });

  it.each(c2.refusals)("refuses: $name", (refusal) => {
    const result = verifyRequest(
      refusal.headers,
      { ...request, body: Buffer.from(refusal.body, "utf8") },
      { now: refusal.now, seenNonce: createNonceCache() },
    );
    expect(result).toEqual({ ok: false, code: codes[refusal.name], status: refusal.status });
  });
});
