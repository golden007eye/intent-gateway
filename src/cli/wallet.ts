// `intent wallet status | unlink <rail>` (plans G6, G7a). status says whether a wallet is linked and whether its
// vault opens, never the token, and whether one-tap with Shop is available (it needs INTENT_SHOP_CLIENT_ID).
// unlink first asks the rail to revoke the token (a disclosed send, logged before it leaves), then deletes the vault
// file and chains `wallet {rail, action: "unlinked", revoked}`. `revoked` is true only when the rail acknowledged the
// revocation (HTTP 200, RFC 7009); otherwise the output says where to revoke it by hand (invariant 5).
import { type Config, INTENT } from "../config/index.ts";
import { connectShop, openWalletSession } from "../disclosure/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { printable } from "../ui/index.ts";
import {
  deleteSecret,
  describeKeySource,
  hasSecret,
  isWalletRail,
  loadSecret,
  loadWalletKey,
  vaultPath,
  WALLET_RAILS,
  type WalletRail,
  walletKeyWarnings,
  WalletVaultError,
} from "../wallet/index.ts";
import { CliError, type Io, line } from "./io.ts";
import { leaseNotice } from "./waiting.ts";

const RAIL_NAMES: Readonly<Record<WalletRail, string>> = { shop: "Shop" };
/** Where the developer revokes the gateway's access by hand. */
const RAIL_SETTING: Readonly<Record<WalletRail, string>> = { shop: "the Shop app: Account › Connections" };

/** Why one-tap with each rail is unavailable in this configuration, or null when it is available. */
const ONE_TAP_UNAVAILABLE: Readonly<Record<WalletRail, (config: Config) => string | null>> = {
  shop: (config) =>
    config.wallet.shopClientId === null
      ? "Shop one-tap: unavailable, no Shop client is set (INTENT_SHOP_CLIENT_ID); purchases are handed off to the merchant's checkout"
      : null,
};
const oneTapUnavailable = (config: Config, rail: WalletRail): string | null => ONE_TAP_UNAVAILABLE[rail](config);

/** Exit 0 when every wallet is linked and opens or is not linked; 1 when a vault does not open. */
export async function walletStatus(io: Io, config: Config): Promise<number> {
  warn(io, config);
  let code = 0;
  for (const rail of WALLET_RAILS) {
    const name = RAIL_NAMES[rail];
    const file = vaultPath(config.dataDir, rail);
    const unavailable = oneTapUnavailable(config, rail);
    if (!(await hasSecret(config.dataDir, rail))) {
      line(io.stdout, `${name} wallet: not linked`);
      if (unavailable !== null) line(io.stdout, unavailable);
      continue;
    }
    if (unavailable !== null) line(io.stdout, unavailable);
    const fix = `unlink it with ${INTENT} wallet unlink ${rail} and link it again`;
    try {
      const key = await loadWalletKey(config.wallet.key, { create: false });
      if (key === null) throw new WalletVaultError("no_key", `its key file ${describeKeySource(config.wallet.key)} is missing`);
      // Opened to prove the vault is readable; the token itself is dropped here and never printed.
      await loadSecret(config.dataDir, rail, key);
      line(io.stdout, printable(`${name} wallet: linked (encrypted vault ${file}; key from ${describeKeySource(config.wallet.key)})`));
    } catch (error) {
      if (!(error instanceof WalletVaultError)) throw error;
      code = 1;
      line(io.stdout, printable(`${name} wallet: vault unreadable: ${error.message} (fix: ${fix})`));
    }
  }
  return code;
}

/** Opens the chain, deletes the rail's vault file, then chains the unlink. Exit 0 also when nothing was linked. */
export async function walletUnlink(io: Io, config: Config, rail: string): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; known: ${WALLET_RAILS.join(", ")}`, 2);
  const name = RAIL_NAMES[rail];
  const notLinked = (): number => {
    line(io.stdout, `${name} wallet: not linked; nothing to unlink`);
    return 0;
  };
  if (!(await hasSecret(config.dataDir, rail))) return notLinked();
  // The store is opened before anything else, so an unusable data dir or chain stops here with the file intact. The
  // revocation is a send, so the disclosure core logs it first (invariant 2). The file is deleted whatever the
  // revocation's result, and the entry is appended after the delete, so it records a deletion that happened; only a
  // failed append can leave the deletion unchained, and then the command fails with the store's own error.
  const store = await openStore(config.dataDir, {
    onWait: leaseNotice((text) => {
      line(io.stderr, `intent: ${text}`);
    }, io.now),
  });
  let revoked: boolean;
  try {
    revoked = await revoke(io, config, rail, store);
    if (!(await deleteSecret(config.dataDir, rail))) return notLinked();
    const entry = await store.append("wallet", { rail, action: "unlinked", revoked });
    line(io.stdout, printable(`${name} wallet unlinked: deleted ${vaultPath(config.dataDir, rail)} (entry #${String(entry.seq)})`));
  } finally {
    await store.close();
  }
  if (revoked) line(io.stdout, `${name} acknowledged the revocation of the gateway's token (HTTP 200)`);
  else line(io.stderr, `intent: the ${name} token was not revoked by this gateway; revoke the gateway's access in your ${name} account settings (${RAIL_SETTING[rail]})`);
  return 0;
}

/**
 * Asks the rail to revoke the vault's token; true only when it acknowledged. A vault that does not open, holds no
 * token, or names no client, and every failure of the send, give false with the reason on stderr (never the token).
 */
async function revoke(io: Io, config: Config, rail: WalletRail, store: Store): Promise<boolean> {
  const name = RAIL_NAMES[rail];
  try {
    const key = await loadWalletKey(config.wallet.key, { create: false });
    const text = key === null ? null : await loadSecret(config.dataDir, rail, key);
    if (text === null) {
      line(io.stderr, `intent: the ${name} vault cannot be opened (no key), so its token cannot be revoked from here`);
      return false;
    }
    const wallet = connectShop(openWalletSession(store), {
      mcpUrl: config.wallet.shopMcpUrl,
      authUrl: config.wallet.shopAuthUrl,
      vaultText: text,
    });
    const result = await wallet.revoke();
    if (result === "not_sent") line(io.stderr, `intent: the ${name} vault holds no token and client to revoke with, so no revocation was sent`);
    if (result === "not_revoked") line(io.stderr, `intent: ${name} answered the revocation with an error`);
    return result === "revoked";
  } catch (error) {
    // Messages here are the gateway's own (vault, transport, disclosure); none carries the token.
    line(io.stderr, printable(`intent: could not revoke the ${name} token: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

function warn(io: Io, config: Config): void {
  for (const text of walletKeyWarnings(config.wallet)) line(io.stderr, `intent: warning: ${text}`);
}
