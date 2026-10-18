// `intent wallet status | link <rail> | unlink <rail>` (plans G6, G7a, G8). status says whether a wallet is linked
// and whether its vault opens, never the token; with a vault that opens, it reads the account once through the log (the
// budget left, or a connection removed in the Shop app). link runs Shop's OAuth device flow as the gateway's own Shop
// client (DEFAULT_SHOP_CLIENT_ID), or as the client INTENT_SHOP_CLIENT_ID names; it never falls back to another client
// by itself. Every request of the flow is logged before it leaves (invariant 2), with the device
// code and the tokens digested; the user code and the page to approve on are printed for the developer and never
// sent. The tokens go to the encrypted vault, then `wallet {rail, action: "linked", revoked: false}` is chained.
// unlink first asks the rail to revoke the refresh token and the access token (two disclosed sends, each logged before
// it leaves), then deletes the vault file and chains `wallet {rail, action: "unlinked", revoked}`. `revoked` is true
// only when the rail acknowledged both revocations (HTTP 200, RFC 7009). Revocation does not remove the connection in
// the Shop app (S1 step 12), so the output always says to remove it there (invariant 5).
// check (plan G12) asks the rail for recent orders, through the log, and says which ones no chained outcome names.
import { type Config, INTENT } from "../config/index.ts";
import { connectShop, DEFAULT_SHOP_CLIENT_ID, type DeviceGrantPrompt, linkedShopClientId, linkShop, openWalletSession, ShopLinkError, type WalletSession } from "../disclosure/index.ts";
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
  type WalletAccount,
  type WalletCheck,
  type WalletKey,
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
      // Opened to prove the vault is readable; the token itself is never printed.
      const vaultText = await loadSecret(config.dataDir, rail, key);
      line(io.stdout, printable(`${name} wallet: linked (encrypted vault ${file}; key from ${describeKeySource(config.wallet.key)})`));
      if (vaultText !== null) await accountStatus(io, config, rail, vaultText, key);
    } catch (error) {
      if (!(error instanceof WalletVaultError)) throw error;
      code = 1;
      line(io.stdout, printable(`${name} wallet: vault unreadable: ${error.message} (fix: ${fix})`));
    }
  }
  return code;
}

/**
 * What the rail says about the linked account right now: one get_account, logged before it leaves (invariant 2).
 * A connection the buyer removed in the Shop app (the token still answers, S1 step 12b) reads as not linked at Shop.
 */
