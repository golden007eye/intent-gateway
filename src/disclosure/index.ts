// The disclosure log in front of every outside destination (invariant 2, log before send; ADR-0014): the only module
// that reaches src/cloud and the wallet adapters. The raw adapters are not re-exported, so no caller can hold one
// that skips the log; connectCloud builds Intent Cloud's here. A wallet adapter implements DestinationTransport and
// is wrapped by createDisclosedWallet, which shares the disclosed cloud's gateway session and stop.
export {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  type CloudResult,
  DEFAULT_TIMEOUT_MS,
  type HttpCloudOptions,
  type IntentCloud,
} from "../cloud/index.ts";
export {
  type DestinationTransport,
  DisclosureBlockedError,
  DisclosureConflictError,
  DisclosureRefusedError,
  DisclosureStoppedError,
  type OutboundRequest,
  type Redaction,
  type TransportResponse,
} from "./core.ts";
export {
  createDisclosedWallet,
  type DisclosedWallet,
  openWalletSession,
  type WalletDisclosureOptions,
  type WalletResult,
  type WalletSession,
} from "./wallet.ts";
export {
  connectShop,
  finishShopLink,
  type LinkedShopVault,
  linkedShopClientId,
  shopVaultHasToken,
  linkShop,
  openPendingShopLink,
  type PendingShopLink,
  type ShopConnection,
  type ShopLink,
  type ShopLinkWhere,
  ShopPendingError,
  startShopLink,
  type StartedShopLink,
} from "./shop.ts";
export { connectStorefront, STOREFRONT, type StorefrontPort } from "./storefront.ts";
export type { StorefrontTransport } from "../storefront/index.ts";
export { DEFAULT_SHOP_CLIENT_ID, type DeviceGrantPrompt, SHOP_CONNECTIONS_URL, SHOP_PUBLIC_CLIENT_ID, ShopLinkError, type ShopLinkFailure, ShopTransportError } from "../wallet-shop/index.ts";
export {
  connectCloud,
  createDisclosedCloud,
  type DisclosedCloud,
  type DisclosedResult,
  DisclosureKeysExpiredError,
  DisclosureNoKeysError,
  type DisclosureOptions,
  DisclosureDiscardedError,
} from "./disclosure.ts";
