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
      comment: "Every send goes through the disclosure log (invariant 2), so only src/disclosure/ may use the cloud adapter.",
      severity: "error",
      from: { pathNot: "^src/(disclosure|cloud)/" },
      to: { path: "^src/cloud/" },
    },
    {
      name: "fake-only-in-tests",
      comment: "The fake Intent Cloud holds test keys; only tests may load it.",
      severity: "error",
      from: { pathNot: ["\\.test\\.ts$", "^test/", "^src/cloud-fake/"] },
      to: { path: "^src/cloud-fake/" },
    },
    {
      name: "panel-offline",
      comment: "The panel is a read-only local page; it reaches no network module.",
      severity: "error",
      from: { path: "^src/panel/" },
      to: { path: "^src/(cloud|cloud-fake|disclosure|library|supplychain)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^test/fixtures/" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
