import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findHits, loadTerms, parseBatch, parseTerms } from "./public-safety.ts";

describe("parseTerms", () => {
  it("drops blanks and comments, lowercases, handles CRLF and collapses spaces", () => {
    expect(parseTerms("# list\r\n\r\n  Secret-Host \r\nacme   corp\n")).toEqual(["secret-host", "acme corp"]);
  });
});

describe("findHits", () => {
  const terms = ["secret-host", "codename"];

  it("reports path, 1-based line and 1-based term number", () => {
    const hits = findHits("a.md", Buffer.from("fine\nsee SECRET-HOST.example\n"), terms);
    expect(hits).toEqual([{ where: "a.md", line: 2, term: 1 }]);
  });

  it("finds several terms on one line", () => {
    expect(findHits("a.md", Buffer.from("codename on secret-host"), terms)).toHaveLength(2);
  });

  it("still scans files that contain NUL bytes", () => {
    expect(findHits("a.bin", Buffer.from([0x00, ...Buffer.from("codename")]), terms)).toHaveLength(1);
  });

  it("decodes UTF-16 text with a byte-order mark", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x codename", "utf16le")]);
    expect(findHits("a.txt", utf16, terms)).toEqual([{ where: "a.txt", line: 1, term: 2 }]);
  });

  it("finds a multi-word term split across lines or extra spaces", () => {
    expect(findHits("a.md", Buffer.from("acme\n  corp"), ["acme corp"])).toEqual([{ where: "a.md", line: "multi-line", term: 1 }]);
    expect(findHits("a.md", Buffer.from("acme    corp"), ["acme corp"])).toEqual([{ where: "a.md", line: 1, term: 1 }]);
  });

  it("flags a term in the path and redacts the path", () => {
    expect(findHits("docs/codename.md", Buffer.from("clean"), terms)).toEqual([{ where: "<path redacted>", line: "path", term: 2 }]);
  });

  it("returns nothing for a clean file", () => {
    expect(findHits("a.md", Buffer.from("public words only"), terms)).toEqual([]);
  });
});

describe("parseBatch", () => {
  it("splits git cat-file --batch output by object, keeping binary content", () => {
    const output = Buffer.concat([Buffer.from("aaa blob 3\nab\n\nbbb blob 2\n"), Buffer.from([0x00, 0x0a]), Buffer.from("\n")]);
    const objects = parseBatch(output);
    expect(objects.get("aaa")?.toString()).toBe("ab\n");
    expect(objects.get("bbb")).toEqual(Buffer.from([0x00, 0x0a]));
  });
});

describe("loadTerms", () => {
  const missing = join(tmpdir(), "no-such-private-terms");

  it("prefers the PRIVATE_TERMS variable", () => {
    expect(loadTerms({ PRIVATE_TERMS: "a\nb" }, missing)).toEqual(["a", "b"]);
  });

  it("falls back to the local file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "terms-")), "private-terms");
    writeFileSync(file, "# c\nlocal-term\n");
    expect(loadTerms({}, file)).toEqual(["local-term"]);
  });

  it("fails instead of passing when no terms are configured", () => {
    expect(() => loadTerms({}, missing)).toThrow(/no private terms/);
    expect(() => loadTerms({ PRIVATE_TERMS: "# only a comment\n" }, missing)).toThrow(/no private terms/);
  });
});