async function accountStatus(io: Io, config: Config, rail: WalletRail, vaultText: string, key: WalletKey): Promise<void> {
  const name = RAIL_NAMES[rail];
  const store = await openStore(config.dataDir, {
    onWait: leaseNotice((text) => {
      line(io.stderr, `intent: ${text}`);
    }, io.now),
  });
  try {
    warnClientMismatch(io, config, vaultText);
    const wallet = connectShop(openWalletSession(store), { ...shopWhere(config), vaultText, saveVaultText: vaultSaver(config.dataDir, rail, key) });
    for (const text of accountLines(name, rail, await wallet.account())) line(io.stdout, text);
  } catch (error) {
    // The gateway's own words (vault, transport, disclosure, a fixed Shop label); never Shop's text or a token.
    line(io.stderr, printable(`intent: the ${name} account could not be read: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    await store.close();
  }
}

/** The account in words: removed, no budget (one tap unavailable) or the budget left. */
function accountLines(name: string, rail: WalletRail, account: WalletAccount): string[] {
  if (!account.connected) {
    return [
      `${name} connection: not linked at ${name}: ${name} answered that this connection can no longer read the account (as when it is removed in the ${name} app)`,
      `${name} one-tap: unavailable; run ${INTENT} wallet unlink ${rail}, then ${INTENT} wallet link ${rail}`,
    ];
  }
  const budget = account.budgetRemaining;
  if (budget === null) {
    return [`${name} budget: ${name} shows none for this connection, so one-tap is unavailable; turn on "Allow agent to pay" with a budget in the ${name} app`];
  }
  return [`${name} budget left for the gateway: ${(budget.amountMinor / 100).toFixed(2)} ${budget.currency}`];
}

const shopWhere = (config: Config): { mcpUrl: string | null; authUrl: string | null; clientId: string | null } => ({
  mcpUrl: config.wallet.shopMcpUrl,
  authUrl: config.wallet.shopAuthUrl,
  clientId: config.wallet.shopClientId,
});

/**
 * A linked wallet keeps the client it was linked with, for every call, refresh and revocation: INTENT_SHOP_CLIENT_ID
 * set later to another client is not used for it (only `wallet link` again changes it), and one line says so.
 */
function warnClientMismatch(io: Io, config: Config, vaultText: string): void {
  const explicit = config.wallet.shopClientId;
  const linked = linkedShopClientId(vaultText);
  if (explicit === null || linked === null || explicit === linked) return;
  line(
    io.stderr,
    printable(`intent: warning: this Shop wallet was linked as the client ${linked}, so INTENT_SHOP_CLIENT_ID (${explicit}) is not used for it; run ${INTENT} wallet link shop to link it as that client`),
  );
}

/** Keeps refreshed tokens in the wallet vault (S1: Shop issues a refresh token, and its access token lives an hour). */
const vaultSaver =
  (dataDir: string, rail: WalletRail, key: WalletKey) =>
  (text: string): Promise<void> =>
    saveSecret(dataDir, rail, key, text);

/**
 * Links `rail` with Shop's device flow as the gateway's own client, or INTENT_SHOP_CLIENT_ID's: exit 0 once the
 * tokens are in the vault and the link is chained; 1 when the flow ends without tokens (the line says how to try
 * again, or, when Shop refuses the client, names INTENT_SHOP_CLIENT_ID as the explicit opt-in: no other client is
 * ever tried by itself).
 * A wallet already linked stays untouched until the new sign-in has succeeded; only then is it unlinked as `wallet
 * unlink` does (its token revoked by a logged send, a failed revocation warned about; its vault file deleted;
 * `wallet {action: "unlinked", revoked}` chained), before the new tokens are saved and the link chained.
 */
export async function walletLink(io: Io, config: Config, rail: string): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; known: ${WALLET_RAILS.join(", ")}`, 2);
  const name = RAIL_NAMES[rail];
  const clientId = config.wallet.shopClientId;
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
    const where = shopWhere(config);
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
      if (error.code === "invalid_client") {
        line(io.stderr, `intent: ${name} wallet not linked: ${refusedClient(config)}${kept}`);
        return 1;
      }
      line(io.stderr, `intent: ${name} wallet not linked: ${error.message}${kept}; run ${INTENT} wallet link ${rail} to try again`);
      return 1;
    }
    if (relink) {
      // The new tokens are in hand: now end the earlier link, revoking first as `wallet unlink` does.
      const revoked = await revoke(io, config, rail, session, { relinking: true });
      await deleteSecret(config.dataDir, rail);
      await store.append("wallet", { rail, action: "unlinked", revoked });
      if (revoked) line(io.stdout, `${name} acknowledged the revocation of the earlier tokens (HTTP 200)`);
      else line(io.stderr, `intent: warning: the earlier ${name} tokens were not both revoked; remove the earlier connection in ${RAIL_SETTING[rail]}`);
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
      const account = await connectShop(session, { ...where, vaultText: linked.vaultText, saveVaultText: vaultSaver(config.dataDir, rail, key) }).account();
      for (const text of accountLines(name, rail, account)) line(io.stdout, text);
    } catch (error) {
      // The link is made; only the budget line is missing. The message is the gateway's own, never Shop's text.
      line(io.stderr, printable(`intent: linked, but the ${name} budget could not be read: ${error instanceof Error ? error.message : String(error)}`));
    }
  } finally {
    await store.close();
  }
  return 0;
}

