// Expected outputs are written out by hand from RFC 8785, never computed by the code under test.
// The shared vectors a1/b1 do not exist yet; their byte-for-byte reproduction test is added by G05a, which brings
// the vectors in with the public contract.
import { describe, expect, it } from "vitest";
import { canonicalize, JcsError, sha256Hex } from "./index.ts";

describe("canonicalize: RFC 8785 examples within the integer profile", () => {
  it("sorts the §3.2.3 keys by UTF-16 code units", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("serialises the §3.2.2 literals and string example", () => {
    // RFC input: {"string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/", "literals": [null, true, false]}
    const input = JSON.parse(
      String.raw`{"string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/", "literals": [null, true, false]}`,
    ) as unknown;
    expect(canonicalize(input)).toBe(String.raw`{"literals":[null,true,false],"string":"€$\u000f\nA'B\"\\\\\"/"}`);
  });

  it.each([
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [-1, "-1"],
    [9007199254740991, "9007199254740991"],
    [-9007199254740991, "-9007199254740991"],
  ])("serialises the integer %d as %s (appendix B)", (n, text) => {
    expect(canonicalize(n)).toBe(text);
  });
});

describe("canonicalize: edge cases", () => {
  it.each([
    ["control characters", "\u0000\u0001\u001f", String.raw`"\u0000\u0001\u001f"`],
    ["short escapes", "\b\t\n\f\r", String.raw`"\b\t\n\f\r"`],
    ["quote and backslash", '"\\', String.raw`"\"\\"`],
    ["solidus unescaped", "/", '"/"'],
    ["DEL unescaped", "\u007f", '"\u007f"'],
    ["U+2028 and U+2029 unescaped", "\u2028\u2029", '"\u2028\u2029"'],
    ["astral pair unescaped", "\ud83d\ude00", '"\ud83d\ude00"'],
    ["empty string", "", '""'],
  ])("escapes %s", (_name, input, text) => {
    expect(canonicalize(input)).toBe(text);
  });

  it.each([
    ["literals", [null, true, false], "[null,true,false]"],
    ["empty object", {}, "{}"],
    ["empty array", [], "[]"],
    ["empty containers nested", { b: {}, a: [[], {}] }, '{"a":[[],{}],"b":{}}'],
    ["nested arrays", [[1, [2, [3]]], []], "[[1,[2,[3]]],[]]"],
    ["nested objects sorted at each level", { z: { y: 1, x: 2 }, a: { c: [{ e: 1, d: 2 }] } }, '{"a":{"c":[{"d":2,"e":1}]},"z":{"x":2,"y":1}}'],
    ["prefix keys", { b: 1, aa: 2, a: 3, "": 4 }, '{"":4,"a":3,"aa":2,"b":1}'],
    ["upper before lower", { a: 1, B: 2, A: 3 }, '{"A":3,"B":2,"a":1}'],
    ["key escaping", { "\n": 1, '"': 2 }, '{"\\n":1,"\\"":2}'],
    ["null-prototype object", Object.assign(Object.create(null) as object, { b: 1, a: 2 }), '{"a":2,"b":1}'],
  ])("serialises %s", (_name, input, text) => {
    expect(canonicalize(input)).toBe(text);
  });

  it("orders an astral key before U+FB33 (UTF-16 order, not code point order)", () => {
    expect(canonicalize({ "\ufb33": 1, "\ud83d\ude00": 2, "\uffff": 3 })).toBe('{"\ud83d\ude00":2,"\ufb33":1,"\uffff":3}');
  });

  it("accepts a shared, non-cyclic reference", () => {
    const shared = { k: 1 };
    expect(canonicalize([shared, { s: shared }])).toBe('[{"k":1},{"s":{"k":1}}]');
  });

  it("is idempotent on its own output", () => {
    const text = canonicalize({ b: [1, "x\u0001"], a: { "\u00e9": null } });
    expect(canonicalize(JSON.parse(text))).toBe(text);
  });
});

describe("canonicalize: rejects values outside the integer profile", () => {
  class Point {
    x = 1;
  }
  class List extends Array<number> {}
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);

  it.each([
    ["non-integer", 1.5],
    ["tiny fraction", 1e-27],
    ["2^53", 2 ** 53],
    ["-(2^53)", -(2 ** 53)],
    ["1e21", 1e21],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["lone high surrogate", "a\ud83d"],
    ["lone low surrogate", "\ude00b"],
    ["reversed pair", "\ude00\ud83d"],
    ["lone surrogate in a key", { "\ud800": 1 }],
    ["undefined", undefined],
    ["undefined property", { a: undefined }],
    ["function", () => 1],
    ["symbol", Symbol("s")],
    ["bigint", 1n],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["class instance", new Point()],
    ["Uint8Array", new Uint8Array(1)],
    ["boxed string", Object("s") as object],
    ["Array subclass", List.from([1])],
    ["sparse array", sparse],
    ["symbol key", { [Symbol("k")]: 1 }],
    ["cyclic object", cyclic],
    ["cyclic array", cyclicArray],
    ["deeply nested float", { a: [{ b: [0.1] }] }],
  ])("rejects %s", (_name, input) => {
    expect(() => canonicalize(input)).toThrow(JcsError);
  });

  it("names the path of the offending value", () => {
    expect(() => canonicalize({ a: [1, { b: 2.5 }] })).toThrow('non-integer number at $["a"][1]["b"]');
  });
});

describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("hashes the FIPS 180-2 string %j", (input, hex) => {
    expect(sha256Hex(input)).toBe(hex);
  });

  it("hashes bytes and their UTF-8 string alike", () => {
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex("abc"));
    expect(sha256Hex(new TextEncoder().encode("\u20ac"))).toBe(sha256Hex("\u20ac"));
  });

  it("refuses a string with a lone surrogate instead of hashing U+FFFD", () => {
    expect(() => sha256Hex("\ud800")).toThrow(TypeError);
  });
});
