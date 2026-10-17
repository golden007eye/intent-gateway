// A fake Shop (MCP server and account-server revocation) for tests and, later, demo mode (plan G7a, G7c). It holds a
// made-up buyer and made-up tokens; only tests and src/demo may load it (`wallet-fake-only-in-tests`).
export {
  FAKE_ADDRESS_ID,
  FAKE_BUYER,
  FAKE_OTHER_VARIANT,
  FAKE_PAN,
  FAKE_PROTOCOL,
  FAKE_STORE,
  FAKE_STOREFRONT,
  FAKE_VARIANT,
  type FakeRevocation,
  type FakeShop,
  type FakeShopCall,
  type FakeShopFaults,
  SHIPPING_MINOR,
  startFakeShop,
  UNIT_PRICE_MINOR,
} from "./server.ts";