/**
 * Shop refused the client the flow signed in as (invalid_client). The gateway tries no other client by itself: the
 * line names the explicit opt-in, INTENT_SHOP_CLIENT_ID, or, when that set the client, says to check it.
 */
function refusedClient(config: Config): string {
  return config.wallet.shopClientId !== null
    ? `Shop does not accept the client INTENT_SHOP_CLIENT_ID names (invalid_client); check its value`
    : `Shop does not accept the gateway's own client ${DEFAULT_SHOP_CLIENT_ID} (invalid_client), and no other client was tried; to sign in as another client (such as Shop's public client, for your own agent), set INTENT_SHOP_CLIENT_ID explicitly`;
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
  if (revoked) line(io.stdout, `${name} acknowledged the revocation of the gateway's refresh and access tokens (HTTP 200)`);
  else line(io.stderr, `intent: the ${name} tokens were not both revoked by this gateway`);
  // Revoking the tokens does not remove the connection in the Shop app (S1 step 12): only the buyer can.
  line(io.stdout, `To finish, remove the connection in ${RAIL_SETTING[rail]}: revoking the tokens does not remove it there`);
  return 0;
}

/**
 * Asks the rail to revoke the vault's refresh and access tokens; true only when it acknowledged both. A vault that does not open, holds no
 * token, or names no client, and every failure of the send, give false with the reason on stderr (never the token).
 */
async function revoke(io: Io, config: Config, rail: WalletRail, session: WalletSession, options: { relinking?: boolean } = {}): Promise<boolean> {
  const name = RAIL_NAMES[rail];
  try {
    const key = await loadWalletKey(config.wallet.key, { create: false });
    const text = key === null ? null : await loadSecret(config.dataDir, rail, key);
    if (text === null) {
      line(io.stderr, `intent: the ${name} vault cannot be opened (no key), so its token cannot be revoked from here`);
      return false;
    }
    // Relinking is how the client changes: the earlier link is revoked as the client it was linked with, with no warning.
    if (options.relinking !== true) warnClientMismatch(io, config, text);
    const wallet = connectShop(session, { ...shopWhere(config), vaultText: text });
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
 * Exit 1, with nothing sent, when no wallet is linked.
 */
export async function walletCheck(io: Io, config: Config, rail: string, sinceText: string | undefined): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; known: ${WALLET_RAILS.join(", ")}`, 2);
  const name = RAIL_NAMES[rail];
  const since = parseSince(sinceText ?? CHECK_DEFAULT_SINCE, (io.now ?? Date.now)(), false);
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
    warnClientMismatch(io, config, vaultText);
    const wallet = connectShop(openWalletSession(store), { ...shopWhere(config), vaultText, saveVaultText: vaultSaver(config.dataDir, rail, key) });
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
 * ids in the encrypted checkout vault (ADR-0019). Null, with nothing sent, when no wallet is linked or the vault does
 * not open (said on stderr): purchases are then handed off.
 */
export async function oneTapFor(io: Io, config: Config, dataDir: string): Promise<OneTapOptions | null> {
  if (!(await hasSecret(dataDir, "shop"))) return null;
  try {
    warn(io, config);
    const key = await loadWalletKey(config.wallet.key, { create: false });
    const vaultText = key === null ? null : await loadSecret(dataDir, "shop", key);
    if (key === null || vaultText === null) return null;
    const checkoutIds = await openCheckoutVault(dataDir, "shop", key, io.now ?? Date.now);
    warnClientMismatch(io, config, vaultText);
    const where = shopWhere(config);
    // The search runs in the gateway, against Shop (G5, ADR-0021): Intent Cloud is sent nothing for it.
    return { connect: (cloud) => connectShop(cloud, { ...where, vaultText, checkoutIds, saveVaultText: vaultSaver(dataDir, "shop", key) }), searchInGateway: true };
  } catch (error) {
    if (!(error instanceof WalletVaultError)) throw error;
    line(io.stderr, printable(`intent: Shop one-tap is unavailable, purchases are handed off: ${error.message}`));
    return null;
  }
}
