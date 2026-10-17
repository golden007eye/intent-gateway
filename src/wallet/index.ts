// Wallet rails: the port a wallet adapter implements, the encrypted vault that keeps its token (plan G6), and the
// out-of-band order check (plan G12).
export { CHECK_CURRENCY, checkedEntry, checkOrders, chainedOrderRefs, type WalletCheck } from "./check.ts";
export {
  AddressFieldsRequiredError,
  CHECKED_KEYS,
  type CheckoutLocator,
  type CheckoutRequest,
  isWalletRail,
  type RevokeResult,
  type ShipToMatch,
  type WalletAccount,
  type WalletAdapter,
  type WalletCheckout,
  type WalletCheckoutStatus,
  type WalletLine,
  type WalletMoney,
  type WalletOrder,
  type WalletOrders,
  type WalletRail,
  WALLET_ACTIONS,
  WALLET_RAILS,
  walletEntryProblem,
  WalletRailError,
} from "./port.ts";
export {
  deleteSecret,
  describeKeySource,
  hasSecret,
  loadSecret,
  loadWalletKey,
  saveSecret,
  vaultPath,
  WalletKey,
  walletKeyWarnings,
  WalletVaultError,
  type WalletVaultFailure,
} from "./vault.ts";
