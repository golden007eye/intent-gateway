import { describe, expect, it } from "vitest";
import { isAllowed, rejectedPackages } from "./licence-check.ts";

describe("isAllowed", () => {
  it.each(["MIT", "Apache-2.0", "(MIT OR GPL-3.0)", "MIT AND ISC", "Apache-2.0 WITH LLVM-exception", "(MIT AND GPL-3.0) OR Apache-2.0"])("allows %s", (expression) => {
    expect(isAllowed(expression)).toBe(true);
  });

  it.each(["GPL-3.0", "AGPL-3.0-only", "MIT AND GPL-2.0", "SSPL-1.0", "Unknown", "GPL-3.0 AND (MIT OR Apache-2.0)", "GPL-2.0 WITH Classpath-exception-2.0", "(MIT", "MIT OR", ""])("rejects %s", (expression) => {
    expect(isAllowed(expression)).toBe(false);
  });
});

describe("rejectedPackages", () => {
  const pkg = (name: string, license: string) => ({ name, version: "1.0.0", license, dir: `node_modules/${name}` });

  it("lists each bundled package under a disallowed licence, with its version", () => {
    expect(rejectedPackages([pkg("ok", "MIT"), pkg("bad-a", "GPL-3.0"), pkg("bad-b", "AGPL-3.0-only")])).toEqual(["bad-a@1.0.0: GPL-3.0", "bad-b@1.0.0: AGPL-3.0-only"]);
  });

  // Attack: a package whose package.json names no licence must not slip through as "nothing to check".
  it("rejects a bundled package that declares no licence", () => {
    expect(rejectedPackages([pkg("quiet", "UNKNOWN")])).toEqual(["quiet@1.0.0: UNKNOWN"]);
  });

  it("passes an empty bundle", () => {
    expect(rejectedPackages([])).toEqual([]);
  });
});
