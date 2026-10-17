// Property test for `meet`: over 1000 seeded random policy pairs, meet(a, b) is at least as narrow as a and as
// b (and, met with the baseline, than CLOUD_BASELINE), both by its rules and by its decisions on random requests.
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CLOUD_BASELINE,
  evaluate,
  loadPolicy,
  meet,
  PolicyError,
  type CompletionMode,
  type Outbound,
  type Policy,
  type Purchase,
} from "./index.ts";
import { categoryBlocked, merchantMatches } from "./policy.ts";

/** mulberry32: a small seeded PRNG, so a failure reproduces from its seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = ["a.example", "b.example", "shop.a.example", "dropship.example", "c.example"];
const CATEGORIES = ["electronics", "electronics/phones", "home", "toys", "garden", "gift-cards"];

function randomPolicyText(rand: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const some = (items: readonly string[]): string[] => items.filter(() => rand() < 0.35);
  const maybe = (value: () => unknown): unknown => (rand() < 0.5 ? value() : undefined);
  const doc: Record<string, unknown> = { version: 1, approval: "passkey" };
  if (rand() < 0.7) doc.share = { ship_to: pick(["postcode_only", "none"]), history: false };
  const spend = {
    per_order_usd: maybe(() => 1 + Math.floor(rand() * 200)),
    per_day_usd: maybe(() => 1 + Math.floor(rand() * 300)),
    per_week_usd: maybe(() => 1 + Math.floor(rand() * 600)),
  };
  doc.spend = Object.fromEntries(Object.entries(spend).filter(([, v]) => v !== undefined));
  if (rand() < 0.7) doc.quantity = { max: pick([1, 2, 3]) };
  const merchants: Record<string, string[]> = { block: some(MERCHANTS) };
  if (rand() < 0.4) merchants.allow = some(MERCHANTS);
  doc.merchants = merchants;
  doc.categories = { block: some(CATEGORIES) };
  if (rand() < 0.6) doc.completion = pick([["handoff"], ["one_tap"], ["handoff", "one_tap"], ["one_tap", "one_tap"]]);
  return stringify(doc);
}

function randomOutbound(rand: () => number): Outbound {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  if (rand() < 0.3) {
    return { kind: "search", category: pick(CATEGORIES), ship_to_zip: pick(["94110", "9411", "SW1A 1AA"]) };
  }
  const mode = pick<CompletionMode | undefined>([undefined, "handoff", "one_tap"]);
  return {
    kind: "cart",
    ...(mode === undefined ? {} : { completion_mode: mode }),
    offer: {
      merchant: pick([...MERCHANTS, "x.b.example", "other.example"]),
      category: pick([...CATEGORIES, "home/kitchen"]),
      price_usd: Math.floor(rand() * 25000) / 100,
      quantity: pick([1, 2, 3, 4]),
    },
  };
}

const RANK = { none: 0, postcode_only: 1 } as const;

/** n ⊑ p: n allows nothing that p refuses. */
function narrowerOrEqual(n: Policy, p: Policy): boolean {
  const capOk = (key: keyof Policy["spend"]): boolean => {
    const pc = p.spend[key];
    const nc = n.spend[key];
    return pc === undefined || (nc !== undefined && nc <= pc);
  };
  return (
    RANK[n.share.ship_to] <= RANK[p.share.ship_to] &&
    capOk("per_order_usd") &&
    capOk("per_day_usd") &&
    capOk("per_week_usd") &&
    n.quantity.max <= p.quantity.max &&
    p.merchants.block.every((m) => merchantMatches(m, n.merchants.block)) &&
    (p.merchants.allow === undefined ||
      (n.merchants.allow !== undefined && n.merchants.allow.every((m) => merchantMatches(m, p.merchants.allow ?? [])))) &&
    p.categories.block.every((c) => categoryBlocked(c, n.categories.block)) &&
    n.completion.every((mode) => p.completion.includes(mode))
  );
}

