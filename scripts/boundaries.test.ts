// Proves the module rules bite: each rule in .dependency-cruiser.cjs and the network rules in eslint.config.js reject
// a deliberate violation under test/fixtures/ (one fixture per known network bypass), and the coverage floors fail a
// file below 95%.
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
      ["src", "scripts"],
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
    // ADR-0014: a wallet adapter is reached only through the disclosure log, and its fake only from tests and the demo.
    ["only-disclosure-reaches-wallets", "src/gateway/uses-wallet.ts", "src/wallet-shop/index.ts"],
    ["wallet-fake-only-in-tests", "src/gateway/uses-wallet-fake.ts", "src/wallet-shop-fake/index.ts"],
    // ADR-0020: the storefront GET is reached only through the disclosure log, and its fake only from tests and the demo.
    ["only-disclosure-reaches-storefront", "src/gateway/uses-storefront.ts", "src/storefront/index.ts"],
    ["storefront-fake-only-in-tests", "src/gateway/uses-storefront-fake.ts", "src/storefront-fake/index.ts"],
    ["demo-only-from-cli", "src/gateway/uses-demo.ts", "src/demo/index.ts"],
    ["panel-offline", "src/panel/index.ts", "src/library/index.ts"],
    // Finding 12: panel -> relay -> disclosure -> cloud is caught, not only a direct import.
    ["panel-offline", "src/panel/transitive.ts", "src/disclosure/index.ts"],
    ["panel-offline", "src/panel/transitive.ts", "src/cloud/index.ts"],
    ["panel-offline", "src/panel/transitive.ts", "src/wallet-shop/index.ts"],
    ["panel-offline", "src/panel/transitive.ts", "src/storefront/index.ts"],
    ["network-only-in-network-modules", "src/gateway/uses-https.ts", "https"],
    ["network-only-in-network-modules", "src/gateway/uses-tls.ts", "tls"],
    ["network-only-in-network-modules", "src/gateway/uses-http2.ts", "http2"],
    ["network-only-in-network-modules", "src/gateway/uses-dgram.ts", "dgram"],
    ["network-only-in-network-modules", "src/gateway/uses-worker.ts", "worker_threads"],
    ["network-only-in-network-modules", "src/gateway/uses-dynamic-import.ts", "https"],
    ["no-process-escape-in-src", "src/gateway/uses-child-process.ts", "child_process"],
    ["no-process-escape-in-src", "src/gateway/uses-create-require.ts", "module"],
    ["no-process-escape-in-src", "src/cloud/spawns.ts", "child_process"],
  ])("%s rejects %s -> %s", (rule, from, to) => {
    expect(violations).toContainEqual({ rule, from, to });
  });

  it("flags nothing else: disclosure reaches cloud and the wallet, a test and the demo load the fakes, the CLI loads the demo, network modules and scripts/ connect", () => {
    expect(violations).toHaveLength(22);
  });
});

describe("eslint network rules", () => {
  let results: ESLint.LintResult[] = [];

  beforeAll(async () => {
    const eslint = new ESLint({ cwd: fixture, overrideConfigFile: join(repo, "eslint.config.js") });
    results = await eslint.lintFiles(["src/**/*.ts", "scripts/**/*.ts"]);
  }, 60_000);

  const networkRules = new Set([
    "no-restricted-globals",
    "no-restricted-properties",
    "no-restricted-syntax",
    "no-restricted-imports",
    "no-eval",
    "no-new-func",
  ]);
  const ruleHits = (file: string) =>
    results
      .filter((r) => r.filePath === join(fixture, file))
      .flatMap((r) => r.messages.filter((m) => m.ruleId !== null && networkRules.has(m.ruleId)).map((m) => m.ruleId));

  it("parses every fixture file", () => {
    expect(results.flatMap((r) => r.messages.filter((m) => m.fatal === true))).toEqual([]);
  });

  it.each([
    ["src/gateway/uses-fetch.ts", "no-restricted-globals"],
    ["src/gateway/uses-https.ts", "no-restricted-imports"],
    ["src/gateway/uses-tls.ts", "no-restricted-imports"],
    ["src/gateway/uses-http2.ts", "no-restricted-imports"],
    ["src/gateway/uses-dgram.ts", "no-restricted-imports"],
    ["src/gateway/uses-worker.ts", "no-restricted-imports"],
    ["src/gateway/uses-child-process.ts", "no-restricted-imports"],
    ["src/cloud/spawns.ts", "no-restricted-imports"],
    ["src/gateway/uses-dynamic-import.ts", "no-restricted-syntax"],
    ["src/gateway/uses-computed-import.ts", "no-restricted-syntax"],
    ["src/gateway/uses-create-require.ts", "no-restricted-imports"],
    ["src/gateway/uses-create-require.ts", "no-restricted-syntax"],
    ["src/gateway/uses-builtin-module.ts", "no-restricted-properties"],
    ["src/gateway/uses-global-index.ts", "no-restricted-syntax"],
    ["src/gateway/uses-global-alias.ts", "no-restricted-globals"],
    ["src/gateway/uses-self.ts", "no-restricted-globals"],
    ["src/gateway/uses-reflect.ts", "no-restricted-syntax"],
    ["src/gateway/uses-websocket.ts", "no-restricted-globals"],
    ["src/gateway/uses-eventsource.ts", "no-restricted-globals"],
    ["src/gateway/uses-eval.ts", "no-eval"],
    ["src/gateway/uses-eval.ts", "no-new-func"],
  ])("rejects %s with %s", (file, ruleId) => {
    expect(ruleHits(file)).toContain(ruleId);
  });

  it.each([
    "src/library/index.ts", // fetch
    "src/cloud/index.ts", // node:https
    "src/cloud/sockets.ts", // node:tls and a literal import("node:https")
    "src/mcp/index.ts", // node:net
    "src/cloud-fake/index.ts", // node:http and fetch
    "src/demo/index.ts", // node:http
    "src/wallet-shop/index.ts", // node:https
    "src/wallet-shop-fake/index.ts", // node:http
    "src/storefront/index.ts", // node:tls
    "scripts/runs.ts", // node:child_process
  ])("allows %s", (file) => {
    expect(ruleHits(file)).toEqual([]);
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
