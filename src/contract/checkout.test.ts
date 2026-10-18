// The checkout ref hash (contract 1.6.0 hardening amendment L1; 1.6.1 names Shop's form): over the checkout id up to
// its first "?".
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkoutRefHash } from "./index.ts";

const raw = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

describe("checkoutRefHash", () => {
  it("hashes an id without a query as it is", () => {
    expect(checkoutRefHash("gid://shopify/Checkout/TEST0001")).toBe(raw("gid://shopify/Checkout/TEST0001"));
  });

  it("drops everything from the first '?': a checkout URL's key never decides the hash", () => {
    const bare = checkoutRefHash("gid://shopify/Checkout/TEST0001");
    expect(checkoutRefHash("gid://shopify/Checkout/TEST0001?key=TESTKEY0001")).toBe(bare);
    expect(checkoutRefHash("gid://shopify/Checkout/TEST0001?key=other?x=1")).toBe(bare);
    expect(checkoutRefHash("gid://shopify/Checkout/TEST0001?key=TESTKEY0001")).not.toBe(raw("gid://shopify/Checkout/TEST0001?key=TESTKEY0001"));
  });

  it("1.6.1: Shop's checkout id gid://shopify/Checkout/<token>?key=… hashes the gid only, so create and get agree (S1)", () => {
    const created = "gid://shopify/Checkout/hWN2abcDEF123456?key=CREATEKEY0001";
    const read = "gid://shopify/Checkout/hWN2abcDEF123456?key=READKEY0002";
    expect(checkoutRefHash(created)).toBe(raw("gid://shopify/Checkout/hWN2abcDEF123456"));
    expect(checkoutRefHash(read)).toBe(checkoutRefHash(created));
  });

  it.each(["", "?", "?key=TESTKEY0001", "??"])("attack (item 7): an id with an empty path before '?' (%j) has no hash", (id) => {
    expect(checkoutRefHash(id)).toBeNull();
  });

  it("attack: another checkout id is another hash, whatever its query", () => {
    expect(checkoutRefHash("gid://shopify/Checkout/TEST0002?key=TESTKEY0001")).not.toBe(checkoutRefHash("gid://shopify/Checkout/TEST0001?key=TESTKEY0001"));
  });
});
