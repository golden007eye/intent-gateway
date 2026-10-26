// `intent log` on the 1.7.0 submit (createCheckout, POST /v1/checkouts): the submit is listed with the cart as
// `cart  submit checkout`, and the summary's buyer-identity line reads the logged body as the disclosure core and
// `intent verify` read it, so a demo-shaped submit (`checkout.store_name`, the coarse `checkout.ship_to.postal_code`)
// raises no alarm. Attack cases: identity smuggled into the submit (a street address in the title, an email, an
// address key at another path) is still reported.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildActivity, summarise } from "../activity/index.ts";
import { DEMO_SESSION } from "../gateway/index.ts";
import { type Entry, openStore } from "../store/index.ts";
import { formatLog, readLog } from "./log.ts";

const TS = Date.parse("2026-10-18T17:00:00.000Z");
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const PLAIN = { color: false, utc: true } as const;

/** A createCheckout body as the demo sends it (contract 1.7.0). */
const SUBMIT = {
  account_key: { crv: "Ed25519", kty: "OKP", x: "yxvuuAg6aDvIeH02_6Qa_wouwjkRMLYp2AZsC3YqHN0" },
  checkout: {
    checkout_ref_hash: "sha256:8a5381affaae568564cfa44a04e56ec61a28254ad85c671bd0faf9e67975dbc1",
    currency: "USD",
    myshopify_domain: "sticker-store.myshopify.com",
    quantity: 1,
    ship_to: { country: "US", postal_code: "94107" },
    store_name: "stickers.example",
    store_site: "https://stickers.example",
    title: "Holographic sticker",
    totals: { shipping: 399, subtotal: 500, tax: 0, total: 899 },
    variant_ref: "gid://shopify/ProductVariant/4401",
  },
  completer_keyid: "gw-s8msTSUqgy-zRYMOIMj98QIjRWT8Q0fGTDT745pydqM",
  completion_mode: "shop_agent",
};

function paths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const p = prefix === "" ? k : `${prefix}.${k}`;
    return [p, ...paths(v, p)];
  });
}

async function submitChain(body: unknown): Promise<unknown[]> {
  const dir = join(mkdtempSync(join(tmpdir(), "log-checkout-")), "demo");
  let second = 0;
  const store = await openStore(dir, { clock: () => TS + (second += 1000) });
  const append = (kind: Entry["kind"], b: unknown) => store.append(kind, b);
  await append("session", DEMO_SESSION);
  await append("keys", { statement: { kid: "cloud-root-1", expires_at: "2027-01-16T00:00:00Z" } });
  const submit = await append("disclosure", {
    endpoint: "createCheckout",
    method: "POST",
    path: "/v1/checkouts",
    fields: paths(body),
    headers: [["content-type", "application/json"]],
    body_b64: b64(body),
    content_digest: "sha-256=:x:",
    keyid: "gw-k",
  });
  await append("receipt", { disclosure_seq: submit.seq, status: 201, verified: true });
  await append("approval_pending", { handle: "ap_jzyz00000000jd4L", approval_url: "http://127.0.0.1:8788/confirm/c/x", total_minor: 899 });
  await store.close();
  return readLog(dir);
}

const identity = (items: unknown[]) => summarise(items, buildActivity(items).activities).identity;
const log = (items: unknown[]): string => formatLog(items, { style: PLAIN, dataDir: "/home/u/.local/share/intent-gateway/demo", home: "/home/u", intent: "intent" });

describe("intent log on the 1.7.0 checkout submit", () => {
  it("lists the submit with the cart and raises no identity alarm for a demo-shaped body (golden)", async () => {
    const items = await submitChain(SUBMIT);
    expect(identity(items)).toEqual({ checked: 1, unchecked: 0, findings: [] });
    const out = log(items);
    expect(out).not.toContain("Buyer identity");
    expect(out).not.toContain("key reads");
    expect(out).toMatchInlineSnapshot(`
      "intent log · DEMO (test keys) · ~/.local/share/intent-gateway/demo · 5 entries

      Sunday 18 October 2026 (UTC)
      17:00:08  keys      keys signed by cloud-root-1 · valid until 2027-01-16  ✓ recorded
      17:00:12  cart      submit checkout · Holographic sticker ×1 · $8.99 · stickers.example  → approval link  ✓ receipt

      Sent to Intent Cloud only: account_key.crv, account_key.kty, account_key.x, checkout.checkout_ref_hash, checkout.currency, checkout.myshopify_domain, checkout.quantity, checkout.ship_to.country, checkout.ship_to.postal_code, checkout.store_name, checkout.store_site, checkout.title, checkout.totals.shipping, checkout.totals.subtotal, checkout.totals.tax, checkout.totals.total, checkout.variant_ref, completer_keyid, completion_mode.
      Never sent: your name, postal address, card.

      2 actions · 1 cart · 1 receipt
      Details: intent log --demo -v · Machine-readable: intent log --demo --json · Integrity: intent verify --demo
      "
    `);
  });

  const smuggled: [string, unknown, string][] = [
    ["a street address in the title", { ...SUBMIT, checkout: { ...SUBMIT.checkout, title: "Holographic sticker, 1 Market Street" } }, "street_address"],
    ["an email in the store name", { ...SUBMIT, checkout: { ...SUBMIT.checkout, store_name: "buyer@example.com" } }, "email"],
    ["an address key beside the coarse postcode", { ...SUBMIT, checkout: { ...SUBMIT.checkout, ship_to: { ...SUBMIT.checkout.ship_to, street_address: "x" } } }, "banned_key"],
    ["a buyer name key at another path", { ...SUBMIT, buyer: { first_name: "x" } }, "banned_key"],
  ];
  for (const [what, body, kind] of smuggled) {
    it(`attack: ${what} in the submit is still reported`, async () => {
      const items = await submitChain(body);
      expect(identity(items).findings).toEqual([{ seq: 2, kinds: [kind] }]);
      expect(log(items)).toMatch(new RegExp(`Buyer identity in what was sent: entry #2 \\(${kind}\\)`));
    });
  }
});
