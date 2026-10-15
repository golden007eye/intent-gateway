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
  ],
  options: { doNotFollow: { path: "node_modules" }, tsConfig: { fileName: "tsconfig.json" } },
};
