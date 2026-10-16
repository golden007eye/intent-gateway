// E2 acceptance (plan §5.3 G22, AC-T3): the built package's MCP stdio server on the real-host code path
// (`node dist/main.js serve --trust-keys …`, not demo mode) against the fake Intent Cloud, driven by an MCP SDK
// client: find_offers (the policy hides one offer) → create_cart → the buyer approves with the soft passkey →
// get_approval_status approved → `node dist/main.js verify` exit 0. The flow must take under 30 s.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeCloud, SoftPasskey, startFakeCloud } from "../../src/cloud-fake/index.ts";
import { buildPackage, chain, count, field, offerHandle, startGateway, tempDir, trustKeysFile, verify } from "./support.ts";

let main: string;
let fake: FakeCloud;
let keys: string;

beforeAll(async () => {
  main = buildPackage();
  fake = await startFakeCloud({});
  keys = trustKeysFile(fake);
}, 120_000);

afterAll(async () => {
  await fake.close();
});

describe("E2: a purchase from search to verify, on the built package", () => {
  it("find_offers → create_cart → passkey approve → approved → verify exit 0, in under 30 s", { timeout: 60_000 }, async () => {
    const started = Date.now();
    const dataDir = join(tempDir("e2e-accept-"), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // zip-only plus one merchant block, so the policy hides one of the two running-shoe offers.
    writeFileSync(
      join(dataDir, "policy.yaml"),
      "version: 1\napproval: passkey\nshare:\n  ship_to: postcode_only\nmerchants:\n  block: [shop.example]\n",
    );
    const gateway = await startGateway(main, { cloudUrl: fake.url, keys, dataDir });
    try {
      const offers = await gateway.call("find_offers", { category: "running-shoes", budget_usd: 200, zip: "94103" });
      expect(offers).toMatch(/^1 offer\. 1 more hidden by the gateway policy \(merchants\.block\)\./);
      expect(offers).not.toContain("Trail Runner 3");
      expect(offers).toMatch(/\nSent: searchCatalog \(.*ship_to\.postal_code.*; receipt verified\) \/ Blocked: nothing$/);
      const offer = offerHandle(offers, "Road Runner 2");

      const cart = await gateway.call("create_cart", { offer_handle: offer });
      expect(cart).toContain("Cart: 1 × Road Runner 2");
      const handle = field(cart, "approval_handle");
      expect(field(cart, "Approval link")).toMatch(/^https:\/\/confirm\.example\/c\//);

      expect(await gateway.call("get_approval_status", { approval_handle: handle })).not.toContain("Approved:");
      expect(fake.approveWithPasskey(handle, new SoftPasskey()).status).toBe(200);
      const status = await gateway.call("get_approval_status", { approval_handle: handle });
      expect(status).toMatch(/^Approved: the buyer's pinned passkey signed this purchase/);
      expect(status).toMatch(/Approver passkey fingerprint: [0-9a-f]{4}( [0-9a-f]{4}){15}/);
      expect(gateway.stderr()).toContain("pinned the first approving passkey");
    } finally {
      await gateway.close();
    }

    const entries = chain(dataDir);
    expect(count(entries, "approver_pin")).toBe(1);
    expect(count(entries, "approval")).toBe(1);
    expect(count(entries, "discarded")).toBe(0);

    const report = verify(main, dataDir, keys);
    expect(report.out).toMatch(/^approvals: ok$/m);
    expect(report.out).toMatch(/^verify: ok$/m);
    expect(report.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
