// Vector o5 (contract 1.6.1, Appendix G "Store pair check"): every case replayed, with the URL the check would fetch
// (none for an origin refused by its form) and the failing rule in the vector's order. Expected values come from
// Intent Cloud's vector, never from this implementation. Then what the vector cannot show.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { metaUrl, parseUniqueJson, STORE_PAIR_LIMITS, storePairPrecondition, storePairProblem } from "./index.ts";

interface O5Case {
  name: string;
  input: {
    merchant_origin: string;
    myshopify_domain: string;
    response: { status: number; content_type: string | null; body: string; pad_to_bytes?: number };
  };
  expected: { url: string | null; valid: boolean; reason: string | null };
}
interface O5 {
  limits: { timeout_seconds: number; max_body_bytes: number; cache_ttl_seconds_max: number };
  cases: O5Case[];
}
const o5 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "o5-store-pair.json"), "utf8")) as O5;

/** The body as read: its UTF-8 bytes, padded with trailing spaces to pad_to_bytes when the case says so. */
function bodyOf(response: O5Case["input"]["response"]): Uint8Array {
  const bytes = Buffer.from(response.body, "utf8");
  return response.pad_to_bytes === undefined ? bytes : Buffer.concat([bytes, Buffer.alloc(response.pad_to_bytes - bytes.length, 0x20)]);
}

describe("vector o5: the store pair check", () => {
  it("has 49 cases and the limits this module enforces", () => {
    expect(o5.cases).toHaveLength(49);
    expect(STORE_PAIR_LIMITS).toEqual({
      timeoutMs: o5.limits.timeout_seconds * 1000,
      maxBodyBytes: o5.limits.max_body_bytes,
      cacheTtlMs: o5.limits.cache_ttl_seconds_max * 1000,
    });
  });

  it.each(o5.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { merchant_origin: origin, myshopify_domain: domain, response } = c.input;
    const target = metaUrl(origin);
    expect("url" in target ? target.url : null).toBe(c.expected.url);
    const reason = storePairProblem(origin, domain, { status: response.status, contentType: response.content_type, body: bodyOf(response) });
    expect(reason).toBe(c.expected.reason);
    expect(reason === null).toBe(c.expected.valid);
  });
});

describe("store pair check: what o5 does not pin", () => {
  const ok = { status: 200, contentType: "application/json", body: Buffer.from('{"myshopify_domain":"test-shop.myshopify.com"}') };

  it("an invalid expected domain is refused before any fetch (bad_domain)", () => {
    expect(storePairPrecondition("https://shop.example", "test-shop.myshopify.com.evil")).toEqual({ reason: "bad_domain" });
    expect(storePairPrecondition("https://shop.example", "test-shop.myshopify.com")).toEqual({ url: "https://shop.example/meta.json" });
  });

  it("invalid UTF-8 is not JSON", () => {
    expect(storePairProblem("https://shop.example", "test-shop.myshopify.com", { ...ok, body: Buffer.from([0x7b, 0xff, 0x7d]) })).toBe("not_json");
  });

  it("attack: a duplicate member name at any depth fails closed; the same name in two objects does not", () => {
    expect(() => parseUniqueJson('{"a":{"b":1,"b":2}}')).toThrow("duplicate");
    expect(() => parseUniqueJson('{"a":"\\"b\\"","a":1}')).toThrow("duplicate");
    expect(() => parseUniqueJson('{"\\u0061":1,"a":2}')).toThrow("duplicate");
    expect(parseUniqueJson('{"a":{"b":1},"c":[{"b":2},{"b":3}],"s":"{\\"b\\":1,\\"b\\":2}"}')).toEqual({ a: { b: 1 }, c: [{ b: 2 }, { b: 3 }], s: '{"b":1,"b":2}' });
  });

  it("the expected domain is compared exactly: an answer naming one store passes only for that store", () => {
    expect(storePairProblem("https://shop.example", "test-shop.myshopify.com", ok)).toBeNull();
    expect(storePairProblem("https://shop.example", "other-shop.myshopify.com", ok)).toBe("differs");
  });
});
