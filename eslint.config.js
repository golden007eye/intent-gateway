import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Network access is confined to the modules whose job it is (plan §3.2 "Rules"), so a send cannot bypass the
// disclosure log (invariant 2) by opening its own connection. .dependency-cruiser.cjs holds the same import rules
// as a second, resolver-based check; scripts/boundaries.test.ts proves each bypass below is rejected.
const networkMessage = "Only src/cloud, src/mcp, src/panel, src/cloud-fake, src/demo, src/storefront, src/wallet-shop and src/wallet-shop-fake open network connections.";
const fetchMessage = "fetch is allowed only in src/library, src/supplychain and src/cloud-fake.";
const escapeMessage = "src/ never runs other processes or code (child_process, vm, module, eval): it could send unlogged.";

// Built-in modules that open sockets or run code that can, and common npm HTTP clients.
const networkImport = "^(node:)?(http|https|http2|net|tls|dgram|dns|worker_threads|cluster|inspector)(/.*)?$|^(undici|ws|node-fetch|axios|got)(/.*)?$";
const escapeImport = "^(node:)?(child_process|vm|module)(/.*)?$";

// Globals that reach the network, or alias the global object so fetch could be read off it.
const srcGlobals = ["WebSocket", "EventSource", "XMLHttpRequest", "WebTransport", "global", "self", "window"].map((name) => ({
  name,
  message: `${name} is not used in src/: it reaches the network or aliases the global object.`,
}));
const srcProperties = [
  // process.getBuiltinModule("node:net") and the internal bindings load a module without an import.
  ...["getBuiltinModule", "binding", "_linkedBinding", "dlopen"].map((property) => ({ property, message: escapeMessage })),
  { property: "globalThis", message: "Use globalThis directly, never globalThis.globalThis." },
];
const srcSyntax = [
  { selector: "ImportExpression[source.type!='Literal']", message: "import() takes a string literal, so the module rules can see it." },
  { selector: "Identifier[name='createRequire']", message: escapeMessage },
  {
    // globalThis and process only as `globalThis.name`: no globalThis["fetch"], Reflect.get(globalThis, …),
    // destructuring or aliasing, any of which hides a property from the rules above.
    selector: "Identifier[name=/^(globalThis|process)$/]:not(MemberExpression[computed=false] > Identifier.object)",
    message: "Use globalThis and process only as `globalThis.name` / `process.name`, so the network rules can see the property.",
  },
];

export default tseslint.config(
  { ignores: ["node_modules/", "coverage/", "dist/", ".claude/", ".omc/", "test/fixtures/", "*.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  // All of src/. Each later block repeats these entries, because a later block replaces a rule's options.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-globals": ["error", ...srcGlobals],
      "no-restricted-properties": ["error", ...srcProperties],
      "no-restricted-syntax": ["error", ...srcSyntax],
      "no-restricted-imports": ["error", { patterns: [{ regex: escapeImport, message: escapeMessage }] }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/library/**", "src/supplychain/**", "src/cloud-fake/**"],
    rules: {
      "no-restricted-globals": ["error", ...srcGlobals, { name: "fetch", message: fetchMessage }],
      "no-restricted-properties": ["error", ...srcProperties, { object: "globalThis", property: "fetch", message: fetchMessage }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/cloud/**", "src/mcp/**", "src/panel/**", "src/cloud-fake/**", "src/demo/**", "src/storefront/**", "src/wallet-shop/**", "src/wallet-shop-fake/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: escapeImport, message: escapeMessage }, { regex: networkImport, message: networkMessage }] },
      ],
      "no-restricted-syntax": [
        "error",
        ...srcSyntax,
        // esquery regexes cannot contain a slash, so it is written as \x2f here.
        { selector: `ImportExpression[source.value=/${networkImport.replaceAll("/", "\\x2f")}/]`, message: networkMessage },
      ],
    },
  },
  { files: ["*.js"], ...tseslint.configs.disableTypeChecked },
);
