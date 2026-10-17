// The "Sent: …" line names the destination of a send that did not go to Intent Cloud, and says its answer is
// unsigned (a `response`, never a receipt); Intent Cloud sends read as before (invariant 5).
import { describe, expect, it } from "vitest";
import type { Entry, EntryKind } from "../store/index.ts";
import { disclosedSince, summaryLine } from "./history.ts";

const entry = (seq: number, kind: EntryKind, body: unknown): Entry => ({ seq, prev: "", ts: "2026-10-16T00:00:00.000Z", kind, body, hash: "" });

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
      "Sent: searchCatalog (product; receipt verified); shop get_checkout (params.arguments.checkout_id; answered, unsigned) / " +
        "Logged, maybe sent; no answer recorded: shop complete_checkout (no body fields) / Blocked: nothing",
    );
  });

  it("treats an explicit intent_cloud destination as Intent Cloud", () => {
    const chain = [entry(0, "disclosure", { endpoint: "getMeta", destination: "intent_cloud", fields: [] }), entry(1, "receipt", { disclosure_seq: 0, verified: false })];
    expect(summaryLine(disclosedSince(chain, -1))).toBe("Sent: getMeta (no body fields; no verified receipt) / Blocked: nothing");
  });
});
