// Fails when a package compiled into the gateway's bundle carries a licence that is not compatible with Apache-2.0,
// because the gateway ships under Apache-2.0 (CLAUDE.md "Project conventions"). The runtime dependencies are bundled
// (ADR-0013), so the packages checked are the ones esbuild puts in dist/, read from its metafile, not package.json.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { bundle, type BundledPackage } from "./bundle.ts";

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

/** The bundled packages whose licence is not Apache-2.0 compatible, as `name@version: licence`. */
export function rejectedPackages(packages: readonly BundledPackage[]): string[] {
  return packages.filter((p) => !isAllowed(p.license)).map((p) => `${p.name}@${p.version}: ${p.license}`);
}

async function main(): Promise<void> {
  const repo = join(import.meta.dirname, "..");
  const { packages } = await bundle(repo, join(repo, "dist"), false);
  const bad = rejectedPackages(packages);
  for (const line of bad) console.error(`licence not allowed: ${line}`);
  if (bad.length > 0) process.exit(1);
  console.log(`licences: all ${String(packages.length)} bundled packages are Apache-2.0 compatible`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) await main();
