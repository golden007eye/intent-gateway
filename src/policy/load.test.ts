// Invariant 1 (the policy can only narrow): every attempt to loosen Intent Cloud's baseline is refused at load
// time with POLICY_LOOSENS and the path of the offending key.
import { describe, expect, it } from "vitest";
import { CLOUD_BASELINE, EXCLUDED_CATEGORIES, PolicyError, loadPolicy } from "./index.ts";

const base = "version: 1\napproval: passkey\n";

function refusal(text: string): PolicyError {
  try {
    loadPolicy(text);
  } catch (error) {
    if (error instanceof PolicyError) return error;
    throw error;
  }
  throw new Error("policy loaded but should have been refused");
}

describe("loadPolicy: invariant-1 attack list", () => {
  const aliasBomb = [
    "version: 1",
    "approval: passkey",
    "a: &a [x, x, x, x, x, x, x, x, x]",
    "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
    "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
    "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
  ].join("\n");

  const attacks: [string, string, string][] = [
    ["approval: off", "version: 1\napproval: off\n", "approval"],
    ["approval: none", "version: 1\napproval: none\n", "approval"],
    ["approval: false", "version: 1\napproval: false\n", "approval"],
    ["approval with a trailing space", 'version: 1\napproval: "passkey "\n', "approval"],
    ["approval missing", "version: 1\n", "approval"],
    ["a duplicate approval key", "version: 1\napproval: passkey\napproval: off\n", "approval"],
    ["a duplicate quoted key", 'version: 1\napproval: passkey\n"approval": off\n', "approval"],
    [
      "a << merge override",
      "version: 1\napproval: passkey\nquantity:\n  <<: {max: 9}\n  max: 1\n",
      "quantity.<<",
    ],
    ["an unknown approval_required key", `${base}approval_required: false\n`, "approval_required"],
    ["quantity.max: 4", `${base}quantity:\n  max: 4\n`, "quantity.max"],
    ["quantity.max: 0", `${base}quantity:\n  max: 0\n`, "quantity.max"],
    ["quantity.max: 2.5", `${base}quantity:\n  max: 2.5\n`, "quantity.max"],
    ["per_order_usd: .inf", `${base}spend:\n  per_order_usd: .inf\n`, "spend.per_order_usd"],
    ["per_order_usd: -1", `${base}spend:\n  per_order_usd: -1\n`, "spend.per_order_usd"],
    ["per_week_usd: .nan", `${base}spend:\n  per_week_usd: .nan\n`, "spend.per_week_usd"],
    ["per_day_usd as text", `${base}spend:\n  per_day_usd: "40"\n`, "spend.per_day_usd"],
    ["allowing an excluded category", `${base}categories:\n  allow: [gift cards]\n`, "categories.allow"],
    ["share.history: true", `${base}share:\n  history: true\n`, "share.history"],
    ["share.ship_to: full", `${base}share:\n  ship_to: full\n`, "share.ship_to"],
    ["an unknown nested key", `${base}spend:\n  per_order_usd: 10\n  unlimited: true\n`, "spend.unlimited"],
    ["completion: [auto]", `${base}completion: [auto]\n`, "completion[0]"],
    ["a completion mode beside a valid one", `${base}completion: [handoff, shop_agent]\n`, "completion[1]"],
    ["completion: one_tap as text, not a list", `${base}completion: one_tap\n`, "completion"],
    ["completion: null", `${base}completion: null\n`, "completion"],
    ["three completion modes", `${base}completion: [handoff, one_tap, handoff]\n`, "completion"],
    ["an alias bomb", aliasBomb, "c[7]"],
    ["a 65 KiB file", `${base}# ${"x".repeat(65 * 1024)}\n`, "(document)"],
  ];

  it.each(attacks)("refuses %s", (_label, text, path) => {
    const error = refusal(text);
    expect(error.code).toBe("POLICY_LOOSENS");
    expect(error.path).toBe(path);
    expect(error.message).toContain(path);
  });

  it("explains that categories can only be blocked", () => {
    expect(refusal(`${base}categories:\n  allow: [crypto]\n`).message).toMatch(/can only block categories/);
  });

  it("refuses aliases that expand past the limit even when there are few of them", () => {
    const nested = [
      base,
      "x: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]",
      "y: &b [*a, *a, *a, *a]",
      "z: [*b, *b, *b, *b]",
    ].join("\n");
    const error = refusal(nested);
    expect(error.code).toBe("POLICY_LOOSENS");
    expect(error.path).toBe("(document)");
  });

  it("accepts the same policy when it is exactly 64 KiB", () => {
    const filler = 64 * 1024 - Buffer.byteLength(base) - 3;
    expect(() => loadPolicy(`${base}# ${"x".repeat(filler)}\n`)).not.toThrow();
  });
});

