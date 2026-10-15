import { describe, expect, it } from "vitest";
import { isAllowed, rejected } from "./licence-check.ts";

describe("isAllowed", () => {
  it.each(["MIT", "Apache-2.0", "(MIT OR GPL-3.0)", "MIT AND ISC", "Apache-2.0 WITH LLVM-exception", "(MIT AND GPL-3.0) OR Apache-2.0"])("allows %s", (expression) => {
    expect(isAllowed(expression)).toBe(true);
  });

  it.each(["GPL-3.0", "AGPL-3.0-only", "MIT AND GPL-2.0", "SSPL-1.0", "Unknown", "GPL-3.0 AND (MIT OR Apache-2.0)", "GPL-2.0 WITH Classpath-exception-2.0", "(MIT", "MIT OR", ""])("rejects %s", (expression) => {
    expect(isAllowed(expression)).toBe(false);
  });
});

describe("rejected", () => {
  it("lists each package under a disallowed licence", () => {
    const report = { MIT: [{ name: "ok" }], "GPL-3.0": [{ name: "bad-a" }, { name: "bad-b" }] };
    expect(rejected(report)).toEqual(["bad-a: GPL-3.0", "bad-b: GPL-3.0"]);
  });

  it("passes an empty report", () => {
    expect(rejected({})).toEqual([]);
  });
});
