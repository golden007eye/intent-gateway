// A fake Shop (MCP server; account server: device flow and revocation) for tests and, later, demo mode (plans G7a,
// G7c, G8). It holds a made-up buyer and made-up tokens; only tests and src/demo may load it
// (`wallet-fake-only-in-tests`).
export {
  type DeviceAnswer,
  FAKE_ADDRESS_ID,
  FAKE_BUYER,
  FAKE_OTHER_VARIANT,
  FAKE_PAN,
  FAKE_PROTOCOL,
  FAKE_STORE,
  FAKE_STOREFRONT,
  FAKE_VARIANT,
  type FakeOAuthRequest,
  type FakeRevocation,
  type FakeShop,
  type FakeShopCall,
  type FakeShopFaults,
  SHIPPING_MINOR,
  startFakeShop,
  UNIT_PRICE_MINOR,
} from "./server.ts";
