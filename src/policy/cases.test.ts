import { describe, expect, it } from "vitest";
import { PolicyError, loadPolicy, runCases } from "./index.ts";

const policy = loadPolicy("version: 1\napproval: passkey\nspend: {per_week_usd: 150}\nmerchants: {block: [dropship.example]}\n");

const cases = `
- name: an allowed cart is sent
  outbound: {kind: cart, offer: {merchant: shop.example, category: home, price_usd: 20, quantity: 1}}
  expect: {send: true}
- name: a blocked merchant over the weekly cap is refused for both
  now: "2026-10-15T12:00:00Z"
  history: [{at: "2026-10-12T09:00:00Z", total_usd: 140}]
  outbound: {kind: cart, offer: {merchant: dropship.example, category: home, price_usd: 20, quantity: 1}}
  expect: {send: false, blocked: [spend.per_week_usd, merchants.block]}
- name: a wrong expectation fails
  outbound: {kind: search, category: alcohol}
  expect: {send: true}
`;

describe("runCases", () => {
  it("runs each case and reports pass or fail against the expected rules", () => {
    const results = runCases(policy, cases);
    expect(results.map((r) => [r.name, r.pass])).toEqual([
      ["an allowed cart is sent", true],
      ["a blocked merchant over the weekly cap is refused for both", true],
      ["a wrong expectation fails", false],
    ]);
    expect(results[1]?.expected).toEqual({ send: false, blocked: ["merchants.block", "spend.per_week_usd"] });
    expect(results[2]?.decision.blocked.map((b) => b.rule)).toEqual(["categories.block"]);
  });

  it("fails a case whose rules differ even when send matches", () => {
    const [r] = runCases(
      policy,
      "- name: x\n  outbound: {kind: search, category: alcohol}\n  expect: {send: false, blocked: [merchants.block]}\n",
    );
    expect(r?.pass).toBe(false);
  });

  it.each([
    ["an unknown case key", "- name: x\n  outbound: {kind: search}\n  expect: {send: true}\n  extra: 1\n", "[0]"],
    ["a bad timestamp", "- name: x\n  now: yesterday\n  outbound: {kind: search}\n  expect: {send: true}\n", "[0].now"],
    ["an unknown outbound kind", "- name: x\n  outbound: {kind: pay}\n  expect: {send: true}\n", "[0].outbound.kind"],
    ["an empty file", "", "(document)"],
  ])("refuses %s with POLICY_INVALID", (_label, text, path) => {
    let error: unknown;
    try {
      runCases(policy, text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PolicyError);
    expect(error).toMatchObject({ code: "POLICY_INVALID", path });
  });
});
