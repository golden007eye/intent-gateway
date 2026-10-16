// TARGET selects the contract suite's target; a typo must fail the run, never fall back to the fake.
import { describe, expect, it } from "vitest";
import { targetName } from "./target.ts";

describe("TARGET", () => {
  it("defaults to fake and accepts fake or staging", () => {
    expect(targetName({})).toBe("fake");
    expect(targetName({ TARGET: "fake" })).toBe("fake");
    expect(targetName({ TARGET: "staging" })).toBe("staging");
  });

  it.each(["", "Staging", "prod", "stagign"])("refuses %j", (value) => {
    expect(() => targetName({ TARGET: value })).toThrow(/TARGET must be/);
  });
});
