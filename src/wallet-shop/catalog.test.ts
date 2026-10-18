// The projection of Shop's search_catalog answer (G5; invariant 3): only named product fields come out, and none of
// the buyer's identity, wherever Shop puts it. Inputs have the shape the S1 spike saw (step 5), with made-up values.
import { describe, expect, it } from "vitest";
import { findIdentity } from "../privacy/index.ts";
import { MAX_CATALOG_HITS, projectCatalog } from "./project.ts";

const PII = { name: "Jane Doe-Fakename", email: "jane.doe@buyer.example", phone: "+1 415 555 2671", street: "123 Main St", city: "Springfield" };
const address = { first_name: "Jane", last_name: "Doe-Fakename", street_address: PII.street, address_locality: PII.city, postal_code: "94107", phone_number: PII.phone };

/** A search_catalog product, with identity Shop could add anywhere. */
const product = (over: Record<string, unknown> = {}, variant: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/1",
  title: "Vinyl sticker",
  url: "https://stickers.example/products/vinyl?variant=11&_pos=1#top",
  product_type: "Stickers",
  tags: ["Sticker", "Vinyl"],
  media: [{ url: "https://stickers.example/cdn/v.png?width=200" }],
  customer: { email: PII.email, phone: PII.phone, addresses: [address] },
  variants: [
    {
      id: "gid://shopify/ProductVariant/11",
      title: "Small",
      price: { amount: 450, currency: "USD" },
      availability: { available: true },
      seller: { domain: "sticker-store.myshopify.com", url: "https://stickers.example", owner_email: PII.email },
      buyer: { name: PII.name },
      ...variant,
    },
  ],
  ...over,
});

describe("projectCatalog", () => {
  it("keeps only the named fields, and none of the buyer's identity", () => {
    const hits = projectCatalog({ products: [product()], customer: { name: PII.name, email: PII.email }, account: { addresses: [address] } });
    expect(hits).toEqual([
      {
        storeDomain: "sticker-store.myshopify.com",
        storefrontOrigin: "https://stickers.example",
        productRef: "gid://shopify/Product/1",
        variantRef: "gid://shopify/ProductVariant/11",
        title: "Vinyl sticker",
        variantTitle: "Small",
        price: { amountMinor: 450, currency: "USD" },
        available: true,
        imageUrl: "https://stickers.example/cdn/v.png",
        productUrl: "https://stickers.example/products/vinyl",
        categories: ["stickers", "sticker", "vinyl"],
        requiresShipping: null,
      },
    ]);
    const text = JSON.stringify(hits);
    for (const value of Object.values(PII)) expect(text).not.toContain(value);
    expect(findIdentity(hits)).toEqual([]);
  });

  it("drops a title or URL that reads as identity, and a URL with credentials or not https", () => {
    const [hit] = projectCatalog({
      products: [product({ title: `Engraved for ${PII.email}`, url: `https://stickers.example/u/${PII.email}`, media: [{ url: "http://stickers.example/x.png" }] }, { title: "Default" })],
    });
    expect(hit?.title).toBe("Default");
    expect(hit?.productUrl).toBeNull();
    expect(hit?.imageUrl).toBeNull();
    const [creds] = projectCatalog({ products: [product({ url: "https://user:pw@stickers.example/p" })] });
    expect(creds?.productUrl).toBeNull();
  });

  it("drops a variant with no myshopify store, no variant gid or no integer price", () => {
    const bad = [
      { seller: { domain: "stickers.example", url: "https://stickers.example" } },
      { id: "gid://shopify/Checkout/abc?key=secret" },
      { price: { amount: 4.5, currency: "USD" } },
      { price: { amount: 450, currency: "usd" } },
    ];
    for (const variant of bad) expect(projectCatalog({ products: [product({}, variant)] })).toEqual([]);
  });

  it("reads requires_shipping and availability, and caps the hits", () => {
    const [digital] = projectCatalog({ products: [product({}, { requires_shipping: false, availability: { available: false } })] });
    expect(digital?.requiresShipping).toBe(false);
    expect(digital?.available).toBe(false);
    const many = Array.from({ length: MAX_CATALOG_HITS + 5 }, (_, i) => product({}, { id: `gid://shopify/ProductVariant/${String(100 + i)}` }));
    expect(projectCatalog({ products: many })).toHaveLength(MAX_CATALOG_HITS);
    expect(projectCatalog({})).toEqual([]);
  });
});
