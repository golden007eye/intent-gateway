// The "Sent: …" line names the destination of a send that did not go to Intent Cloud, and says its answer is
// unsigned (a `response`, never a receipt); Intent Cloud sends read as before (invariant 5).
import { describe, expect, it } from "vitest";
import type { Entry, EntryKind } from "../store/index.ts";
import { blockedWords, disclosedSince, spendHistory, summaryLine } from "./history.ts";

const entry = (seq: number, kind: EntryKind, body: unknown): Entry => ({ seq, prev: "", ts: "2026-10-16T00:00:00.000Z", kind, body, hash: "" });

describe("spendHistory: cap room comes back only on local evidence (contract §6, invariant 1)", () => {
  const H = "ap_TEST0003";
  const NOW = Date.parse("2026-10-16T01:00:00Z");
  const approval = entry(1, "approval", { handle: H, proof: { snapshot: { total: { amount_minor: 6000 } } } });
  const cloud = (seq: number, state: string, verified: boolean) =>
    entry(seq, "outcome", {
      handle: H,
      basis: "cloud",
      outcome_hash: "a".repeat(64),
      cloud: { state, source: "merchant_api", assurance: "verified" },
      statement_verified: verified,
      state_shown: verified ? state : null,
    });
  const local = (seq: number, state: string, source: string) => entry(seq, "outcome", { handle: H, basis: "local", state, source, state_shown: state });

  it("attack: a signed, verified Intent Cloud checkout_expired or failed leaves the spend history unchanged", () => {
    const before = spendHistory([approval], NOW);
    expect(before).toEqual([{ at: Date.parse(approval.ts), total_usd: 60 }]);
    expect(spendHistory([approval, cloud(2, "checkout_expired", true)], NOW)).toEqual(before);
    expect(spendHistory([approval, cloud(2, "failed", true), cloud(3, "failed", false)], NOW)).toEqual(before);
  });
  it("the gateway's own refusal before any complete_checkout frees the room; after one is logged it does not", () => {
    expect(spendHistory([approval, local(2, "failed", "gateway_precheck")], NOW)).toEqual([]);
    const sent = entry(2, "disclosure", { destination: "shop", endpoint: "complete_checkout", purchase: H });
    expect(spendHistory([approval, sent, local(3, "failed", "gateway_precheck")], NOW)).toHaveLength(1);
  });
  it("an indeterminate purchase keeps its room", () => {
    expect(spendHistory([approval, local(2, "indeterminate", "shop_api")], NOW)).toHaveLength(1);
  });
});

describe("summaryLine with destinations", () => {
  it("names a wallet destination and its unsigned answer, next to an Intent Cloud send with a verified receipt", () => {
    const chain = [
      entry(0, "disclosure", { endpoint: "searchCatalog", fields: ["product"] }),
      entry(1, "receipt", { disclosure_seq: 0, verified: true }),
      entry(2, "disclosure", { endpoint: "get_checkout", destination: "shop", fields: ["params", "params.arguments", "params.arguments.checkout_id"] }),
      entry(3, "response", { disclosure_seq: 2, status: 200, body_sha256: "0".repeat(64), bytes: 2 }),
      entry(4, "disclosure", { endpoint: "complete_checkout", destination: "shop", fields: [] }),
    ];
    expect(summaryLine(disclosedSince(chain, -1))).toBe(
      "Sent: searchCatalog (product; receipt verified); Shop get_checkout (checkout_id; answered, no signed receipt) / " +
        "Logged, maybe sent; no answer recorded: Shop complete_checkout (no body fields) / Blocked: nothing",
    );
  });

  it("names a wallet call's arguments and counts the MCP protocol fields; any other field is still named (invariant 5)", () => {
    const fields = [
      "id",
      "jsonrpc",
      "method",
      "params._meta.io.modelcontextprotocol/clientInfo.name",
      "params._meta.io.modelcontextprotocol/protocolVersion",
      "params.arguments.catalog.query",
      "params.name",
      // Attack: a field outside the envelope and the arguments, or a _meta field the SDK does not send, is never folded
      // into the count.
      "params.extra",
      "params._meta.evil",
    ];
    const chain = [
      entry(0, "disclosure", { endpoint: "search_catalog", destination: "shop", fields }),
      entry(1, "response", { disclosure_seq: 0, status: 200, body_sha256: "0".repeat(64), bytes: 2 }),
    ];
    expect(summaryLine(disclosedSince(chain, -1))).toBe(
      "Sent: Shop search_catalog (catalog.query, params.extra, params._meta.evil, 6 MCP protocol fields; answered, no signed receipt) / Blocked: nothing",
    );
  });

  it("treats an explicit intent_cloud destination as Intent Cloud", () => {
    const chain = [entry(0, "disclosure", { endpoint: "getMeta", destination: "intent_cloud", fields: [] }), entry(1, "receipt", { disclosure_seq: 0, verified: false })];
    expect(summaryLine(disclosedSince(chain, -1))).toBe("Sent: getMeta (no body fields; no verified receipt) / Blocked: nothing");
  });
});

describe("blockedWords: the Blocked part in plain words, the JSON path only in intent log -v", () => {
  it("words an identity block by what it found and the field it was in", () => {
    expect(blockedWords("postcode at $.must_haves[0]")).toBe("a full postcode (in must-haves)");
    expect(blockedWords("street_address at $.must_haves[2]")).toBe("a street address (in must-haves)");
    expect(blockedWords("email at $.params.arguments.note")).toBe("an email address (in note)");
    expect(blockedWords('phone at $["contact phone"]')).toBe("a phone number (in contact phone)");
    expect(blockedWords("banned_key at $")).toBe("an identity field (in the request)");
    expect(blockedWords("email in a field name")).toBe("an email address (in a field name)");
  });

  it("keeps a policy block as it is", () => {
    expect(blockedWords("categories.block at category")).toBe("categories.block at category");
    expect(blockedWords("1 offer (merchants.block)")).toBe("1 offer (merchants.block)");
  });
});
