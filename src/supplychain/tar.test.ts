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
});
