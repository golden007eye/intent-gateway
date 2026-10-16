import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Invariant 5, "claim only what was sent": docs, logs and CLI output say what the gateway sent and what Intent
// Cloud acknowledged receiving, never what Intent Cloud does afterwards. So every sentence that names Intent
// Cloud must use one of the verbs below, which describe what can be checked from the gateway's side. A sentence
// that needs another verb (one that says what Intent Cloud *is*, for example) is listed in docs/claims-allow.txt
// with the reason it makes no claim about what Intent Cloud does with the data.
const ROOT = join(import.meta.dirname, "..");
export const VERBS = ["receives", "received", "acknowledges", "acknowledged", "returns", "signs", "enforces", "reported"];
const ALLOW_FILE = join(ROOT, "docs", "claims-allow.txt");

/** The prose of a Markdown file as sentences: fenced code and HTML comments dropped, table cells split apart. */
export function markdownSentences(text: string): string[] {
  const prose = text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^---\n[\s\S]*?\n---\n/, "");
  const blocks = prose.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.|\||#{1,6}|!!!)\s)/);
  return blocks.flatMap((block) => block.split("|")).flatMap(splitSentences);
}

/** One block of text as sentences, whitespace collapsed. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;:])\s+(?=[A-Z`*"([])/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Every string a TypeScript file can print: string literals and the text parts of template literals. */
export function sourceStrings(code: string, fileName = "x.ts"): string[] {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("…"));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out.flatMap((s) => s.split(/\n\s*\n/)).flatMap(splitSentences);
}

// A mention right after one of these words names Intent Cloud as a place or a thing ("sent to Intent Cloud", "the
// demo Intent Cloud", "an Intent Cloud host"), not as the actor of a claim, so it does not need an allowed verb.
const REFERENCE = /\b(?:to|from|with|of|at|by|for|about|against|through|behind|into|on|the|an|a|demo|local|this|your)\s+$/i;

/** True when a sentence names Intent Cloud as an actor and uses none of the allowed verbs. */
export function breaksRule(sentence: string): boolean {
  // A bare label ("Intent Cloud" alone in a table cell) makes no claim.
  if (/^\W*Intent Cloud\W*$/.test(sentence)) return false;
  const actor = [...sentence.matchAll(/Intent Cloud/g)].some((m) => !REFERENCE.test(sentence.slice(0, m.index)));
  if (!actor) return false;
  return !VERBS.some((verb) => new RegExp(`\\b${verb}\\b`, "i").test(sentence));
}

export interface Allowed {
  path: string;
  fragment: string;
  reason: string;
  line: number;
}

/** docs/claims-allow.txt: `path | an exact fragment of the sentence | the reason`, `#` for comments. */
export function parseAllow(text: string): Allowed[] {
  return text.split("\n").flatMap((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return [];
    const parts = line.split(" | ");
    if (parts.length !== 3 || parts.some((p) => p.trim() === "")) {
      throw new Error(`claims-allow.txt line ${String(i + 1)}: expected "path | fragment | reason"`);
    }
    const [path = "", fragment = "", reason = ""] = parts.map((p) => p.trim());
    return [{ path, fragment, reason, line: i + 1 }];
  });
}

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && keep(e.name))
    .map((e) => join(e.parentPath, e.name));
}

/** The files the rule covers: README, every docs page, and every non-test source file the CLI can print from. */
export function coveredFiles(): string[] {
  const docs = walk(join(ROOT, "docs"), (n) => n.endsWith(".md"));
  const src = walk(join(ROOT, "src"), (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
  return [join(ROOT, "README.md"), ...docs, ...src].map((f) => relative(ROOT, f)).sort();
}

function sentencesOf(path: string): string[] {
  const text = readFileSync(join(ROOT, path), "utf8");
  return path.endsWith(".ts") ? sourceStrings(text, path) : markdownSentences(text);
}

describe("claims rule (invariant 5)", () => {
  it("flags a sentence about Intent Cloud with no allowed verb, and passes one with an allowed verb", () => {
    expect(breaksRule("Intent Cloud deletes your data after 30 days.")).toBe(true);
    expect(breaksRule("Intent Cloud never stores the ZIP.")).toBe(true);
    expect(breaksRule("Intent Cloud acknowledged receiving it.")).toBe(false);
    expect(breaksRule("The receipt Intent Cloud signs names the digest.")).toBe(false);
    expect(breaksRule("The gateway sends the ZIP.")).toBe(false);
  });

  it("treats a mention after a preposition or article as a reference, not a claim", () => {
    expect(breaksRule("Every field sent to Intent Cloud is logged first.")).toBe(false);
    expect(breaksRule("Run against the demo Intent Cloud.")).toBe(false);
    // A second, actor mention in the same sentence still needs an allowed verb.
    expect(breaksRule("The gateway sends it to Intent Cloud, and Intent Cloud forgets it.")).toBe(true);
    expect(breaksRule("Intent Cloud's servers delete it.")).toBe(true);
    expect(breaksRule("Intent Cloud")).toBe(false);
  });

  it("reads prose only: code blocks and comments are skipped, table cells are separate", () => {
    const md = "Intro.\n\n```console\n$ Intent Cloud stores this\n```\n\n<!-- Intent Cloud keeps it -->\n\n| a | Intent Cloud signs it |\n";
    expect(markdownSentences(md)).toEqual(["Intro.", "a", "Intent Cloud signs it"]);
  });

  it("reads every printable string in a source file, not its comments", () => {
    const code = '// Intent Cloud keeps it\nimport x from "Intent Cloud";\nconst a = "Intent Cloud stores it.";\nconst b = `sent ${a} to Intent Cloud`;\n';
    expect(sourceStrings(code)).toEqual(["Intent Cloud stores it.", "sent … to Intent Cloud"]);
  });

  it("covers the README, the docs and the CLI's source", () => {
    const files = coveredFiles();
    for (const f of ["README.md", "docs/threat-model.md", "docs/verify.md", "src/cli/help.ts", "src/verify/verify.ts"]) {
      expect(files).toContain(f);
    }
  });

  const allowed = parseAllow(readFileSync(ALLOW_FILE, "utf8"));
  const violations = coveredFiles().flatMap((path) =>
    sentencesOf(path)
      .filter(breaksRule)
      .map((sentence) => ({ path, sentence })),
  );
  const isAllowed = (v: { path: string; sentence: string }): boolean =>
    allowed.some((a) => a.path === v.path && v.sentence.includes(a.fragment));

  it(`every sentence naming Intent Cloud uses one of: ${VERBS.join(", ")}, or is in docs/claims-allow.txt`, () => {
    const bad = violations.filter((v) => !isAllowed(v)).map((v) => `${v.path}: ${v.sentence}`);
    expect(bad, "reword the sentence with an allowed verb, or add it to docs/claims-allow.txt with a reason").toEqual([]);
  });

  it("every claims-allow.txt entry still matches a sentence that needs it", () => {
    const stale = allowed
      .filter((a) => !violations.some((v) => v.path === a.path && v.sentence.includes(a.fragment)))
      .map((a) => `line ${String(a.line)}: ${a.path} | ${a.fragment}`);
    expect(stale, "remove entries that no longer match a sentence breaking the rule").toEqual([]);
  });
});