describe("loadPolicy: malformed input", () => {
  const invalid: [string, string, string][] = [
    ["a YAML syntax error", "version: 1\napproval: [passkey\n", "(document)"],
    ["two documents", `${base}---\n${base}`, "(document)"],
    ["an unknown tag", `${base}spend: !custom {}\n`, "(document)"],
    ["an empty file", "", "(document)"],
    ["a list at the root", "- version: 1\n", "(document)"],
    ["version 2", "version: 2\napproval: passkey\n", "version"],
    ["a merchant that is not text", `${base}merchants:\n  block: [42]\n`, "merchants.block[0]"],
    ["a blank category", `${base}categories:\n  block: ["  "]\n`, "categories.block[0]"],
    ["a non-plain key", `${base}? [a, b]\n: 1\n`, "(document)"],
    ["an empty completion list", `${base}completion: []\n`, "completion"],
  ];

  it.each(invalid)("refuses %s with POLICY_INVALID", (_label, text, path) => {
    const error = refusal(text);
    expect(error.code).toBe("POLICY_INVALID");
    expect(error.path).toBe(path);
  });

  it("reports a loosening problem before a malformed one in the same file", () => {
    const error = refusal("version: 2\napproval: off\n");
    expect(error).toMatchObject({ code: "POLICY_LOOSENS", path: "approval", name: "PolicyError" });
  });
});

describe("loadPolicy: accepted policies", () => {
  it("fills absent sections from the Cloud baseline", () => {
    const p = loadPolicy(base);
    expect(p).toEqual({
      version: 1,
      share: { ship_to: "postcode_only", history: false },
      spend: {},
      quantity: { max: 3 },
      merchants: { block: [] },
      categories: { block: [] },
      approval: "passkey",
      completion: ["handoff", "one_tap"],
    });
    expect(Object.isFrozen(p) && Object.isFrozen(p.merchants.block) && Object.isFrozen(p.completion)).toBe(true);
  });

  it("loads a completion list that narrows to the hand-off, and dedupes and sorts one", () => {
    expect(loadPolicy(`${base}completion: [handoff]\n`).completion).toEqual(["handoff"]);
    expect(loadPolicy(`${base}completion: [one_tap, one_tap]\n`).completion).toEqual(["one_tap"]);
    expect(loadPolicy(`${base}completion: [one_tap, handoff]\n`).completion).toEqual(["handoff", "one_tap"]);
  });

  it("normalizes, sorts and deduplicates lists", () => {
    const p = loadPolicy(
      [
        base,
        "share: {ship_to: none, history: false}",
        "spend: {per_order_usd: 60, per_day_usd: 40, per_week_usd: 150}",
        "quantity: {max: 1}",
        "merchants:",
        "  allow: [Shop.Example., b.example]",
        "  block: [dropship.example, DROPSHIP.example]",
        "categories:",
        "  block: [Home_Goods, Electronics / Phones]",
      ].join("\n"),
    );
    expect(p.share.ship_to).toBe("none");
    expect(p.spend).toEqual({ per_order_usd: 60, per_day_usd: 40, per_week_usd: 150 });
    expect(p.quantity.max).toBe(1);
    expect(p.merchants).toEqual({ allow: ["b.example", "shop.example"], block: ["dropship.example"] });
    expect(p.categories.block).toEqual(["electronics/phones", "home-goods"]);
  });

  it("allows a small number of aliases", () => {
    const p = loadPolicy(`${base}merchants:\n  allow: &list [a.example]\n  block: *list\n`);
    expect(p.merchants).toEqual({ allow: ["a.example"], block: ["a.example"] });
  });

  it("has a baseline that blocks every excluded category and needs a passkey", () => {
    expect(CLOUD_BASELINE.categories.block).toEqual([...EXCLUDED_CATEGORIES].sort());
    expect(CLOUD_BASELINE.approval).toBe("passkey");
    expect(CLOUD_BASELINE.quantity.max).toBe(3);
    expect(CLOUD_BASELINE.completion).toEqual(["handoff", "one_tap"]);
  });
});

describe("loadPolicy: merchant and category names", () => {
  const merchants = (list: string, key = "block") => `${base}merchants:\n  ${key}: ${list}\n`;

  it("stores merchants as lowercase ASCII hostnames without a trailing dot", () => {
    const p = loadPolicy(merchants('["EVIL.com.", "bücher.de", "evil。com", "ｓｈｏｐ.example"]'));
    expect(p.merchants.block).toEqual(["evil.com", "shop.example", "xn--bcher-kva.de"]);
  });

  it.each([
    "evil.com..",
    "evil.com:443",
    "https://evil.com",
    "evil.com/path",
    "a..b.example",
    ".",
    ".evil.com",
    "*.evil.com",
    "user@evil.com",
    "evil com",
    String.fromCodePoint(0x200b),
    "-evil.com",
    "evil_shop.com",
  ])("refuses the merchant %j in block and in allow", (name) => {
    for (const key of ["block", "allow"]) {
      const error = refusal(merchants(JSON.stringify([name]), key));
      expect(error.code).toBe("POLICY_INVALID");
      expect(error.path).toBe(`merchants.${key}[0]`);
    }
  });

  it("names the offending entry by its index", () => {
    expect(refusal(merchants('[ok.example, "evil.com:443"]')).path).toBe("merchants.block[1]");
  });

  it("refuses a category that is empty after normalization or has an empty level", () => {
    for (const name of ['"\\u200b"', '"electronics//phones"', '"electronics/"']) {
      const error = refusal(`${base}categories:\n  block: [${name}]\n`);
      expect(error.code).toBe("POLICY_INVALID");
      expect(error.path).toBe("categories.block[0]");
    }
  });
});
