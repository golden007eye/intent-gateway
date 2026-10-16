// The bundle (ADR-0013): what esbuild puts where, the early Node check, the licences and the SBOM of the bundled code.
import { builtinModules } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bundle, bundledPackages, ENTRY_POINTS, lockfileHashes, sbom, thirdPartyLicenses, type BundledPackage } from "./bundle.ts";
import { rejectedPackages } from "./licence-check.ts";

const repo = join(import.meta.dirname, "..");

function fakeRepo(packages: Record<string, object>, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-test-"));
  for (const [path, manifest] of Object.entries(packages)) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, "package.json"), JSON.stringify(manifest));
  }
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  return dir;
}

describe("bundledPackages", () => {
  it("names each package folder the inputs come from, once, scoped names included, sorted", () => {
    const dir = fakeRepo({
      "node_modules/.pnpm/zod@4.6.5/node_modules/zod": { name: "zod", version: "4.6.5", license: "MIT" },
      "node_modules/.pnpm/@sigstore+core@4.0.1/node_modules/@sigstore/core": { name: "@sigstore/core", version: "4.0.1", license: "Apache-2.0", repository: { url: "git+https://example.invalid/core.git" } },
    });
    const inputs = [
      "src/main.ts",
      "node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js",
      "node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/classic/schemas.js",
      "node_modules/.pnpm/@sigstore+core@4.0.1/node_modules/@sigstore/core/dist/index.js",
    ];
    expect(bundledPackages(dir, inputs)).toEqual([
      { name: "@sigstore/core", version: "4.0.1", license: "Apache-2.0", dir: "node_modules/.pnpm/@sigstore+core@4.0.1/node_modules/@sigstore/core", repository: "git+https://example.invalid/core.git" },
      { name: "zod", version: "4.6.5", license: "MIT", dir: "node_modules/.pnpm/zod@4.6.5/node_modules/zod" },
    ]);
  });

  it("takes the innermost node_modules folder, the package the file belongs to", () => {
    const dir = fakeRepo({ "node_modules/a/node_modules/b": { name: "b", version: "1.0.0", license: "ISC" } });
    expect(bundledPackages(dir, ["node_modules/a/node_modules/b/index.js"]).map((p) => p.name)).toEqual(["b"]);
  });

  // Attack: a package with no `license` must be checked as UNKNOWN (and refused), not skipped.
  it("reads the old `licenses` array, and records a package with no licence as UNKNOWN", () => {
    const dir = fakeRepo({
      "node_modules/old": { name: "old", version: "1.0.0", licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] },
      "node_modules/none": { name: "none", version: "1.0.0" },
    });
    const packages = bundledPackages(dir, ["node_modules/old/i.js", "node_modules/none/i.js"]);
    expect(packages.map((p) => [p.name, p.license])).toEqual([
      ["none", "UNKNOWN"],
      ["old", "(MIT OR Apache-2.0)"],
    ]);
    expect(rejectedPackages(packages)).toEqual(["none@1.0.0: UNKNOWN"]);
  });
});

describe("thirdPartyLicenses", () => {
  it("carries each package's licence and notice files in full, and says when a package ships none", () => {
    const dir = fakeRepo(
      {
        "node_modules/a": { name: "a", version: "1.0.0", license: "Apache-2.0" },
        "node_modules/b": { name: "b", version: "2.0.0", license: "MIT", author: "B Author" },
      },
      { "node_modules/a/LICENSE": "Apache text\n", "node_modules/a/NOTICE": "A notice\n", "node_modules/a/README.md": "not a licence" },
    );
    const text = thirdPartyLicenses(dir, "9.9.9", bundledPackages(dir, ["node_modules/a/i.js", "node_modules/b/i.js"]));
    expect(text).toContain("intent-gateway 9.9.9 bundles");
    expect(text).toContain("a 1.0.0\nLicense: Apache-2.0\n\n--- LICENSE ---\nApache text\n\n--- NOTICE ---\nA notice\n");
    expect(text).not.toContain("not a licence");
    expect(text).toContain("b 2.0.0\nLicense: MIT\n\nThe package ships no licence file. Its package.json declares MIT and names its author, B Author.");
    expect(text).toContain("Copyright (c) B Author\n\nPermission is hereby granted");
  });
});

describe("lockfileHashes", () => {
  it("reads the integrity of every package in every YAML document pnpm writes, as hex SHA-512", () => {
    const sha = Buffer.alloc(64, 7);
    const lock = [
      "---",
      "lockfileVersion: '9.0'",
      "packages:",
      "  node@runtime:24.15.0:",
      "    resolution: {type: variations, variants: []}",
      "---",
      "lockfileVersion: '9.0'",
      "packages:",
      "  '@scope/x@1.0.0':",
      `    resolution: {integrity: sha512-${sha.toString("base64")}}`,
      "  y@2.0.0:",
      "    resolution: {integrity: sha1-AAAA}",
      "",
    ].join("\n");
    expect([...lockfileHashes(lock)]).toEqual([["@scope/x@1.0.0", sha.toString("hex")]]);
  });
});

