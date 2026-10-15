import { describe, expect, test } from "vitest";
import { makeTarGz } from "../../test/support/fake-registry.ts";
import type { CheckFailure } from "./result.ts";
import { readTarGz } from "./tar.ts";

const refused = (reason: string) => expect.objectContaining({ reason }) as CheckFailure;

describe("readTarGz", () => {
  test("reads regular files under the top directory, including pax long names", () => {
    const long = `${"a/".repeat(60)}file.txt`;
    const files = readTarGz(makeTarGz({ "x.js": "1", [long]: "2" }));
    expect([...files.keys()]).toEqual(["x.js", long]);
    expect(files.get(long)?.toString()).toBe("2");
  });

  test("refuses path traversal and non-gzip input", () => {
    expect(() => readTarGz(makeTarGz({ "../escape.js": "x" }))).toThrow(refused("tarball-integrity-mismatch"));
    expect(() => readTarGz(Buffer.from("not gzip"))).toThrow(refused("tarball-integrity-mismatch"));
  });

  // Attack: each of these was once read as a plausible package path (e.g. `../dist/main.js` as `dist/main.js`).
  test.each([
    "../dist/main.js",
    "./dist/main.js",
    "other/dist/main.js",
    "/package/dist/main.js",
    "package",
    "package/",
    "package/./a.js",
    "package/../a.js",
    "package/a/../b.js",
    "package/a/./b.js",
    "package//a.js",
    "package/a/",
    "package/.",
    "package/..",
    `package/${"a/".repeat(60)}../x.js`,
  ])("refuses the unsafe path %j", (path) => {
    expect(() => readTarGz(makeTarGz({ [path]: "x" }, ""))).toThrow(refused("tarball-integrity-mismatch"));
  });

  test("reads a path written exactly as npm writes it", () => {
    expect([...readTarGz(makeTarGz({ "package/dist/main.js": "x" }, "")).keys()]).toEqual(["dist/main.js"]);
  });
});
