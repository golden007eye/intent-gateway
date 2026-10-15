import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every decision record carries the same three sections, so a reader (or an agent) finds the reason,
// the rule and the cost in the same place in each one.
const adrDir = join(import.meta.dirname, "..", "docs", "adr");
const required = ["## Context", "## Decision", "## Consequences"];
const adrs = readdirSync(adrDir).filter((name) => name.endsWith(".md"));

describe("docs/adr", () => {
  it("holds the decision records", () => {
    expect(adrs.length).toBeGreaterThanOrEqual(11);
  });

  it.each(adrs)("%s has Context, Decision and Consequences, in that order", (name) => {
    const lines = readFileSync(join(adrDir, name), "utf8").split("\n");
    const found = required.map((heading) => lines.indexOf(heading));
    expect(found.every((index) => index >= 0), `missing one of ${required.join(", ")}`).toBe(true);
    expect([...found].sort((a, b) => a - b)).toEqual(found);
  });
});
