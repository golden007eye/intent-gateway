// Strict YAML reading shared by policy and case files. Every YAML feature that can make one key mean two
// things (duplicate keys, `<<` merge keys) or make a small file expand (aliases) is refused before any value
// is read, because a policy that parses differently in two readers could hide a loosened rule.
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

export type PolicyErrorCode = "POLICY_LOOSENS" | "POLICY_INVALID";

/** A refused policy or case file. `path` names the offending key (dotted, `[i]` for list items). */
export class PolicyError extends Error {
  override readonly name = "PolicyError";
  readonly code: PolicyErrorCode;
  readonly path: string;
  constructor(code: PolicyErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.code = code;
    this.path = path;
  }
}

/** The path reported when the whole document is at fault rather than one key. */
export const DOCUMENT = "(document)";
export const MAX_ALIASES = 16;

export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${String(key)}]`;
  return base === "" ? key : `${base}.${key}`;
}

/**
 * Parses one YAML document under the YAML 1.2 core schema. Override tricks are POLICY_LOOSENS; syntax errors
 * are POLICY_INVALID.
 */
export function parseStrictYaml(text: string, maxBytes: number): unknown {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new PolicyError("POLICY_LOOSENS", DOCUMENT, `file is ${String(bytes)} bytes; the limit is ${String(maxBytes)}`);
  }
  const doc = parseDocument(text, { uniqueKeys: true, merge: false, schema: "core", strict: true, prettyErrors: false });
  let aliases = 0;
  const walk = (node: Node | null, path: string): void => {
    if (isAlias(node)) {
      aliases++;
      if (aliases > MAX_ALIASES) {
        throw new PolicyError("POLICY_LOOSENS", path, `more than ${String(MAX_ALIASES)} aliases`);
      }
    } else if (isMap(node)) {
      const seen = new Set<string>();
      for (const item of node.items) {
        const key = isScalar(item.key) ? String(item.key.value) : null;
        if (key === null) throw new PolicyError("POLICY_INVALID", path || DOCUMENT, "a key must be a plain value");
        const at = joinPath(path, key);
        if (key === "<<") throw new PolicyError("POLICY_LOOSENS", at, "merge keys are not allowed");
        if (seen.has(key)) throw new PolicyError("POLICY_LOOSENS", at, "duplicate key");
        seen.add(key);
        walk(item.value as Node | null, at);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        walk(item as Node | null, joinPath(path, i));
      });
    }
  };
  // The parser flags a duplicate key without its path; the walk finds it and reports it as an override.
  if (doc.errors.some((e) => e.code === "DUPLICATE_KEY")) walk(doc.contents, "");
  const syntax = doc.errors[0] ?? doc.warnings[0];
  if (syntax !== undefined) throw new PolicyError("POLICY_INVALID", DOCUMENT, `YAML: ${syntax.message}`);
  walk(doc.contents, "");
  try {
    return doc.toJS({ maxAliasCount: MAX_ALIASES }) as unknown;
  } catch (error) {
    // Reached only by alias expansion that the walk above did not already count (e.g. aliases of aliases).
    throw new PolicyError("POLICY_LOOSENS", DOCUMENT, `YAML: ${(error as Error).message}`);
  }
}
