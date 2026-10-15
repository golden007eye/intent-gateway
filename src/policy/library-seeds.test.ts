// The 10 seed policies in policies/: each loads under the strict schema, passes every one of its cases, and
// matches the sha256 recorded in policies/index.json (which `intent policy add --commit` checks against).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPolicy, runCases } from "./index.ts";

const root = new URL("../../policies/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

const SEEDS = [
  "block-dropship",
  "daily-40",
  "gifts-under-30",
  "no-electronics",
  "no-history",
  "one-item",
  "per-order-60",
  "strict-default",
  "weekly-150",
  "zip-only",
];

const index = JSON.parse(read("index.json")) as { version: number; policies: Record<string, { sha256: string }> };

describe("seed policy library", () => {
  it("holds exactly the 10 seeds, each with policy.yaml, cases.yaml and README.md, all in the index", () => {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs.map((d) => d.name).sort()).toEqual(SEEDS);
    for (const name of SEEDS) expect(readdirSync(new URL(`${name}/`, root)).sort()).toEqual(["README.md", "cases.yaml", "policy.yaml"]);
    expect(index.version).toBe(1);
    expect(Object.keys(index.policies).sort()).toEqual(SEEDS);
  });

  describe.each(SEEDS)("%s", (name) => {
    const text = read(`${name}/policy.yaml`);

    it("loads and passes every case", () => {
      const results = runCases(loadPolicy(text), read(`${name}/cases.yaml`));
      expect(results.length).toBeGreaterThan(1);
      expect(results.filter((r) => !r.pass)).toEqual([]);
      expect(results.some((r) => r.expected.send) && results.some((r) => !r.expected.send)).toBe(true);
    });

    it("matches its index hash", () => {
      expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(index.policies[name]?.sha256);
    });
  });
});
