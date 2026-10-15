// Fails when a runtime (production) dependency carries a licence that is not compatible with
// Apache-2.0, because the gateway ships under Apache-2.0 (CLAUDE.md "Project conventions").
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

// Permissive licences an Apache-2.0 work may depend on and redistribute.
export const ALLOWED = new Set([
  "Apache-2.0",
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);

// SPDX expression grammar: or := and ("OR" and)* ; and := atom ("AND" atom)* ; atom := "(" or ")" | id ["WITH" exception].
// An exception (e.g. LLVM-exception) only grants extra permissions, so "X WITH E" is judged as X.
// OR is allowed when any branch is; AND only when every part is; anything unparseable is rejected.
export function isAllowed(expression: string): boolean {
  const tokens = expression.replace(/[()]/g, " $& ").trim().split(/\s+/);
  let pos = 0;
  const parseOr = (): boolean => {
    let ok = parseAnd();
    while (tokens[pos] === "OR") {
      pos++;
      ok = parseAnd() || ok;
    }
    return ok;
  };
  const parseAnd = (): boolean => {
    let ok = parseAtom();
    while (tokens[pos] === "AND") {
      pos++;
      ok = parseAtom() && ok;
    }
    return ok;
  };
  const parseAtom = (): boolean => {
    const token = tokens[pos++];
    if (token === "(") {
      const ok = parseOr();
      if (tokens[pos++] !== ")") throw new Error("unbalanced");
      return ok;
    }
    if (token === undefined || ["OR", "AND", "WITH", ")"].includes(token)) throw new Error("unexpected token");
    if (tokens[pos] === "WITH") pos += 2;
    return ALLOWED.has(token);
  };
  try {
    const ok = parseOr();
    return ok && pos === tokens.length;
  } catch {
    return false;
  }
}

// Input is `pnpm licenses list --prod --json`: { "<licence>": [{ name, versions }] }.
export function rejected(report: Record<string, { name: string }[]>): string[] {
  return Object.entries(report)
    .filter(([licence]) => !isAllowed(licence))
    .flatMap(([licence, packages]) => packages.map((p) => `${p.name}: ${licence}`));
}

function main(): void {
  const json = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { encoding: "utf8" });
  const bad = rejected(JSON.parse(json) as Record<string, { name: string }[]>);
  for (const line of bad) console.error(`licence not allowed: ${line}`);
  if (bad.length > 0) process.exit(1);
  console.log("licences: all runtime dependencies are Apache-2.0 compatible");
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) main();
