import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Network access is confined to the modules whose job it is (plan §3.2 "Rules"), so a send cannot bypass the
// disclosure log by opening its own connection.
const networkModules = ["node:http", "node:https", "node:net", "http", "https", "net"].map((name) => ({
  name,
  message: "Only src/cloud, src/mcp, src/panel and src/cloud-fake open network connections.",
}));
const fetchMessage = "fetch is allowed only in src/library, src/supplychain and src/cloud-fake.";

export default tseslint.config(
  { ignores: ["node_modules/", "coverage/", "dist/", ".claude/", ".omc/", "test/fixtures/", "*.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  {
    ignores: ["src/library/**", "src/supplychain/**", "src/cloud-fake/**"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: fetchMessage }],
      "no-restricted-properties": ["error", { object: "globalThis", property: "fetch", message: fetchMessage }],
    },
  },
  {
    ignores: ["src/cloud/**", "src/mcp/**", "src/panel/**", "src/cloud-fake/**"],
    rules: { "no-restricted-imports": ["error", { paths: networkModules }] },
  },
  { files: ["*.js"], ...tseslint.configs.disableTypeChecked },
);
