// Appendix E step 7 (contract 1.6.1): vector e2-snapshot-v2-request.json replayed case by case, for a gateway of the
// case's contract version and the snapshot it names (v2 or v3), with the refused fields in its order; then what the
// vector cannot show: every field at once, a v1 snapshot, a `sent` chained by a 1.6.0 gateway, and expiry times that
// name no real instant (fail closed).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotV1, SnapshotV2, SnapshotV3 } from "../contract/index.ts";
import { type CheckoutRequest } from "../contract/index.ts";
import { instant, SENT_FIELDS, sentCheckoutOf, sentCheckoutProblems, SentPurchase, sentProblems } from "./index.ts";

interface E2Case {
  name: string;
  input: { contract_version: "1.6.0" | "1.6.1"; snapshot: "snapshot" | "snapshot_v3" } & Record<string, unknown>;
  expected: { valid: boolean; refused: string[] };
}
interface E2 {
  snapshot: unknown;
  snapshot_v3: unknown;
  cases: E2Case[];
}
const e2 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "e2-snapshot-v2-request.json"), "utf8")) as E2;
const v2 = SnapshotV2.parse(e2.snapshot);
const v3 = SnapshotV3.parse(e2.snapshot_v3);
/** The value without `keys`. */
const omit = <T extends object>(value: T, keys: readonly string[]): T => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;
/** The case's input as the gateway chains it: `sent` is the input without the snapshot's name. */
const sentOf = (c: E2Case): SentPurchase => SentPurchase.parse(omit(c.input, ["snapshot"]));
const snapshotOf = (c: E2Case) => (c.input.snapshot === "snapshot_v3" ? v3 : v2);
const valid161 = e2.cases.find((c) => c.expected.valid && c.input.contract_version === "1.6.1") as E2Case;
const base = sentOf(valid161);

describe("vector e2: Appendix E step 7", () => {
  it("has 18 cases: 12 for a 1.6.0 gateway and 6 for a 1.6.1 one, one valid each", () => {
    expect(e2.cases).toHaveLength(18);
    expect(e2.cases.filter((c) => c.input.contract_version === "1.6.1")).toHaveLength(6);
    expect(e2.cases.filter((c) => c.expected.valid).map((c) => c.input.contract_version)).toEqual(["1.6.0", "1.6.1"]);
  });

  it.each(e2.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const refused = sentProblems(snapshotOf(c), sentOf(c));
    expect(refused).toEqual(c.expected.refused);
    expect(refused.length === 0).toBe(c.expected.valid);
  });

  it("lists every refused field at once, in e2's order", () => {
    const all = SentPurchase.parse({
      ...base,
      cart_request: { ...base.cart_request, quantity: 2, ship_to: { country: "US", postal_code: "94111" }, completer_keyid: "gw-Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc", completion_accepts: ["handoff"] },
      offer: { ...base.offer, variant_ref: "gid://shopify/ProductVariant/1002", myshopify_domain: "other-shop.myshopify.com" },
      cart: { ...base.cart, merchant_origin: "https://other.example", total: { amount_minor: 1, currency: "USD" }, expires_at: "2026-10-16T12:00:00Z" },
    });
    expect(sentProblems(v3, all)).toEqual([...SENT_FIELDS]);
  });

  it("refuses a v1 snapshot whatever was sent, and a sent without a version is a 1.6.0 gateway's (v2 only)", () => {
    const rest = Object.fromEntries(Object.entries(v2).filter(([k]) => !["merchant_origin", "variant_ref", "checkout_ref_hash", "completion_mode", "completer_keyid", "total_estimated"].includes(k)));
    expect(sentProblems(SnapshotV1.parse({ ...rest, v: 1, ship_to: { country: "US", postal_prefix: "941" } }), base)).toEqual(["v"]);
    expect(sentProblems(v3, SentPurchase.parse(omit(base, ["contract_version"])))).toEqual(["v"]);
  });

  // Attack cases (1.6.1): a compromised Intent Cloud cannot sign a store pair other than the one it offered.
  it("attack: a v3 snapshot naming a myshopify domain the offer and the cart did not, or dropping theirs, is refused", () => {
    expect(sentProblems({ ...v3, myshopify_domain: "evil-shop.myshopify.com" }, base)).toEqual(["myshopify_domain"]);
    const unpaired = omit(v3, ["myshopify_domain"]);
    expect(sentProblems(unpaired, base)).toEqual(["myshopify_domain"]);
    expect(sentProblems(unpaired, { ...base, offer: omit(base.offer, ["myshopify_domain"]), cart: omit(base.cart, ["myshopify_domain"]) })).toEqual([]);
  });

  // Attack cases: a cart expiry that names no real instant cannot let the snapshot outlive the cart.
  it.each(["2026-02-30T12:15:00Z", "2026-10-16T24:00:00Z", "2026-13-01T00:00:00Z"])("a cart expires_at of %s fails closed", (bad) => {
    expect(sentProblems(v3, { ...base, cart: { ...base.cart, expires_at: bad } })).toEqual(["expires_at"]);
  });

  it("instant parses a real Timestamp and refuses every other text", () => {
    expect(instant("2026-10-16T12:15:00Z")).toBe(Date.parse("2026-10-16T12:15:00Z"));
    for (const bad of ["2026-02-29T00:00:00Z", "2026-10-16T12:15:00.000Z", "2026-10-16 12:15:00Z", "2026-10-16T12:15:00+00:00", ""]) {
      expect(instant(bad), bad).toBeNaN();
    }
  });
});

describe("step 7 for a submitted hand-off (contract 1.7.0): the chained continue_url_hash, never the URL", () => {
  const e3 = JSON.parse(readFileSync(join(import.meta.dirname, "../../contract/vectors/e3-snapshot-v4-request.json"), "utf8")) as {
    cases: { name: string; input: { checkout_request: CheckoutRequest; snapshot: Record<string, unknown> } }[];
  };
  const handoff = e3.cases.find((c) => c.name === "the handoff snapshot for its own request");
  if (handoff === undefined) throw new Error("e3 has no hand-off case");
  const { checkout_request: request, snapshot } = handoff.input;
  const table = String(snapshot.currency_table);

  it("takes the snapshot of its own request, with the URL left out of what is chained", () => {
    const sent = sentCheckoutOf(request, table);
    expect(sent.checkout_request.checkout.continue_url).toBeUndefined();
    expect(sentCheckoutProblems(snapshot, sent)).toEqual([]);
  });

  it("attack: a snapshot signing another hand-off page is refused, before currency_table when both differ", () => {
    const other = { ...request, checkout: { ...request.checkout, continue_url: "https://shop.app/checkouts/finalizer/r/OTHER?key=OTHER" } };
    expect(sentCheckoutProblems(snapshot, sentCheckoutOf(other, table))).toEqual(["continue_url_hash"]);
    expect(sentCheckoutProblems(snapshot, sentCheckoutOf(other, "ct-0000000000000000"))).toEqual(["continue_url_hash", "currency_table"]);
  });
});
