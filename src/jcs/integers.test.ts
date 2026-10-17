// Integer-only JSON (amendment item 9): a number token with a fraction or an exponent is found, even where
// JSON.parse would turn it into an integer; digits inside strings are not numbers.
import { describe, expect, it } from "vitest";
import { nonIntegerToken } from "./index.ts";

describe("nonIntegerToken", () => {
  it.each([
    ['{"amount_minor":12500,"currency":"USD"}', null],
    ['{"a":[1,-2,0],"b":"1.5e3 in a string","c":"\\"2.0\\""}', null],
    ['{"amount_minor":12500.0}', "12500.0"],
    ['{"amount_minor":1e4}', "1e4"],
    ['{"amount_minor":-0.0}', "-0.0"],
    ['[1,2,3.25]', "3.25"],
    ['{"x":"a\\\\","y":1.5}', "1.5"],
  ])("%s → %s", (text, expected) => {
    expect(nonIntegerToken(text)).toBe(expected);
  });

  it("attack: 12500.0 parses to the integer 12500, so only the token check can see it", () => {
    expect(Number.isInteger((JSON.parse('{"a":12500.0}') as { a: number }).a)).toBe(true);
    expect(nonIntegerToken('{"a":12500.0}')).toBe("12500.0");
  });
});
