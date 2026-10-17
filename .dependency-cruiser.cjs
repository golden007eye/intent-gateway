/** Module boundaries (CLAUDE.md "Project conventions"): a module under src/ is reached only through its index.ts. */
module.exports = {
  forbidden: [
    {
      name: "module-internals",
      comment: "Import another module through its index.ts, never its internal files.",
      severity: "error",
      from: { path: "^src/([^/]+)/" },
      to: { path: "^src/([^/]+)/(?!index\\.ts$)", pathNot: "^src/$1/" },
    },
    {
      name: "module-internals-from-outside",
      comment: "Files outside a module (src/*.ts, tests, scripts) also go through index.ts.",
      severity: "error",
      from: { path: "^(src/[^/]+\\.ts$|test/|tests/|scripts/)" },
      to: { path: "^src/[^/]+/(?!index\\.ts$)" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-src-to-scripts",
      comment: "Repo tooling is not part of the gateway.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^scripts/" },
    },
    {
      name: "only-disclosure-reaches-cloud",
      comment:
        "Every send goes through the disclosure log (invariant 2), so only src/disclosure/ may use the cloud adapter. " +
        "The contract suite (test/contract/) drives the adapter directly to check the wire contract itself.",
      severity: "error",
      from: { pathNot: ["^src/(disclosure|cloud)/", "^test/contract/"] },
      to: { path: "^src/cloud/" },
    },
    {
      name: "only-disclosure-reaches-wallets",
      comment:
        "Every send to a wallet destination goes through the disclosure log too (invariant 2, ADR-0014), so only " +
        "src/disclosure/ may use a wallet adapter. The contract suite (test/contract/) may drive it directly.",
      severity: "error",
      from: { pathNot: ["^src/(disclosure|wallet-shop)/", "^test/contract/"] },
      to: { path: "^src/wallet-shop/" },
    },
    {
      name: "wallet-fake-only-in-tests",
      comment: "The fake Shop wallet holds test accounts; only tests and demo mode (src/demo) may load it.",
      severity: "error",
      from: { pathNot: ["\\.test\\.ts$", "^test/", "^src/wallet-shop-fake/", "^src/demo/"] },
      to: { path: "^src/wallet-shop-fake/" },
    },
    {
      name: "fake-only-in-tests",
      comment: "The fake Intent Cloud holds test keys; only tests and demo mode (src/demo) may load it.",
      severity: "error",
      from: { pathNot: ["\\.test\\.ts$", "^test/", "^src/cloud-fake/", "^src/demo/"] },
      to: { path: "^src/cloud-fake/" },
    },
    {
      name: "demo-only-from-cli",
      comment: "Demo mode runs the test-key fake; only the CLI's demo command and --demo flag (and tests) may start it.",
      severity: "error",
      from: { pathNot: ["\\.test\\.ts$", "^test/", "^src/demo/", "^src/cli/"] },
      to: { path: "^src/demo/" },
    },
    {
      name: "panel-offline",
      comment: "The panel is a read-only local page; it reaches no network module.",
      severity: "error",
      from: { path: "^src/panel/" },
      to: { path: "^src/(cloud|cloud-fake|demo|disclosure|library|supplychain|wallet-shop|wallet-shop-fake)/", reachable: true },
    },
    {
      name: "network-only-in-network-modules",
      comment: "A send must go through the disclosure log (invariant 2), so only these modules open connections (plan §3.2).",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/(cloud|mcp|panel|cloud-fake|demo|wallet-shop|wallet-shop-fake)/" },
      to: {
        dependencyTypes: ["core"],
        path: "^(node:)?(http|https|http2|net|tls|dgram|dns|worker_threads|cluster|inspector)(/promises)?$",
      },
    },
    {
      name: "no-process-escape-in-src",
      comment: "src/ never runs another process or loads code around the module rules; scripts/ may.",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["core"], path: "^(node:)?(child_process|vm|module)$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^test/fixtures/" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
