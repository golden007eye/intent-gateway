// `intent wallet status | link <rail> | unlink <rail>` (plans G6, G7a, G8). status says whether a wallet is linked
// and whether its vault opens, never the token, and whether one-tap with Shop is available (it needs
// INTENT_SHOP_CLIENT_ID). link runs Shop's OAuth device flow as the gateway's registered client; with none set it
// sends nothing and exits 1. Every request of the flow is logged before it leaves (invariant 2), with the device
// code and the tokens digested; the user code and the page to approve on are printed for the developer and never
// sent. The tokens go to the encrypted vault, then `wallet {rail, action: "linked", revoked: false}` is chained.
// unlink first asks the rail to revoke the token (a disclosed send, logged before it leaves), then deletes the vault
// file and chains `wallet {rail, action: "unlinked", revoked}`. `revoked` is true only when the rail acknowledged the
// revocation (HTTP 200, RFC 7009); otherwise the output says where to revoke it by hand (invariant 5).
// check (plan G12) asks the rail for recent orders, through the log, and says which ones no chained outcome names.
import { type Config, INTENT } from "../config/index.ts";
import { connectShop, type DeviceGrantPrompt, linkShop, openWalletSession, ShopLinkError, type WalletSession } from "../disclosure/index.ts";
import { approvalQr, type OneTapOptions } from "../gateway/index.ts";
import { openStore } from "../store/index.ts";
import { printable, printableLines } from "../ui/index.ts";
import {
  CHECK_CURRENCY,
  chainedOrderRefs,
  checkedEntry,
  checkOrders,
  deleteSecret,
  describeKeySource,
  hasSecret,
  isWalletRail,
  loadSecret,
  loadWalletKey,
  openCheckoutVault,
  saveSecret,
  vaultPath,
  type WalletCheck,
  WALLET_RAILS,
  type WalletRail,
  walletKeyWarnings,
  WalletVaultError,
} from "../wallet/index.ts";
import { CliError, type Io, line } from "./io.ts";
import { parseSince } from "./log-flags.ts";
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

/**
 * Links `rail` with Shop's device flow: exit 0 once the tokens are in the vault and the link is chained; 1 when one-tap
 * is unavailable (no client set: nothing is sent) or the flow ends without tokens (the line says how to try again).
 * A wallet already linked stays untouched until the new sign-in has succeeded; only then is it unlinked as `wallet
 * unlink` does (its token revoked by a logged send, a failed revocation warned about; its vault file deleted;
 * `wallet {action: "unlinked", revoked}` chained), before the new tokens are saved and the link chained.
 */
export async function walletLink(io: Io, config: Config, rail: string): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; known: ${WALLET_RAILS.join(", ")}`, 2);
  const name = RAIL_NAMES[rail];
  const clientId = config.wallet.shopClientId;
  if (clientId === null) {
    line(
      io.stderr,
      `intent: ${name} one-tap is unavailable until a registered ${name} client is set (INTENT_SHOP_CLIENT_ID); nothing was sent to ${name}, and purchases are handed off to the merchant's checkout`,
    );
    return 1;
  }
  warn(io, config);
  // The key comes first, so a setup that cannot keep the tokens (the Docker image without a key secret) stops before
  // anything is sent.
  const key = await loadWalletKey(config.wallet.key, { create: true });
  if (key === null) throw new CliError(`the wallet key ${describeKeySource(config.wallet.key)} could not be created`);
  const store = await openStore(config.dataDir, {
    onWait: leaseNotice((text) => {
      line(io.stderr, `intent: ${text}`);
    }, io.now),
  });
  try {
    const session = openWalletSession(store);
    const relink = await hasSecret(config.dataDir, rail);
    if (relink) line(io.stdout, `${name} wallet already linked: it stays as it is unless this new link succeeds`);
    const where = { mcpUrl: config.wallet.shopMcpUrl, authUrl: config.wallet.shopAuthUrl };
    let linked;
    try {
      linked = await linkShop(session, {
        ...where,
        clientId,
        show: (prompt) => {
          showPrompt(io, name, prompt);
        },
        sleep: io.sleep ?? delay,
        now: io.now ?? Date.now,
      });
    } catch (error) {
      if (!(error instanceof ShopLinkError)) throw error;
      const kept = relink ? `; the earlier link is kept unchanged` : "";
      line(io.stderr, `intent: ${name} wallet not linked: ${error.message}${kept}; run ${INTENT} wallet link ${rail} to try again`);
      return 1;
    }
    if (relink) {
      // The new tokens are in hand: now end the earlier link, revoking first as `wallet unlink` does.
      const revoked = await revoke(io, config, rail, session);
      await deleteSecret(config.dataDir, rail);
      await store.append("wallet", { rail, action: "unlinked", revoked });
      if (revoked) line(io.stdout, `${name} acknowledged the revocation of the earlier token (HTTP 200)`);
      else line(io.stderr, `intent: warning: the earlier ${name} token was not revoked; revoke it in your ${name} account settings (${RAIL_SETTING[rail]})`);
    }
    await saveSecret(config.dataDir, rail, key, linked.vaultText);
    let entry;
    try {
      entry = await store.append("wallet", { rail, action: "linked", revoked: false });
    } catch (error) {
      // No link may exist that the chain does not record: the tokens go with the failed entry.
      await deleteSecret(config.dataDir, rail);
      line(io.stderr, `intent: the ${name} link could not be recorded in the chain, so its tokens were deleted from this machine; run ${INTENT} wallet link ${rail} again once the chain is writable`);
      throw error;
    }
    line(io.stdout, printable(`${name} wallet linked: tokens kept in the encrypted vault ${vaultPath(config.dataDir, rail)} (entry #${String(entry.seq)})`));
    line(io.stdout, `Purchases are still handed off to the merchant's checkout for now: one-tap with ${name} is not yet wired to purchases`);
    if (!linked.refreshIssued) {
      const life = linked.expiresInS === null ? "" : ` (in about ${String(Math.max(1, Math.round(linked.expiresInS / 3600)))} h)`;
      line(io.stdout, `${name} issued no refresh token: when its access token expires${life}, run ${INTENT} wallet link ${rail} again`);
    }
    try {
      const account = await connectShop(session, { ...where, vaultText: linked.vaultText }).account();
      const budget = account.budgetRemaining;
      line(
        io.stdout,
        budget === null
          ? `${name} budget: ${name} reports none for this connection; set one in the ${name} app to cap what the gateway can spend`
          : `${name} budget left for the gateway: ${(budget.amountMinor / 100).toFixed(2)} ${budget.currency}`,
      );
    } catch (error) {
      // The link is made; only the budget line is missing. The message is the gateway's own, never Shop's text.
      line(io.stderr, printable(`intent: linked, but the ${name} budget could not be read: ${error instanceof Error ? error.message : String(error)}`));
    }
  } finally {
    await store.close();
  }
  return 0;
}

