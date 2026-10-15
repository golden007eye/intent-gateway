import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, version } from "./main.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("version", () => {
  it("is the package.json version", () => {
    expect(version()).toBe(pkg.version);
  });
});

describe("run", () => {
  it("prints the version for --version and exits 0", () => {
    expect(run(["--version"])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: "" });
  });

  it.each([[[]], [["serve"]], [["--version", "extra"]]])("rejects %j with usage and exit 2", (args) => {
    expect(run(args)).toEqual({ code: 2, stdout: "", stderr: "usage: intent --version\n" });
  });
});
