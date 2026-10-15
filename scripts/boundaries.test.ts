// Proves the module rules bite: each rule in .dependency-cruiser.cjs and the network rules in eslint.config.js
// reject a deliberate violation under test/fixtures/, and the coverage floors fail a file below 95%.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cruise } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const fixture = join(repo, "test/fixtures/boundaries");

describe("dependency-cruiser rules", () => {
  let violations: { rule: string; from: string; to: string }[] = [];

  beforeAll(async () => {
    const options = await extractDepcruiseOptions(join(repo, ".dependency-cruiser.cjs"));
    const tsConfigFile = join(fixture, "tsconfig.json");
    const result = await cruise(
      ["src"],
      { ...options, baseDir: fixture, tsConfig: { fileName: tsConfigFile } },
      {},
      { tsConfig: extractTSConfig(tsConfigFile) },
    );
    if (typeof result.output === "string") throw new Error("expected a cruise result object");
    violations = result.output.summary.violations.map((v) => ({ rule: v.rule.name, from: v.from, to: v.to }));
  });

  it.each([
    ["module-internals", "src/verify/index.ts", "src/store/file.ts"],
    ["only-disclosure-reaches-cloud", "src/gateway/index.ts", "src/cloud/index.ts"],
    ["fake-only-in-tests", "src/gateway/uses-fake.ts", "src/cloud-fake/index.ts"],
    ["panel-offline", "src/panel/index.ts", "src/library/index.ts"],
  ])("%s rejects %s -> %s", (rule, from, to) => {
    expect(violations).toContainEqual({ rule, from, to });
  });

  it("flags nothing else: disclosure may reach cloud, and a test may load the fake", () => {
    expect(violations).toHaveLength(4);
  });
});

describe("eslint network rules", () => {
  let results: ESLint.LintResult[] = [];

  beforeAll(async () => {
    const eslint = new ESLint({ cwd: fixture, overrideConfigFile: join(repo, "eslint.config.js") });
    results = await eslint.lintFiles(["src/**/*.ts"]);
  }, 60_000);

  const ruleHits = (file: string, ruleId: string) =>
    results.filter((r) => r.filePath === join(fixture, file)).flatMap((r) => r.messages.filter((m) => m.ruleId === ruleId));

  it("parses every fixture file", () => {
    expect(results.flatMap((r) => r.messages.filter((m) => m.fatal === true))).toEqual([]);
  });

  it("rejects fetch outside library, supplychain and cloud-fake", () => {
    expect(ruleHits("src/gateway/uses-fetch.ts", "no-restricted-globals")).toHaveLength(1);
    expect(ruleHits("src/library/index.ts", "no-restricted-globals")).toEqual([]);
  });

  it("rejects node:https outside cloud, mcp, panel and cloud-fake", () => {
    expect(ruleHits("src/gateway/uses-https.ts", "no-restricted-imports")).toHaveLength(1);
    expect(ruleHits("src/cloud/index.ts", "no-restricted-imports")).toEqual([]);
  });
});

describe("coverage floors", () => {
  const runFixture = (filter: string) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_V8_COVERAGE"));
    const reports = mkdtempSync(join(tmpdir(), "coverage-floor-"));
    const args = ["run", "--root", "test/fixtures/floors", "--coverage", `--coverage.reportsDirectory=${reports}`, filter];
    try {
      execFileSync(join(repo, "node_modules/.bin/vitest"), args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" });
      return { code: 0, output: "" };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, output: e.stdout + e.stderr };
    }
  };

  it("passes a src/policy file at 100% lines", { timeout: 60_000 }, () => {
    expect(runFixture("full").code).toBe(0);
  });

  it("fails a src/policy file below 95% lines", { timeout: 60_000 }, () => {
    const { code, output } = runFixture("half");
    expect(code).not.toBe(0);
    expect(output).toMatch(/Coverage for lines .* does not meet .* threshold \(95%\) for .*src\/policy\/half\.ts/);
  });
});
