// The integer-only profile on parse (Appendix G, Update 2 item 9): a token that is not written as a safe integer is
// never read as one.
import { describe, expect, it } from "vitest";
import { canonicalize, NonIntegerNumber, parseIntegerJson } from "./index.ts";

describe("parseIntegerJson", () => {
  it("keeps integer tokens as numbers", () => {
    expect(parseIntegerJson('{"a":1,"b":[0,-3,9007199254740991],"c":"1.0"}')).toEqual({ a: 1, b: [0, -3, 9007199254740991], c: "1.0" });
  });
  it.each(["1.0", "1e0", "1E2", "-0.5", "9007199254740992"])("marks %s as not an integer", (token) => {
    const value = (parseIntegerJson(`{"q":${token}}`) as { q: unknown }).q;
    expect(value).toBeInstanceOf(NonIntegerNumber);
    expect((value as NonIntegerNumber).source).toBe(token);
  });
  it("a marked value has no canonical form", () => {
    expect(() => canonicalize(parseIntegerJson("[1.0]"))).toThrow();
  });
  it("throws on text that is not JSON", () => {
    expect(() => parseIntegerJson("{")).toThrow(SyntaxError);
  });
});