describe("sbom", () => {
  const packages: BundledPackage[] = [
    { name: "@scope/x", version: "1.0.0", license: "MIT", dir: "node_modules/@scope/x" },
    { name: "y", version: "2.0.0", license: "ISC", dir: "node_modules/y" },
  ];
  const hashes = new Map([
    ["@scope/x@1.0.0", "aa"],
    ["y@2.0.0", "bb"],
  ]);

  it("is CycloneDX 1.6 with the gateway as subject and each bundled package as a component with its lockfile hash", () => {
    const bom = JSON.parse(sbom("1.2.3", packages, hashes)) as Record<string, unknown> & { components: Record<string, unknown>[]; metadata: { component: { purl: string } } };
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.6");
    expect(bom.metadata.component.purl).toBe("pkg:npm/intent-gateway@1.2.3");
    expect(bom.components).toEqual([
      expect.objectContaining({ group: "@scope", name: "x", version: "1.0.0", purl: "pkg:npm/%40scope/x@1.0.0", hashes: [{ alg: "SHA-512", content: "aa" }], licenses: [{ expression: "MIT" }] }),
      expect.objectContaining({ name: "y", version: "2.0.0", purl: "pkg:npm/y@2.0.0", hashes: [{ alg: "SHA-512", content: "bb" }] }),
    ]);
    // No timestamp and no serial number: one commit always writes the same SBOM (the image is reproducible).
    expect(sbom("1.2.3", packages, hashes)).toBe(sbom("1.2.3", packages, hashes));
    expect(JSON.stringify(bom)).not.toMatch(/timestamp|serialNumber/);
  });

  // A component the lockfile does not pin cannot be described honestly, so the build stops.
  it("refuses a bundled package the lockfile has no hash for", () => {
    expect(() => sbom("1.2.3", packages, new Map([["y@2.0.0", "bb"]]))).toThrow("pnpm-lock.yaml has no integrity for bundled @scope/x@1.0.0");
  });
});

describe("the gateway's bundle", () => {
  let result: Awaited<ReturnType<typeof bundle>>;
  const outputs = (): [string, { inputs: Record<string, unknown>; imports: { path: string; kind: string; external?: boolean }[] }][] =>
    Object.entries(result.result.metafile.outputs).map(([path, out]) => [path.replace(/^.*?dist\//, ""), out]);

  beforeAll(async () => {
    result = await bundle(repo, join(repo, "dist"), false);
  }, 60_000);

  it("has the entry points src/main.ts and src/cli/index.ts", () => {
    expect(ENTRY_POINTS).toEqual(["src/main.ts", "src/cli/index.ts"]);
    expect(outputs().map(([p]) => p)).toEqual(expect.arrayContaining(["main.js", "cli/index.js"]));
  });

  // The Node check must run before any dependency code is even parsed (ADR-0012, ADR-0013): what dist/main.js
  // loads statically is src/main.ts and src/runtime only; everything else arrives by its dynamic import.
  it("loads only src/main.ts and src/runtime before the Node check", () => {
    const byPath = new Map(outputs());
    const seen = new Set<string>();
    const visit = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      for (const imp of byPath.get(path)?.imports ?? []) {
        if (imp.kind === "import-statement" && imp.external !== true) visit(imp.path.replace(/^.*?dist\//, ""));
      }
    };
    visit("main.js");
    const inputs = [...seen].flatMap((p) => Object.keys(byPath.get(p)?.inputs ?? {}));
    expect(inputs.sort()).toEqual(["src/main.ts", "src/runtime/index.ts"]);
    const lazy = byPath.get("main.js")?.imports.filter((i) => i.kind === "dynamic-import").map((i) => i.path);
    expect(lazy).toEqual(["dist/cli/index.js"]);
  });

  // Gateway code finds policies/, contract/ and build-info.json at `../../` and `../` from its own file, as from
  // src/<module>/<file>.ts; only dist/main.js, which uses neither, may sit elsewhere.
  it("puts every output but dist/main.js two levels below the package root", () => {
    const misplaced = outputs()
      .map(([p]) => p)
      .filter((p) => p !== "main.js" && p.split("/").length !== 2);
    expect(misplaced).toEqual([]);
  });

  it("leaves no import for Node to resolve but Node's own modules", () => {
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const external = outputs().flatMap(([, out]) => out.imports.filter((i) => i.external === true).map((i) => i.path));
    expect(external.filter((p) => !builtins.has(p))).toEqual([]);
  });

  it("holds demo mode (src/demo and the fake it runs) and no test file", () => {
    const inputs = Object.keys(result.result.metafile.inputs);
    expect(inputs).toEqual(expect.arrayContaining(["src/demo/index.ts", "src/cloud-fake/index.ts"]));
    expect(inputs.filter((i) => /\.test\.ts$|^test\/|__snapshots__/.test(i))).toEqual([]);
  });

  it("compiles in the runtime dependencies, all under Apache-2.0 compatible licences", () => {
    const names = result.packages.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["@modelcontextprotocol/sdk", "@sigstore/bundle", "@sigstore/tuf", "@sigstore/verify", "qrcode-generator", "yaml", "zod"]));
    expect(rejectedPackages(result.packages)).toEqual([]);
  });
});