/** Where and how to approve the link: the page, the code to check there, and a QR code of the page at a terminal. */
function showPrompt(io: Io, name: string, prompt: DeviceGrantPrompt): void {
  line(io.stdout, `To link your ${name} account, open this page (on any device) and check that it shows the code ${printable(prompt.userCode)}:`);
  line(io.stdout, `  ${printable(prompt.verificationUri)}`);
  if (io.isTTY.stdout) line(io.stdout, printableLines(approvalQr(prompt.verificationUriComplete ?? prompt.verificationUri).text.trimEnd()));
  line(io.stdout, `Waiting for you to approve it in ${name} (up to ${String(Math.ceil(prompt.expiresInS / 60))} min; Ctrl-C stops)…`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    revoked = await revoke(io, config, rail, openWalletSession(store));
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
async function revoke(io: Io, config: Config, rail: WalletRail, session: WalletSession): Promise<boolean> {
  const name = RAIL_NAMES[rail];
  try {
    const key = await loadWalletKey(config.wallet.key, { create: false });
    const text = key === null ? null : await loadSecret(config.dataDir, rail, key);
    if (text === null) {
      line(io.stderr, `intent: the ${name} vault cannot be opened (no key), so its token cannot be revoked from here`);
      return false;
    }
    const wallet = connectShop(session, {
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

/** The period `wallet check` looks at when --since is not given. */
export const CHECK_DEFAULT_SINCE = "7d";

/**
 * `intent wallet check shop [--since 7d]` (plan G12): asks Shop for the account's recent orders (search_orders, a
 * disclosed send: logged before it leaves), keeps each order's reference, total, merchant origin and time only, and
 * lists the orders in the period that no `outcome` entry of this chain names. Chains `wallet {rail, action:
 * "checked", since, order_count, unmatched_count, unmatched_total_minor, complete}`: counts and a total, no order.
 * Exit 1, with nothing sent, when no Shop client is set or no wallet is linked.
 */
export async function walletCheck(io: Io, config: Config, rail: string, sinceText: string | undefined): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; known: ${WALLET_RAILS.join(", ")}`, 2);
  const name = RAIL_NAMES[rail];
  const since = parseSince(sinceText ?? CHECK_DEFAULT_SINCE, (io.now ?? Date.now)(), false);
  if (config.wallet.shopClientId === null) {
    line(io.stderr, `intent: ${name} is not set up: no registered ${name} client is set (INTENT_SHOP_CLIENT_ID); nothing was sent to ${name}`);
    return 1;
  }
  if (!(await hasSecret(config.dataDir, rail))) {
    line(io.stderr, `intent: no ${name} wallet is linked, so there is nothing to check; nothing was sent to ${name}. Link one with ${INTENT} wallet link ${rail}`);
    return 1;
  }
  warn(io, config);
  const key = await loadWalletKey(config.wallet.key, { create: false });
  if (key === null) throw new CliError(`the ${name} vault cannot be opened: its key file ${describeKeySource(config.wallet.key)} is missing; nothing was sent to ${name}`);
  const vaultText = await loadSecret(config.dataDir, rail, key);
  if (vaultText === null) throw new CliError(`no ${name} wallet is linked; nothing was sent to ${name}. Link one with ${INTENT} wallet link ${rail}`);
  const store = await openStore(config.dataDir, {
    onWait: leaseNotice((text) => {
      line(io.stderr, `intent: ${text}`);
    }, io.now),
  });
  let check: WalletCheck;
  let seq: number;
  try {
    const chained = chainedOrderRefs(store.entries());
    const wallet = connectShop(openWalletSession(store), { mcpUrl: config.wallet.shopMcpUrl, authUrl: config.wallet.shopAuthUrl, vaultText });
    check = checkOrders(await wallet.orders(), chained, since);
    seq = (await store.append("wallet", checkedEntry(rail, check))).seq;
  } finally {
    await store.close();
  }
  printCheck(io, name, check, seq);
  return 0;
}

/** The check in words: what Shop reported and what this chain names, never what Shop did (invariant 5). */
function printCheck(io: Io, name: string, check: WalletCheck, seq: number): void {
  const usd = (minor: number): string => `${(minor / 100).toFixed(2)} ${CHECK_CURRENCY}`;
  const orders = (n: number): string => `${String(n)} order${n === 1 ? "" : "s"}`;
  line(io.stdout, `${name} reported ${orders(check.orders.length)} since ${check.since}`);
  if (!check.complete) line(io.stdout, `${name} said more orders exist, or returned a full page of 50: these counts cover only the orders it returned`);
  line(io.stdout, `Matched to a purchase in this gateway's chain: ${String(check.orders.length - check.unmatched.length)}`);
  const untotalled = check.unmatchedUntotalled === 0 ? "" : ` (${String(check.unmatchedUntotalled)} without a ${CHECK_CURRENCY} total, not in the sum)`;
  const label = check.complete ? "Not matched" : "Not matched among the orders returned";
  line(io.stdout, `${label}: ${String(check.unmatched.length)}, totalling ${usd(check.unmatchedTotalMinor)}${untotalled}`);
  for (const order of check.unmatched) {
    const total = order.total === null ? "no total" : `${(order.total.amountMinor / 100).toFixed(2)} ${order.total.currency}`;
    const row = [order.createdAt ?? "no time", order.orderRef, total, order.merchantOrigin ?? "no merchant origin"];
    line(io.stdout, printable(`  ${row.join("  ")}`));
  }
  if (check.unmatched.length > 0) {
    line(
      io.stdout,
      `Not matched means no outcome in this log names the order; this check cannot say how it was placed (for example the ${name} app, another agent, ${name}'s own agent payments, or another gateway).`,
    );
  }
  line(io.stdout, `Recorded as entry #${String(seq)} (counts and the total only; no order details are kept)`);
}

function warn(io: Io, config: Config): void {
  for (const text of walletKeyWarnings(config.wallet)) line(io.stderr, `intent: warning: ${text}`);
}

/**
 * One-tap for `intent serve` (plan G7b): the linked Shop wallet behind the gateway's disclosed cloud, with its checkout
 * ids in the encrypted checkout vault (ADR-0019). Null, with nothing sent, when no Shop client is set, no wallet is
 * linked, or the vault does not open (said on stderr): purchases are then handed off.
 */
export async function oneTapFor(io: Io, config: Config, dataDir: string): Promise<OneTapOptions | null> {
  if (config.wallet.shopClientId === null || !(await hasSecret(dataDir, "shop"))) return null;
  try {
    warn(io, config);
    const key = await loadWalletKey(config.wallet.key, { create: false });
    const vaultText = key === null ? null : await loadSecret(dataDir, "shop", key);
    if (key === null || vaultText === null) return null;
    const checkoutIds = await openCheckoutVault(dataDir, "shop", key, io.now ?? Date.now);
    const where = { mcpUrl: config.wallet.shopMcpUrl, authUrl: config.wallet.shopAuthUrl };
    return { connect: (cloud) => connectShop(cloud, { ...where, vaultText, checkoutIds }) };
  } catch (error) {
    if (!(error instanceof WalletVaultError)) throw error;
    line(io.stderr, printable(`intent: Shop one-tap is unavailable, purchases are handed off: ${error.message}`));
    return null;
  }
}
