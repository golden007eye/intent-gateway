// contract/ holds the Intent Cloud public contract byte for byte. These checks fail if a vendored file is edited,
// added or dropped, or if SOURCE.md stops describing the copy (version, sums hash, no private URL).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repo = join(import.meta.dirname, "..", "..");
const dir = join(repo, "contract");
const PUBLIC_HOST = "https://staging-api.intentai.shop";
// Files that describe the copy rather than belong to the contract's listed set (R3-4).
const UNLISTED = new Set(["LICENSE", "SOURCE.md", "SHA256SUMS"]);

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Parses `sha256sum` output: "<64 hex>  <path>" per line, paths relative to the file's own directory. */
function parseSums(text: string): Map<string, string> {
  if (!text.endsWith("\n")) throw new Error("SHA256SUMS must end with a newline");
  const sums = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9._/-]+)$/.exec(line);
    if (m === null) throw new Error(`bad SHA256SUMS line: ${JSON.stringify(line)}`);
    const [, hash, path] = m as unknown as [string, string, string];
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`path escapes the directory: ${path}`);
    if (sums.has(path)) throw new Error(`duplicate path: ${path}`);
    sums.set(path, hash);
  }
  return sums;
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !UNLISTED.has(p))
    .sort();
}

interface Source {
  version: string;
  sumsSha256: string;
}
function parseSource(text: string): Source {
  const version = /^- Version: (\d+\.\d+\.\d+)$/m.exec(text)?.[1];
  const sumsSha256 = /^- sha256 of `SHA256SUMS`: `([0-9a-f]{64})`$/m.exec(text)?.[1];
  if (version === undefined || sumsSha256 === undefined) throw new Error("SOURCE.md lacks the version or the sums hash");
  return { version, sumsSha256 };
}

/** Every URL-like token in a text, so a private host or repo link cannot hide behind another scheme. */
const urls = (text: string): string[] =>
  [...text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>()`'",;]*/gi)].map((m) => m[0].replace(/[.:]+$/, ""));

const sumsText = readFileSync(join(dir, "SHA256SUMS"), "utf8");
const sourceText = readFileSync(join(dir, "SOURCE.md"), "utf8");

describe("vendored contract", () => {
  const sums = parseSums(sumsText);

  it.each([...sums])("%s matches its SHA256SUMS hash", (path, hash) => {
    expect(sha256(readFileSync(join(dir, path)))).toBe(hash);
  });

  it("lists exactly the files present, apart from LICENSE, SOURCE.md and SHA256SUMS", () => {
    expect([...sums.keys()].sort()).toEqual(listFiles(dir));
  });

  it("lists the spec, the appendices and the vectors", () => {
    expect([...sums.keys()]).toEqual(expect.arrayContaining(["gateway-api.v1.yaml", "vectors/a1-snapshot.json", "vectors/b1-ledger.json"]));
  });

  it("ships the Apache-2.0 licence of the contract", () => {
    expect(readFileSync(join(dir, "LICENSE"), "utf8")).toMatch(/Apache License\s+Version 2\.0/);
  });

  it("records sha256(SHA256SUMS) in SOURCE.md", () => {
    expect(parseSource(sourceText).sumsSha256).toBe(sha256(readFileSync(join(dir, "SHA256SUMS"))));
  });

  it("records the spec's info.version in SOURCE.md", () => {
    const spec = parse(readFileSync(join(dir, "gateway-api.v1.yaml"), "utf8")) as { info: { version: string } };
    expect(parseSource(sourceText).version).toBe(spec.info.version);
  });

  it("names no URL in SOURCE.md other than the public host", () => {
    expect(urls(sourceText).filter((u) => u !== PUBLIC_HOST)).toEqual([]);
  });

  it("is shipped in the npm package", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("contract");
  });
});

// Attack cases: the checks above must catch a tampered copy, not merely pass on the real one.
describe("vendored-contract checks reject a tampered copy", () => {
  const sums = parseSums(sumsText);

  it("a file edited by one byte no longer matches its listed hash", () => {
    const spec = readFileSync(join(dir, "gateway-api.v1.yaml"));
    const edited = Buffer.concat([spec, Buffer.from(" ")]);
    expect(sha256(edited)).not.toBe(sums.get("gateway-api.v1.yaml"));
  });

  it("an edited SHA256SUMS no longer matches SOURCE.md", () => {
    expect(sha256(sumsText.replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0")))).not.toBe(parseSource(sourceText).sumsSha256);
  });

  it.each([
    ["an absolute path", `${"0".repeat(64)}  /etc/passwd\n`],
    ["a parent path", `${"0".repeat(64)}  ../x.json\n`],
    ["a duplicate path", `${"0".repeat(64)}  a.json\n${"1".repeat(64)}  a.json\n`],
    ["a binary-mode marker", `${"0".repeat(64)} *a.json\n`],
    ["an uppercase hash", `${"A".repeat(64)}  a.json\n`],
    ["no trailing newline", `${"0".repeat(64)}  a.json`],
  ])("SHA256SUMS with %s is refused", (_name, text) => {
    expect(() => parseSums(text)).toThrow();
  });

  it.each([
    ["a private repo link", "see https://github.example/org/repo"],
    ["a plain-http host", "http://staging-api.intentai.shop"],
    ["a look-alike host", "https://staging-api.intentai.shop.example"],
    ["a git URL", "git+ssh://git.example/repo.git"],
  ])("SOURCE.md with %s is flagged", (_name, line) => {
    expect(urls(`${sourceText}\n${line}\n`).filter((u) => u !== PUBLIC_HOST)).not.toEqual([]);
  });

  it("SOURCE.md without the sums hash is refused", () => {
    expect(() => parseSource(sourceText.replace(/^- sha256 of .*$/m, ""))).toThrow();
  });
});
