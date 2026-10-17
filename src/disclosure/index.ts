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
export { connectShop, type LinkedShopVault, linkShop, type ShopConnection, type ShopLink } from "./shop.ts";
export { type DeviceGrantPrompt, ShopLinkError, type ShopLinkFailure } from "../wallet-shop/index.ts";
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
