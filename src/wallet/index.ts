// Wallet rails: the port a wallet adapter implements, and the encrypted vault that keeps its token (plan G6).
export {
  type CheckoutRequest,
  isWalletRail,
  type ShipToMatch,
  type WalletAccount,
  type WalletAdapter,
  type WalletCheckout,
  type WalletCheckoutStatus,
  type WalletLine,
  type WalletMoney,
  type WalletRail,
  WALLET_RAILS,
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
