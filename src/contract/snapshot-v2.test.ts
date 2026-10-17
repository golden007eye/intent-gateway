// Vector a3 (contract 1.6.0, Appendix A "Snapshot v2"): every derived value of each v2 snapshot is reproduced here
// from its inputs with the gateway's own JCS, hash, challenge and key code, so the gateway hashes and checks v2
// snapshots exactly as Intent Cloud and the confirm page do.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { sessionFromSeed } from "../signing/index.ts";
import { approvalChallenge } from "../trust/index.ts";
import { AnySnapshot, checkoutRefHash, SnapshotV2 } from "./index.ts";

interface A3Case {
  name: string;
  input: { continue_url: string; checkout_id: string; completer_seed_hex: string; snapshot: Record<string, unknown> };
  expected: { jcs: string; snapshot_hash: string; check_code: string; challenge: { approve: string; reject: string } };
}
const a3 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "a3-snapshot-v2.json"), "utf8")) as { cases: A3Case[] };
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("vector a3: snapshot v2", () => {
  it("holds one handoff and one shop_agent snapshot", () => {
    expect(a3.cases.map((c) => SnapshotV2.parse(c.input.snapshot).completion_mode).sort()).toEqual(["handoff", "shop_agent"]);
  });

  describe.each(a3.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const snapshot = SnapshotV2.parse(c.input.snapshot);

    it("JCS bytes, snapshot_hash and check_code", () => {
      expect(canonicalize(snapshot)).toBe(c.expected.jcs);
      expect(sha256Hex(canonicalize(snapshot))).toBe(c.expected.snapshot_hash);
      expect(c.expected.snapshot_hash.slice(0, 8)).toBe(c.expected.check_code);
    });

    it("approve and reject challenges", () => {
      expect(approvalChallenge("approve", c.expected.snapshot_hash)).toBe(c.expected.challenge.approve);
      expect(approvalChallenge("reject", c.expected.snapshot_hash)).toBe(c.expected.challenge.reject);
    });

    it("continue_url_hash, checkout_ref_hash and the completer keyid come from the inputs", () => {
      expect(snapshot.continue_url_hash).toBe(`sha256:${sha256(c.input.continue_url)}`);
      // Amendment L1: the checkout ref hash is over the id up to its first "?" (a3 checkout ids carry `?key=`).
      expect(snapshot.checkout_ref_hash).toBe(checkoutRefHash(c.input.checkout_id));
      expect(c.input.checkout_id).toContain("?");
      expect(snapshot.completer_keyid).toBe(sessionFromSeed(Buffer.from(c.input.completer_seed_hex, "hex")).keyid);
    });

    it("merchant_origin is https:// + the merchant's domain, lowercased", () => {
      expect(snapshot.merchant_origin).toBe(`https://${snapshot.merchant.domain.toLowerCase()}`);
    });

    // Attack cases: each changed fact gives another hash, so a proof over this snapshot names another approval.
    it.each([
      ["the ZIP", { ship_to: { country: "US", postal_code: "94111" } }],
      ["the origin", { merchant_origin: "https://evil.example" }],
      ["the variant", { variant_ref: "gid://shopify/ProductVariant/1002" }],
      ["the completion mode", { completion_mode: snapshot.completion_mode === "handoff" ? "shop_agent" : "handoff" }],
      ["the completer key", { completer_keyid: sessionFromSeed(Buffer.alloc(32, 9)).keyid }],
      ["the estimated flag", { total_estimated: !snapshot.total_estimated }],
    ])("changing %s changes the hash", (_what, change) => {
      expect(sha256Hex(canonicalize({ ...snapshot, ...change }))).not.toBe(c.expected.snapshot_hash);
    });
  });

  it("refuses a v2 snapshot with a non-ASCII origin, a port, a path, a 3-digit ZIP or an extra field", () => {
    const base = SnapshotV2.parse(a3.cases[0]?.input.snapshot);
    for (const bad of [
      { merchant_origin: "https://bücher.example" },
      { merchant_origin: "https://shop.example:443" },
      { merchant_origin: "https://shop.example/" },
      { merchant_origin: "http://shop.example" },
      { ship_to: { country: "US", postal_prefix: "941" } },
      { buyer: "x" },
    ]) {
      expect(AnySnapshot.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
