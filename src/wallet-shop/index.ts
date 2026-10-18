// The Shop wallet adapter (plan G7a; ADR-0017): the developer's own Shop account behind the WalletAdapter port.
// Only src/disclosure may import this module (`only-disclosure-reaches-wallets`): it wraps both transports in the
// disclosure core, so every send to Shop is logged first.
export {
  createShopAdapter,
  parseShopCredentials,
  SHOP_ACCOUNTS_SECRET_PATHS,
  SHOP_OPAQUE_IDS,
  SHOP_SECRET_PATHS,
  type ShopAdapterOptions,
  type ShopCaller,
  type ShopCredentials,
  shopCredentialsText,
} from "./adapter.ts";
export { STORE_DOMAIN } from "./project.ts";
export { type DeviceGrantPrompt, DEVICE_GRANT, type LinkedShop, MAX_WAIT_MS, runDeviceFlow, SHOP_SCOPE, ShopLinkError, type ShopLinkFailure } from "./oauth.ts";
export {
  CLIENT_NAME,
  createShopAccountsTransport,
  createShopMcpTransport,
  DEFAULT_SHOP_AUTH_URL,
  DEFAULT_SHOP_CLIENT_ID,
  DEFAULT_SHOP_MCP_URL,
  DEVICE_AUTHORIZATION,
  MCP_PROTOCOL,
  REVOKE,
  SHOP_TOOLS,
  TOKEN,
  type ShopTool,
  type ShopTransport,
  ShopRequestError,
  ShopTransportError,
  type WireRequest,
  type WireResponse,
} from "./rpc.ts";
