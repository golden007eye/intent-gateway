import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { help } from "../src/cli/index.ts";
import { IMAGE_PIN_DOCS } from "./release.ts";

// The docs must not drift from the gateway: the threat model keeps its required sections and statements (AC-D4),
// and a feature is marked planned only while it does not exist (AC-D3). docs/feature-map.json lists the features
// that exist, each with the `intent` subcommand or the test file that proves it.
const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");

const THREAT_HEADINGS = [
  "## Assets",
  "## Trust boundaries",
  "## Invariant 1: the policy can only narrow",
  "## Invariant 2: log before send",
  "## Invariant 3: no buyer identity in the gateway",
  "## Invariant 4: one human approval per purchase",
  "## Invariant 5: claim only what was sent",
  "## HTTP transport and Docker",
  "## Phone hand-off and self-approval",
  "## Local panel",
  "## Supply chain",
  "## Known risks",
  "## Out of scope",
];

const THREAT_STATEMENTS = [
  "Payment by hand at the merchant is the backstop against self-approval.",
  "The TTY check raises the bar but is not a guarantee.",
  "The TLS fingerprint and the carrier-NAT tier are out of scope.",
  "One-tap spends without a hand at the merchant: the approver pin and the Shop budget are the backstop.",
];

const OUT_OF_SCOPE_ITEMS = ["**TLS fingerprint.**", "**Carrier-NAT tier sharing.**", "**Clean tail truncation.**"];

// The one-tap risks left open: each named in the Known risks section until it is closed.
const KNOWN_RISK_ITEMS = [
  "**The Shop token at rest.**",
  "**The legal status of the Shop route.**",
  "**Shop's personal-use terms.**",
  "**The store pair.**",
  "**Evidence-pack completeness.**",
];

/** The `intent` subcommands the CLI's help lists, such as "verify" or "policy add". */
export function helpCommands(help: string): string[] {
  const commands = help.split("Commands:\n")[1]?.split("\n\n")[0] ?? "";
  // A command is one or two words; the description starts after a run of spaces, arguments after one space and `<` or `[`.
  return [...commands.matchAll(/^\s+intent ([a-z]+(?: [a-z]+)?)(?= |$)/gm)].map((m) => m[1] ?? "");
}

/** Each `!!! planned` block and the feature id on the `<!-- feature: id -->` line right above it (null if none). */
export function plannedBlocks(markdown: string): { line: number; id: string | null }[] {
  const lines = markdown.split("\n");
  return lines.flatMap((text, i) => {
    if (!/^\s*!!! planned\b/.test(text)) return [];
    const id = /^\s*<!-- feature: ([a-z0-9-]+) -->\s*$/.exec(lines[i - 1] ?? "")?.[1] ?? null;
    return [{ line: i + 1, id }];
  });
}

interface Feature {
  command?: string;
  test?: string;
}

const featureMap = JSON.parse(readFileSync(join(DOCS, "feature-map.json"), "utf8")) as { features: Record<string, Feature> };
const pages = readdirSync(DOCS, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".md"))
  .map((name) => join(DOCS, name));

describe("docs/threat-model.md", () => {
  const text = readFileSync(join(DOCS, "threat-model.md"), "utf8");
  const headings = text.split("\n").filter((l) => l.startsWith("## "));

  it("has the required sections, in order, each once", () => {
    expect(headings).toEqual(THREAT_HEADINGS);
  });

  it.each(THREAT_STATEMENTS)("states: %s", (statement) => {
    expect(text).toContain(statement);
  });

  it("names the out-of-scope items in the Out of scope section", () => {
    const outOfScope = text.split("## Out of scope")[1] ?? "";
    for (const item of OUT_OF_SCOPE_ITEMS) expect(outOfScope).toContain(item);
    expect(outOfScope).toContain(THREAT_STATEMENTS[2]);
  });

  it("names the open one-tap risks in the Known risks section", () => {
    const known = text.split("## Known risks")[1]?.split("## Out of scope")[0] ?? "";
    for (const item of KNOWN_RISK_ITEMS) expect(known).toContain(item);
  });
});

describe("planned markers and docs/feature-map.json", () => {
  const commands = helpCommands(help());

  it("reads the subcommands from the CLI help", () => {
    expect(commands).toContain("verify");
    expect(commands).toContain("policy add");
    expect(commands).toContain("approver accept");
    expect(commands).not.toContain("approver accept at");
  });

  it("finds planned blocks and their feature ids", () => {
    const md = 'a\n<!-- feature: docker-image -->\n!!! planned "Docker"\n    text\n\n!!! planned "No id"\n';
    expect(plannedBlocks(md)).toEqual([
      { line: 3, id: "docker-image" },
      { line: 6, id: null },
    ]);
  });

  it.each(Object.entries(featureMap.features))("%s names an existing intent subcommand or test file", (_id, feature) => {
    const named = [feature.command, feature.test].filter((v) => v !== undefined);
    expect(named, "give exactly one of command or test").toHaveLength(1);
    if (feature.command !== undefined) {
      expect(commands, `intent --help does not list ${feature.command}`).toContain(feature.command.replace(/^intent /, ""));
    } else {
      expect(existsSync(join(ROOT, feature.test ?? "")), `${String(feature.test)} does not exist`).toBe(true);
    }
  });

  const blocks = pages.flatMap((page) => plannedBlocks(readFileSync(page, "utf8")).map((b) => ({ page: relative(ROOT, page), ...b })));

  it("every planned block names its feature", () => {
    const missing = blocks.filter((b) => b.id === null).map((b) => `${b.page}:${String(b.line)}`);
    expect(missing, "put <!-- feature: <id> --> on the line above each !!! planned").toEqual([]);
  });

  it("no planned block names a feature that exists", () => {
    const stale = blocks.filter((b) => b.id !== null && Object.hasOwn(featureMap.features, b.id)).map((b) => `${b.page}:${String(b.line)} ${String(b.id)}`);
    expect(stale, "the feature is in docs/feature-map.json: remove its planned marker").toEqual([]);
  });

  it("the README marks nothing planned that exists", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).not.toMatch(/\(planned\)/);
  });
});

describe("image pins", () => {
  // A doc that pins an older image tag tells users to pull an old release; `pnpm release` bumps these with package.json.
  const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  it.each(IMAGE_PIN_DOCS)("%s pins the image of the package.json version", (doc) => {
    const text = readFileSync(join(ROOT, doc), "utf8");
    const pins = [...text.matchAll(/ghcr\.io\/golden007eye\/intent-gateway:([^\s"'`)]+)/g)].map((m) => m[1]).filter((t) => t !== "latest");
    expect(pins.length).toBeGreaterThan(0);
    expect(pins).toEqual(pins.map(() => version));
  });
});
