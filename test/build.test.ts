// The built package works: `pnpm build` emits the bundle (dist/main.js, which reports the version), build-info.json,
// THIRD_PARTY_LICENSES and the SBOM of the bundled packages; the packed tarball installs nothing else (ADR-0013).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoFirstRun } from "./build-demo.ts";

const repo = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string; bin: Record<string, string>; files: string[] };

describe("pnpm build", () => {
  it("emits dist/main.js that prints the version, and dist/build-info.json", { timeout: 60_000 }, () => {
    execFileSync("pnpm", ["build"], { cwd: repo, stdio: "pipe" });

    expect(execFileSync("node", [join(repo, "dist/main.js"), "--version"], { encoding: "utf8" })).toBe(`${pkg.version}\n`);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    // A checkout with local edits (a developer's) builds as dirty; CI builds a clean checkout and records HEAD.
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" }) !== "";
    if (process.env.CI !== undefined) expect(dirty).toBe(false);
    expect(JSON.parse(readFileSync(join(repo, "dist/build-info.json"), "utf8"))).toEqual(
      dirty ? { version: pkg.version, buildCommit: null, dirty: true } : { version: pkg.version, buildCommit: head, dirty: false },
    );
  });

  it("ships the bundle, and the contract files demo mode reads at run time", () => {
    const files = readdirSync(join(repo, "dist"), { recursive: true }).map(String);
    expect(files).toEqual(expect.arrayContaining(["main.js", "cli/index.js", "build-info.json", "THIRD_PARTY_LICENSES", "sbom.cdx.json"]));
    expect(files.filter((f) => /\.test\.|\.d\.ts$/.test(f))).toEqual([]);
    expect(pkg.files).toContain("dist");
    // The fake reads its test keys and the contract sums from the package's contract/ at run time.
    expect(pkg.files).toContain("contract");
  });

  it("lists every bundled package in THIRD_PARTY_LICENSES and in the SBOM, with the lockfile's hash", () => {
    const bom = JSON.parse(readFileSync(join(repo, "dist/sbom.cdx.json"), "utf8")) as {
      metadata: { component: { version: string } };
      components: { group?: string; name: string; version: string; hashes: { content: string }[] }[];
    };
    expect(bom.metadata.component.version).toBe(pkg.version);
    const names = bom.components.map((c) => `${c.group === undefined ? "" : `${c.group}/`}${c.name} ${c.version}`);
    expect(names).toEqual(expect.arrayContaining(["@sigstore/verify 4.1.2", "@modelcontextprotocol/sdk 1.32.1"]));
    const licences = readFileSync(join(repo, "dist/THIRD_PARTY_LICENSES"), "utf8");
    const listed = [...licences.matchAll(/^={80}\n(\S+ \S+)$/gm)].map((m) => m[1]);
    expect(listed).toEqual(names);
    expect(bom.components.every((c) => /^[0-9a-f]{128}$/.test(c.hashes[0]?.content ?? ""))).toBe(true);
  });

  it("runs the developer's first run from the build: intent demo → find → cart → Approve → approved → verify --demo", { timeout: 60_000 }, async () => {
    await demoFirstRun(join(repo, "dist/main.js"));
  });

  // The tarball is what npx runs and what the image copies (ADR-0005): the build, policies, contract and the onboarding
  // prompt with its policy-advisor skill (which the prompt copies from the package), no tests.
  it("packs a tarball with no test file, no test/support and no test-only server (npm pack --dry-run)", { timeout: 60_000 }, () => {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as {
      files: { path: string }[];
    }[];
    const files = (packed[0]?.files ?? []).map((f) => f.path);
    expect(files).toContain("dist/main.js");
    expect(files).toContain("dist/build-info.json");
    expect(files).toContain("dist/cli/index.js");
    expect(files).toContain("dist/THIRD_PARTY_LICENSES");
    expect(files).toContain("dist/sbom.cdx.json");
    expect(files.filter((f) => /(^|\/)(test|tests|__snapshots__)\/|\.test\.|fake-cloud-server|^src\/|^scripts\//.test(f))).toEqual([]);
    expect(files).toContain("onboarding/claude-code.md");
    expect(files).toContain("onboarding/skills/policy-advisor/SKILL.md");
    expect(files.every((f) => /^(dist|policies|contract|onboarding)\/|^(package\.json|LICENSE|NOTICE|README\.md)$/.test(f))).toBe(true);
  });

  // npx installs a package's dependencies, and npm warns EBADENGINE for each one on an unsupported Node; the bundle
  // carries them instead, so the tarball must name none (F-w).
  it("packs a package.json with no dependencies of any kind (npm pack)", { timeout: 60_000 }, () => {
    const out = mkdtempSync(join(tmpdir(), "pack-"));
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    ) as { filename: string }[];
    const tgz = join(out, packed[0]?.filename ?? "");
    const manifest = JSON.parse(execFileSync("tar", ["-xOzf", tgz, "package/package.json"], { encoding: "utf8" })) as Record<string, unknown>;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
      expect(manifest[field], field).toBeUndefined();
    }
    expect(manifest.engines).toEqual({ node: "^22.22.2 || ^24.15.0 || >=26.0.0" });
  });

  it("points both bin names at dist/main.js", () => {
    expect(pkg.bin).toEqual({ intent: "dist/main.js", "intent-gateway": "dist/main.js" });
  });
});
