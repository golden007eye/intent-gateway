// `intent wallet status | unlink <rail>` (plan G6). status says whether a wallet is linked and whether its vault
// opens, never the token. unlink deletes the vault file and chains `wallet {rail, action: "unlinked", revoked}`;
// revoking the token at the rail comes with the rail's adapter, so here `revoked` is always false and the output
// says where to revoke it by hand.
import { type Config, INTENT } from "../config/index.ts";
import { openStore } from "../store/index.ts";
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

/** Exit 0 when every wallet is linked and opens or is not linked; 1 when a vault does not open. */
export async function walletStatus(io: Io, config: Config): Promise<number> {
  warn(io, config);
  let code = 0;
  for (const rail of WALLET_RAILS) {
    const name = RAIL_NAMES[rail];
    const file = vaultPath(config.dataDir, rail);
    if (!(await hasSecret(config.dataDir, rail))) {
      line(io.stdout, `${name} wallet: not linked`);
      continue;
    }
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

/** Deletes the rail's vault file, then chains the unlink. Exit 0 also when nothing was linked. */
export async function walletUnlink(io: Io, config: Config, rail: string): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; known: ${WALLET_RAILS.join(", ")}`, 2);
  const name = RAIL_NAMES[rail];
  // Deleted first, then chained: the entry records a deletion that happened. Nothing is sent, so invariant 2 does
  // not order these two; a failed append is reported and the file stays deleted.
  if (!(await deleteSecret(config.dataDir, rail))) {
    line(io.stdout, `${name} wallet: not linked; nothing to unlink`);
    return 0;
  }
  const store = await openStore(config.dataDir, {
    onWait: leaseNotice((text) => {
      line(io.stderr, `intent: ${text}`);
    }, io.now),
  });
  try {
    const entry = await store.append("wallet", { rail, action: "unlinked", revoked: false });
    line(io.stdout, printable(`${name} wallet unlinked: deleted ${vaultPath(config.dataDir, rail)} (entry #${String(entry.seq)})`));
  } finally {
    await store.close();
  }
  line(io.stderr, `intent: the ${name} token was not revoked by this gateway; revoke the gateway's access in your ${name} account settings`);
  return 0;
}

function warn(io: Io, config: Config): void {
  for (const text of walletKeyWarnings(config.wallet)) line(io.stderr, `intent: warning: ${text}`);
}
