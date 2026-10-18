// The gateway's account key (ADR-0020): made once by `intent init`, its public half sent as `account_key`, its
// thumbprint naming it, and its sign() used for a Pause. The key itself never leaves the data dir.
export {
  ACCOUNT_KEY_FILE,
  type AccountKey,
  AccountKeyError,
  type AccountPublicJwk,
  ensureAccountKey,
  jwkThumbprint,
  loadAccountKey,
} from "./account-key.ts";