describe("meet", () => {
  // CPU-bound: about 1 s alone, but it can pass the 5 s default when the whole suite shares the cores.
  it("is at least as narrow as both inputs for 1000 seeded random pairs", { timeout: 30_000 }, () => {
    const rand = prng(0x5eed);
    const now = Date.parse("2026-10-01T12:00:00Z");
    for (let i = 0; i < 1000; i++) {
      const a = loadPolicy(randomPolicyText(rand));
      const b = loadPolicy(randomPolicyText(rand));
      const common = a.completion.filter((mode) => b.completion.includes(mode));
      if (common.length === 0) {
        // Attack: two policies that share no completion mode must not combine into one that allows any.
        expect(() => meet(a, b)).toThrow(PolicyError);
        expect(() => meet(b, a)).toThrow(/completion: the two policies share no completion mode/);
        continue;
      }
      const m = meet(a, b);
      const context = { i, a, b, m };
      expect(m.completion).toEqual(common);
      expect(m.completion.every((mode) => CLOUD_BASELINE.completion.includes(mode))).toBe(true);
      expect(narrowerOrEqual(m, a), JSON.stringify(context)).toBe(true);
      expect(narrowerOrEqual(m, b), JSON.stringify(context)).toBe(true);
      expect(narrowerOrEqual(meet(m, CLOUD_BASELINE), CLOUD_BASELINE)).toBe(true);
      expect(meet(b, a)).toEqual(m);
      expect(meet(m, m)).toEqual(m);
      const history: Purchase[] = [{ at: now - Math.floor(rand() * 8) * 86_400_000, total_usd: Math.floor(rand() * 200) }];
      for (let j = 0; j < 5; j++) {
        const outbound = randomOutbound(rand);
        if (evaluate(m, outbound, history, now).send) {
          expect(evaluate(a, outbound, history, now).send, JSON.stringify({ ...context, outbound })).toBe(true);
          expect(evaluate(b, outbound, history, now).send, JSON.stringify({ ...context, outbound })).toBe(true);
          expect(evaluate(CLOUD_BASELINE, outbound, history, now).send).toBe(true);
        }
      }
    }
  });

  it("keeps only merchants both allow-lists accept, including subdomains", () => {
    const a = loadPolicy("version: 1\napproval: passkey\nmerchants: {allow: [a.example, b.example]}\n");
    const b = loadPolicy("version: 1\napproval: passkey\nmerchants: {allow: [shop.a.example, c.example]}\n");
    expect(meet(a, b).merchants.allow).toEqual(["shop.a.example"]);
    const open = loadPolicy("version: 1\napproval: passkey\n");
    expect(meet(open, a).merchants.allow).toEqual(["a.example", "b.example"]);
    expect(meet(a, open).merchants.allow).toEqual(["a.example", "b.example"]);
    expect(meet(open, open).merchants.allow).toBeUndefined();
  });

  it("keeps only the completion modes both allow, and refuses two policies that share none", () => {
    const handoff = loadPolicy("version: 1\napproval: passkey\ncompletion: [handoff]\n");
    const oneTap = loadPolicy("version: 1\napproval: passkey\ncompletion: [one_tap]\n");
    const open = loadPolicy("version: 1\napproval: passkey\n");
    expect(meet(open, handoff).completion).toEqual(["handoff"]);
    expect(meet(oneTap, CLOUD_BASELINE).completion).toEqual(["one_tap"]);
    expect(meet(open, open).completion).toEqual(["handoff", "one_tap"]);
    let error: unknown;
    try {
      meet(handoff, oneTap);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ name: "PolicyError", code: "POLICY_INVALID", path: "completion" });
  });

  it("with the baseline adds every excluded category and keeps the passkey", () => {
    const p = meet(loadPolicy("version: 1\napproval: passkey\ncategories: {block: [toys]}\n"), CLOUD_BASELINE);
    expect(p.categories.block).toEqual([...CLOUD_BASELINE.categories.block, "toys"].sort());
    expect(p.approval).toBe("passkey");
  });
});
