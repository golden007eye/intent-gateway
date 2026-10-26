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
// link --start / --finish split the link in two processes, for an agent's shell that shows output only when a command
// ends; status --wait-budget reads the account through the log until Shop shows agent payments on.
import { type Config, ConfigError, INTENT } from "../config/index.ts";
import { usableCurrencyTable } from "../contract/index.ts";
import {
  CloudNetworkError,
  CloudResponseError,
  connectShop,
  DEFAULT_SHOP_CLIENT_ID,
  type DeviceGrantPrompt,
  finishShopLink,
  type LinkedShopVault,
  linkedShopClientId,
  linkShop,
  openPendingShopLink,
  openWalletSession,
  type PendingShopLink,
  ShopLinkError,
  ShopPendingError,
  SHOP_CONNECTIONS_URL,
  SHOP_PUBLIC_CLIENT_ID,
  ShopTransportError,
  shopVaultHasToken,
  startShopLink,
  type WalletSession,
} from "../disclosure/index.ts";
import { approvalQr, type OneTapOptions } from "../gateway/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { printable, printableLines } from "../ui/index.ts";
import {
  CHECK_CURRENCY,
  chainedOrderRefs,
  checkedEntry,
  checkOrders,
  claimPendingGrant,
  deleteSecret,
  type GrantClaim,
  describeKeySource,
  hasSecret,
  isWalletRail,
  loadSecret,
  loadWalletKey,
  openCheckoutVault,
  savePendingGrant,
  saveSecret,
  vaultPath,
  type WalletAccount,
  type WalletCheck,
  type WalletKey,
  WALLET_RAILS,
  type WalletRail,
  walletKeyWarnings,
  type WalletMoney,
  WalletRailError,
  WalletVaultError,
  type BudgetRenewal,
} from "../wallet/index.ts";
import { capsIn, capText, type Ceilings, type Spend } from "../policy/index.ts";
import { verifyStatement } from "../trust/index.ts";
import { activePolicy, cloudFor, rootKeys } from "./setup.ts";
import { CliError, type Io, line } from "./io.ts";
import { parseSince } from "./log-flags.ts";
import { leaseNotice } from "./waiting.ts";

const RAIL_NAMES: Readonly<Record<WalletRail, string>> = { shop: "Shop" };
/** Where the developer revokes the gateway's access by hand. */
const RAIL_SETTING: Readonly<Record<WalletRail, string>> = { shop: "the Shop app: Account › Connections" };

/** How the Shop app names a connection: Shop's public client shows as "Personal Agent" (S1), any other as "intent". */
const connectionName = (clientId: string | null): string => (clientId === SHOP_PUBLIC_CLIENT_ID ? "Personal Agent" : "intent");

/**
 * Where the developer changes agent payments, from what this run knows: the connections page Shop named (printed only
 * when it is https on shop.app), and the connection by the client recorded in the vault. `page` undefined: no
 * answer from Shop yet, so S1's page; null: Shop named a page elsewhere, so none is printed.
 */
interface AgentPaymentsPlace {
  readonly page: string | null | undefined;
  readonly connection: string;
}

/** "open <page>, tap <connection>" (or "tap <connection>" without a page to print). */
const openAndTap = (place: AgentPaymentsPlace): string => {
  const page = place.page === undefined ? SHOP_CONNECTIONS_URL : place.page;
  return `${page === null ? "" : `open ${page}, `}tap ${place.connection}`;
};

/** Exit 0 when every wallet is linked and opens or is not linked; 1 when a vault does not open. */
export async function walletStatus(io: Io, config: Config): Promise<number> {
  warn(io, config);
  let code = 0;
  for (const rail of WALLET_RAILS) {
    const name = RAIL_NAMES[rail];
    const file = vaultPath(config.dataDir, rail);
    if (!(await hasSecret(config.dataDir, rail))) {
      // From an agent's shell (no terminal) the link that works is the two-part one.
      line(io.stdout, `${name} wallet: not linked; link it with ${INTENT} wallet link ${rail}${io.isTTY.stdin && io.isTTY.stdout ? "" : " --start"}`);
      continue;
    }
    const fix = `unlink it with ${INTENT} wallet unlink ${rail} and link it again`;
    try {
      const key = await loadWalletKey(config.wallet.key, { create: false });
      if (key === null) throw new WalletVaultError("no_key", `its key file ${describeKeySource(config.wallet.key)} is missing`);
      // Opened to prove the vault is readable; the token itself is never printed.
      const vaultText = await loadSecret(config.dataDir, rail, key);
      line(io.stdout, printable(`${name} wallet: linked (encrypted vault ${file}; key from ${describeKeySource(config.wallet.key)})`));
      // The amount left could not be checked (the ceilings were not read): said, and exit 1.
      if (vaultText !== null && !(await accountStatus(io, config, rail, vaultText, key))) code = 1;
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
async function accountStatus(io: Io, config: Config, rail: WalletRail, vaultText: string, key: WalletKey): Promise<boolean> {
  const name = RAIL_NAMES[rail];
  const store = await openStore(config.dataDir, {
    onWait: leaseNotice((text) => {
      line(io.stderr, `intent: ${text}`);
    }, io.now),
  });
  try {
    warnClientMismatch(io, config, vaultText);
    const wallet = connectShop(openWalletSession(store), { ...shopWhere(config), vaultText, saveVaultText: vaultSaver(config.dataDir, rail, key) });
    const account = await wallet.account();
    for (const text of accountLines(name, rail, account)) line(io.stdout, text);
    // Only a budget with a limit can be low: the ceilings are read for nothing else.
    if (account.connected && account.budgetLimit !== null && account.budgetRemaining !== null) {
      let advise: ((store: Store) => Promise<Adviser>) | null = null;
      try {
        advise = await budgetAdviser(io, config);
      } catch (error) {
        // The account was read; only the comparison with the policy is missing. Never blamed on Shop.
        line(io.stderr, printable(`intent: the ${name} account was read, but the agent-payments check was skipped: the policy did not load: ${error instanceof Error ? error.message : String(error)}`));
      }
      if (advise !== null) {
        const adviser = await advise(store);
        if (adviser.unread !== undefined) {
          line(io.stderr, printable(`intent: ${adviser.unread}`));
          return false;
        }
        const advice = adviser(account.budgetRemaining.currency);
        if (typeof advice === "string") line(io.stdout, printable(`Note: ${advice}`));
        else if (agentPayments(account, adviser) === "low") lowLines(io, account, advice, { page: account.manageUrl, connection: connectionName(linkedShopClientId(vaultText)) });
      }
    }
  } catch (error) {
    // The gateway's own words (vault, transport, disclosure, a fixed Shop label); never Shop's text or a token.
    line(io.stderr, printable(`intent: the ${name} account could not be read: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    await store.close();
  }
  return true;
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
  return [`${name} agent payments left for the gateway: ${amountText(budget)}`];
}

/** How often `wallet status --wait-budget` reads the account, and the longest it waits by default (and at most). */
export const BUDGET_POLL_MS = 5000;
export const BUDGET_WAIT_MAX_S = 600;
/** The longest pause between two reads after errors (each error doubles the pause, from BUDGET_POLL_MS). */
const BUDGET_BACKOFF_MAX_MS = 60_000;
/** The suggested Shop limit is at most this many weeks of the weekly cap. */
const BUDGET_WEEKS = 4;
const RENEWAL_WORDS: Readonly<Record<BudgetRenewal, string>> = { daily: "per day", weekly: "per week", monthly: "per month", yearly: "per year" };

/**
 * ISO 4217 currencies whose minor unit is not a hundredth (JPY has none, KWD has thousandths); every other has two
 * digits. A table, not Intl: CLDR's display digits differ from ISO 4217 for some (IQD), and Shop counts ISO minor units.
 */
const MINOR_DIGITS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"].map((c) => [c, 0])),
  ...Object.fromEntries(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].map((c) => [c, 3])),
  CLF: 4,
  UYW: 4,
};

/** Integer minor units as a decimal in the currency's own exponent: 1500 JPY is `1500`, 1500 KWD `1.500`, 1500 USD `15.00`. */
function decimalText(money: WalletMoney): string {
  const digits = MINOR_DIGITS[money.currency] ?? 2;
  const sign = money.amountMinor < 0 ? "-" : "";
  const text = String(Math.abs(money.amountMinor)).padStart(digits + 1, "0");
  return digits === 0 ? `${sign}${text}` : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** An amount with its currency code: `15.00 USD`, `1500 JPY`. */
const amountText = (money: WalletMoney): string => `${decimalText(money)} ${money.currency}`;

/** An amount Shop shows: `$15.00` in USD, `CAD 15.00` otherwise. */
const moneyText = (money: WalletMoney): string => (money.currency === "USD" ? `$${decimalText(money)}` : `${money.currency} ${decimalText(money)}`);

/** An amount left in a sentence: `$6.02` or `$5` in USD, `CAD 6.00` otherwise. */
const leftText = (money: WalletMoney | null): string => (money === null || money.currency === "USD" ? capText(money?.amountMinor ?? 0, "USD") : moneyText(money));

/**
 * The largest Shop limit the gateway suggests (4 × the policy's weekly cap, the weekly ceiling when lower or unset,
 * and never below one purchase), and the least a budget must have left to pay one purchase: the smallest of the
 * policy's per-order, per-day and weekly caps and the per-order ceiling (the schema lets per-order exceed weekly). All
 * in one currency's minor units: the caps put in it by Intent Cloud's ceilings (capsIn), the ceilings its own.
 */
interface BudgetAdvice {
  readonly currency: string;
  readonly maxMinor: number;
  readonly purchaseMinor: number;
  readonly weeklyMinor: number;
  readonly basis: string;
}

/**
 * The advice in a currency, or the one line that says why there is none in it. `unread`: the ceilings could not be
 * read at all, in one line ending "try again"; then nothing about the amount left may be said, low or on.
 */
type Adviser = ((currency: string) => BudgetAdvice | string) & { readonly unread?: string };

/**
 * Loads the policy now (a policy that does not load is the caller's error); the ceilings are read from Intent Cloud's
 * meta (one disclosed GET, logged before it leaves) on the first advice asked, once per command.
 */
async function budgetAdviser(io: Io, config: Config): Promise<(store: Store) => Promise<Adviser>> {
  const { policy } = await activePolicy(config.policyPath);
  let adviser: Promise<Adviser> | undefined;
  return (store) => {
    adviser ??= readCeilings(io, config, store).then((read): Adviser =>
      typeof read === "string" ? Object.assign(() => read, { unread: read }) : (currency: string) => adviceIn(policy.spend, currency, read),
    );
    return adviser;
  };
}

/**
 * Intent Cloud's ceilings from `GET /v1/meta`, or why they could not be read, in words. Never guessed. As `intent
 * doctor` does, the key statement is read and chained after the meta, so `intent verify` can check the meta's receipt.
 */
async function readCeilings(io: Io, config: Config, store: Store): Promise<Ceilings | string> {
  const host = config.cloud.url;
  const unread = (why: string): string => `the ceilings Intent Cloud returns could not be read from ${host} (${why}), so the amount left was not checked; try again`;
  const now = io.now ?? Date.now;
  try {
    const pins = await rootKeys(config, { contacts: true });
    const cloud = cloudFor(io, store, host, { keySet: () => null, now });
    const meta = await cloud.meta();
    if (!meta.ok) return unread(`it answered HTTP ${String(meta.status)}`);
    const statement = await cloud.keyStatement();
    if (!statement.ok) return unread(`its key statement answered HTTP ${String(statement.status)}`);
    if (!verifyStatement(statement.body, pins, new Date(now())).ok) return unread("its key statement does not verify against the pinned root key");
    await store.append("keys", { statement: statement.body });
    const table = meta.body.currency_table;
    if (!usableCurrencyTable(table)) return unread("its meta holds no valid currency table");
    return table.currencies;
  } catch (error) {
    // The disclosure log's own failures stop the command (invariant 2); a host that cannot be reached is said.
    if (error instanceof CloudNetworkError || error instanceof CloudResponseError || error instanceof ConfigError) return unread(error.message);
    throw error;
  }
}

function adviceIn(spend: Spend, currency: string, ceilings: Ceilings): BudgetAdvice | string {
  const ceiling = ceilings[currency];
  const caps = capsIn(spend, currency, ceilings);
  if (ceiling === undefined || caps === null) return `Shop shows this budget in ${currency}, for which the currency table Intent Cloud returns gives no usable ceiling, so the gateway suggests no amount`;
  const cap = caps.per_week_usd;
  const weeklyMinor = Math.min(cap ?? ceiling.week, ceiling.week);
  const basis = cap !== undefined && cap < ceiling.week ? "your policy's weekly cap" : "the weekly ceiling Intent Cloud enforces";
  const purchaseMinor = Math.min(ceiling.order, weeklyMinor, caps.per_order_usd ?? Infinity, caps.per_day_usd ?? Infinity);
  return { currency, maxMinor: Math.max(BUDGET_WEEKS * weeklyMinor, purchaseMinor), purchaseMinor, weeklyMinor, basis };
}

/**
 * What Shop shows for agent payments: `off` (no budget with a limit), `low` (on, with less left than one purchase may
 * cost), `on`. A budget the gateway has no advice for (no ceilings read, or none in its currency) counts as on.
 */
type AgentPayments = "off" | "low" | "on";

function agentPayments(account: WalletAccount, adviser: Adviser): AgentPayments {
  const { budgetLimit: limit, budgetRemaining: left } = account;
  if (limit === null || left === null) return "off";
  const advice = adviser(left.currency);
  return typeof advice !== "string" && left.amountMinor < advice.purchaseMinor ? "low" : "on";
}

/**
 * When the low amount left comes from spending this period under a limit already at or above the suggestion, raising
 * it is not the advice: "until Shop renews it …" (at Shop's renews_at when it gives one). Null otherwise.
 */
function untilRenewal(account: WalletAccount, advice: BudgetAdvice): string | null {
  const limit = account.budgetLimit;
  if (limit === null || limit.amount.currency !== advice.currency || limit.amount.amountMinor < advice.maxMinor) return null;
  if (limit.renewsAt !== null) return `until Shop renews it at ${limit.renewsAt}`;
  return limit.renewal === null ? "until Shop renews it" : `until Shop renews it (${RENEWAL_WORDS[limit.renewal]})`;
}

/**
 * The low case in two lines: the connections page (as openAndTap picks it; none when Shop named one elsewhere), then
 * how much is left and the suggested limit. With a limit already at the suggestion, one line: wait for the renewal.
 */
function lowLines(io: Io, account: WalletAccount, advice: BudgetAdvice, place: AgentPaymentsPlace): void {
  const until = untilRenewal(account, advice);
  const max = capText(advice.maxMinor, advice.currency);
  if (until !== null) {
    line(
      io.stdout,
      printable(`Agent payments are on, but only ${leftText(account.budgetRemaining)} is left ${until}; the limit is already at least the suggested ${max}, so wait for that renewal rather than raising it.`),
    );
    return;
  }
  const page = place.page === undefined ? SHOP_CONNECTIONS_URL : place.page;
  if (page !== null) line(io.stdout, printable(page));
  line(io.stdout, `Agent payments are on, but only ${leftText(account.budgetRemaining)} is left; raise it to ${max}.`);
}

/**
 * When Shop shows agent payments on (a budget with a limit): one line with the limit, its period as Shop names it
 * and the amount left, plus a warning when the limit is above the advice, or a note when there is no advice in its
 * currency; true. When it is on but low: the low lines instead; true. False, printing nothing, when it is off.
 */
function agentPaymentsOn(io: Io, rail: WalletRail, account: WalletAccount, adviser: Adviser, place: AgentPaymentsPlace): boolean {
  const limit = account.budgetLimit;
  const state = agentPayments(account, adviser);
  if (state === "off" || limit === null || account.budgetRemaining === null) return false;
  const advice = adviser(limit.amount.currency);
  if (state === "low" && typeof advice !== "string") {
    lowLines(io, account, advice, place);
    return true;
  }
  const per = limit.renewal === null ? " limit" : ` ${RENEWAL_WORDS[limit.renewal]}`;
  line(io.stdout, `Agent payments on: ${moneyText(limit.amount)}${per}, ${moneyText(account.budgetRemaining)} left`);
  if (typeof advice === "string") {
    line(io.stdout, printable(`Note: ${advice}`));
  } else if (limit.amount.amountMinor > advice.maxMinor) {
    const { currency } = advice;
    line(
      io.stderr,
      `intent: warning: this limit is above ${moneyText({ amountMinor: advice.maxMinor, currency })}, ${String(BUDGET_WEEKS)} × ${advice.basis} (${capText(advice.weeklyMinor, currency)}); the ${RAIL_NAMES[rail]} budget is the only hard stop, so lower it: ${openAndTap(place)}`,
    );
  }
  return true;
}

/**
 * `intent wallet status --wait-budget [--timeout <s>]`: reads the linked account (get_account, logged before each
 * send, invariant 2) every 5 s, and every 10 s, 20 s, … up to a minute after errors, until Shop shows an agent budget
 * with a limit, for at most `timeoutS` (600 by default and at most). Exit 0 with one line once it does, plus a
 * warning when the limit is above 4 × the policy's weekly cap (or of the preview ceiling, whichever is lower);
 * 1 on timeout, when no wallet is linked, or at once when Shop says the connection is gone or refuses the token.
 */
export async function walletWaitBudget(io: Io, config: Config, timeoutText: string | undefined): Promise<number> {
  const rail: WalletRail = "shop";
  const name = RAIL_NAMES[rail];
  const timeoutS = timeoutText === undefined ? BUDGET_WAIT_MAX_S : Number(timeoutText);
  if (!/^[0-9]+$/.test(timeoutText ?? "0") || !Number.isSafeInteger(timeoutS) || timeoutS < 1 || timeoutS > BUDGET_WAIT_MAX_S) {
    throw new CliError(`--timeout takes whole seconds from 1 to ${String(BUDGET_WAIT_MAX_S)}`, 2);
  }
  if (!(await hasSecret(config.dataDir, rail))) {
    line(io.stderr, `intent: no ${name} wallet is linked, so there are no agent payments to wait for; nothing was sent to ${name}. Link one with ${INTENT} wallet link ${rail} --start`);
    return 1;
  }
  warn(io, config);
  const advise = await budgetAdviser(io, config);
  const key = await loadWalletKey(config.wallet.key, { create: false });
  if (key === null) throw new CliError(`the ${name} vault cannot be opened: its key file ${describeKeySource(config.wallet.key)} is missing; nothing was sent to ${name}`);
  const vaultText = await loadSecret(config.dataDir, rail, key);
  if (vaultText === null) throw new CliError(`no ${name} wallet is linked; nothing was sent to ${name}. Link one with ${INTENT} wallet link ${rail} --start`);
  // Waiting cannot put a token in the vault: say so at once rather than retrying for the whole timeout.
  if (!shopVaultHasToken(vaultText)) {
    line(io.stderr, `intent: the ${name} wallet vault holds no token, so there are no agent payments to read; nothing was sent to ${name}. Run ${INTENT} wallet unlink ${rail}, then ${INTENT} wallet link ${rail} --start`);
    return 1;
  }
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? delay;
  const deadline = now() + timeoutS * 1000;
  const relink = `run ${INTENT} wallet unlink ${rail}, then ${INTENT} wallet link ${rail} --start`;
  const store = await openLinkStore(io, config);
  try {
    warnClientMismatch(io, config, vaultText);
    const wallet = connectShop(openWalletSession(store), { ...shopWhere(config), vaultText, saveVaultText: vaultSaver(config.dataDir, rail, key) });
    let pause = BUDGET_POLL_MS;
    let page: string | null | undefined;
    const connection = connectionName(linkedShopClientId(vaultText));
    let lastError: string | null = null;
    // The amount left while it is too low for one purchase, said once (the first time), then waited out.
    let low: WalletAccount | null = null;
    // The last account read, for the timeout's words.
    let seen: WalletAccount | null = null;
    // The advice, read (with Intent Cloud's ceilings) once Shop shows a budget; none before.
    let adviser: Adviser = () => "";
    const adviceFor = (money: WalletMoney | null): BudgetAdvice | null => {
      const advice = money === null ? "" : adviser(money.currency);
      return typeof advice === "string" ? null : advice;
    };
    for (;;) {
      try {
        const account = await wallet.account();
        lastError = null;
        pause = BUDGET_POLL_MS;
        page = account.manageUrl;
        seen = account;
        if (!account.connected) {
          line(io.stderr, `intent: ${name} answered that this connection can no longer read the account (as when it is removed in the ${name} app); ${relink}`);
          return 1;
        }
        if (account.budgetRemaining !== null) adviser = await advise(store);
        if (adviser.unread !== undefined) {
          line(io.stderr, printable(`intent: ${adviser.unread}`));
          return 1;
        }
        const state = agentPayments(account, adviser);
        if (state === "on" && agentPaymentsOn(io, rail, account, adviser, { page, connection })) return 0;
        const advice = adviceFor(account.budgetRemaining);
        if (state === "low" && low === null && advice !== null) lowLines(io, account, advice, { page, connection });
        low = state === "low" ? account : null;
      } catch (error) {
        // A refused token (refresh refused too): the link was revoked; waiting cannot change that.
        if (error instanceof WalletRailError && error.httpStatus === 401) {
          line(io.stderr, `intent: ${name} refused this gateway's token (the link was revoked or removed); ${relink}`);
          return 1;
        }
        // Only Shop's own failures are waited out; a log that cannot be written stops the wait (invariant 2).
        if (!(error instanceof WalletRailError) && !(error instanceof ShopTransportError)) throw error;
        lastError = error.message;
        pause = Math.min(pause * 2, BUDGET_BACKOFF_MAX_MS);
      }
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(pause, left));
      if (now() >= deadline) break;
    }
    const lowAdvice = low === null ? null : adviceFor(low.budgetRemaining);
    const lowUntil = low === null || lowAdvice === null ? null : untilRenewal(low, lowAdvice);
    if (low !== null && lowAdvice !== null && lastError === null && lowUntil !== null) {
      line(
        io.stderr,
        printable(
          `intent: ${name} agent payments are still low after ${String(timeoutS)} s: only ${leftText(low.budgetRemaining)} is left ${lowUntil}, less than one purchase may cost (${capText(lowAdvice.purchaseMinor, lowAdvice.currency)}); the limit is already at least ${capText(lowAdvice.maxMinor, lowAdvice.currency)}, so wait for that renewal, then run ${INTENT} wallet status --wait-budget again`,
        ),
      );
      return 1;
    }
    if (low !== null && lowAdvice !== null && lastError === null) {
      line(
        io.stderr,
        printable(
          `intent: ${name} agent payments are still low after ${String(timeoutS)} s: only ${leftText(low.budgetRemaining)} is left, less than one purchase may cost (${capText(lowAdvice.purchaseMinor, lowAdvice.currency)}); ${openAndTap({ page, connection })}, raise it to ${capText(lowAdvice.maxMinor, lowAdvice.currency)}, then run ${INTENT} wallet status --wait-budget again`,
        ),
      );
      return 1;
    }
    const unlimited = lastError === null ? seen?.budgetLimit === null && seen.budgetRemaining !== null ? seen.budgetRemaining : null : null;
    if (unlimited !== null) {
      const advice = adviceFor(unlimited);
      const most = advice === null ? "set a limit" : `set a limit of at most ${capText(advice.maxMinor, advice.currency)}`;
      // A budget left but no limit: Shop shows an amount, yet the gateway needs the limit as the hard stop.
      line(
        io.stderr,
        printable(
          `intent: ${name} shows ${moneyText(unlimited)} left for this connection after ${String(timeoutS)} s, but no limit on it, so the gateway does not count agent payments as on: ${openAndTap({ page, connection })}, ${most} under Allow agent to pay for me, then run ${INTENT} wallet status --wait-budget again`,
        ),
      );
      return 1;
    }
    const why = lastError === null ? `${name} shows no agent payments for this connection` : `the last read failed: ${lastError}`;
    line(
      io.stderr,
      printable(`intent: no ${name} agent payments seen after ${String(timeoutS)} s (${why}): ${openAndTap({ page, connection })}, turn on Allow agent to pay for me, then run ${INTENT} wallet status --wait-budget again`),
    );
    return 1;
  } finally {
    await store.close();
  }
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

/** How `wallet link` runs: the whole device flow in one process, or its two halves (--start, then --finish). */
export type LinkMode = "full" | "start" | "finish";

/**
 * Links `rail` with Shop's device flow as the gateway's own client, or INTENT_SHOP_CLIENT_ID's: exit 0 once the
 * tokens are in the vault and the link is chained; 1 when the flow ends without tokens (the line says how to try
 * again, or, when Shop refuses the client, names INTENT_SHOP_CLIENT_ID as the explicit opt-in: no other client is
 * ever tried by itself).
 * A wallet already linked stays untouched until the new sign-in has succeeded; only then is it unlinked as `wallet
 * unlink` does (its token revoked by a logged send, a failed revocation warned about; its vault file deleted;
 * `wallet {action: "unlinked", revoked}` chained), before the new tokens are saved and the link chained.
 *
 * `start` sends the device authorization only (logged first), seals the pending grant in the wallet vault, prints
 * one line (the page, the code, the expiry) and returns at once. `finish` claims that grant and polls with it, as
 * `full` does after printing; every terminal answer (tokens, a refusal, an expiry) deletes the grant. Neither ever
 * prints the device code: an agent's shell shows output only when a command ends, so the two halves let the
 * developer see the code while the sign-in is still open.
 */
export async function walletLink(io: Io, config: Config, rail: string, mode: LinkMode = "full"): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; the only wallet is ${WALLET_RAILS.join(", ")}`, 2);
  warn(io, config);
  if (mode === "finish") return finishLink(io, config, rail);
  // The key comes first, so a setup that cannot keep the tokens (the Docker image without a key secret) stops before
  // anything is sent.
  const key = await loadWalletKey(config.wallet.key, { create: true });
  if (key === null) throw new CliError(`the wallet key ${describeKeySource(config.wallet.key)} could not be created`);
  const name = RAIL_NAMES[rail];
  const store = await openLinkStore(io, config);
  try {
    const session = openWalletSession(store);
    if (mode === "start") return await startLink(io, config, rail, session, key);
    const relink = await hasSecret(config.dataDir, rail);
    if (relink) line(io.stdout, `${name} wallet already linked: it stays as it is unless this new link succeeds`);
    let linked;
    try {
      linked = await linkShop(session, {
        ...shopWhere(config),
        show: (prompt) => {
          showPrompt(io, name, prompt);
        },
        sleep: io.sleep ?? delay,
        now: io.now ?? Date.now,
      });
    } catch (error) {
      if (!(error instanceof ShopLinkError)) throw error;
      notLinked(io, config, rail, error, relink, `${INTENT} wallet link ${rail}`);
      return 1;
    }
    await keepLink(io, config, rail, { store, session, key, linked, relink });
  } finally {
    await store.close();
  }
  return 0;
}

const openLinkStore = (io: Io, config: Config): Promise<Store> =>
  openStore(config.dataDir, {
    onWait: leaseNotice((text) => {
      line(io.stderr, `intent: ${text}`);
    }, io.now),
  });

/** The device authorization of `--start`, then the sealed pending grant and the one line to act on. */
async function startLink(io: Io, config: Config, rail: WalletRail, session: WalletSession, key: WalletKey): Promise<number> {
  const name = RAIL_NAMES[rail];
  let started;
  try {
    started = await startShopLink(session, { ...shopWhere(config), now: io.now ?? Date.now });
  } catch (error) {
    if (!(error instanceof ShopLinkError)) throw error;
    notLinked(io, config, rail, error, false, `${INTENT} wallet link ${rail} --start`);
    return 1;
  }
  const { replaced } = await savePendingGrant(config.dataDir, rail, key, started.pendingText);
  // Only what this process did: the earlier grant left the vault. Its code may still be redeemed by a --finish that
  // already holds it, so nothing is said about the code itself (invariant 5).
  if (replaced) line(io.stdout, `Replaced the ${name} sign-in that was pending: it is no longer pending here; the next --finish waits for the code below`);
  const { prompt } = started;
  const page = prompt.verificationUriComplete ?? prompt.verificationUri;
  line(
    io.stdout,
    printable(`Open ${page} and approve the code ${prompt.userCode} in ${name} before ${isoSeconds(started.expiresAt)}, then run ${INTENT} wallet link ${rail} --finish`),
  );
  return 0;
}

/** An instant as `2026-10-18T14:05:00Z`. */
const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * `--finish`: claims the pending grant (so two finishes never both redeem it), checks it against the settings in
 * effect, polls until Shop answers, and keeps the tokens as a full link does. The grant is deleted on every
 * terminal answer and put back when the finish stops for any other reason (a log that cannot be written, a network
 * failure), so the next --finish can go on with it.
 */
async function finishLink(io: Io, config: Config, rail: WalletRail): Promise<number> {
  const name = RAIL_NAMES[rail];
  const startAgain = `run ${INTENT} wallet link ${rail} --start`;
  const fail = (text: string): number => {
    line(io.stderr, printable(`intent: ${name} wallet not linked: ${text}`));
    return 1;
  };
  const key = await loadWalletKey(config.wallet.key, { create: false });
  if (key === null) return fail(`no ${name} sign-in is pending (no wallet key yet); ${startAgain} first`);
  let claim: GrantClaim;
  try {
    claim = await claimPendingGrant(config.dataDir, rail, key);
  } catch (error) {
    if (!(error instanceof WalletVaultError)) throw error;
    // Never the vault's own advice (unlink and link again): it is the pending sign-in that does not open.
    return fail(`the pending ${name} sign-in does not open with the wallet key ${describeKeySource(config.wallet.key)} (${error.reason}), so it was deleted; ${startAgain} for a new one`);
  }
  if (claim.kind === "none") return fail(`no ${name} sign-in is pending; ${startAgain} first`);
  if (claim.kind === "busy") return fail(`another ${INTENT} wallet link ${rail} --finish (pid ${String(claim.pid)}) is already waiting for this sign-in`);
  const { grant } = claim;
  const now = io.now ?? Date.now;
  const where = shopWhere(config);
  let pending: PendingShopLink;
  try {
    pending = openPendingShopLink(grant.text, where);
  } catch (error) {
    if (!(error instanceof ShopPendingError)) {
      await grant.release();
      throw error;
    }
    if (error.reason === "unreadable") {
      await grant.discard();
      return fail(`${error.message}, so it was deleted; nothing was sent to ${name}. ${startAgain} for a new one`);
    }
    // Nothing was sent; the grant stays, so restoring the settings lets --finish go on, and --start replaces it.
    await grant.release();
    return fail(`${error.message}; nothing was sent to ${name}. Restore that setting and run --finish again, or ${startAgain} to replace it`);
  }
  if (now() >= pending.expiresAt) {
    await grant.discard();
    return fail(`the pending sign-in code expired at ${isoSeconds(pending.expiresAt)}; nothing was sent to ${name}. ${startAgain} for a new one`);
  }
  let terminal = false;
  let failed = false;
  // 1 when the link is made but the amount left could not be checked (the ceilings were not read).
  let code = 0;
  try {
    const store = await openLinkStore(io, config);
    try {
      const session = openWalletSession(store);
      const relink = await hasSecret(config.dataDir, rail);
      if (relink) line(io.stdout, `${name} wallet already linked: it stays as it is unless this new link succeeds`);
      line(io.stdout, `Waiting for you to approve the code in ${name} (until ${isoSeconds(pending.expiresAt)}; if this stops early, run --finish again)…`);
      let linked;
      try {
        linked = await finishShopLink(session, pending, { ...where, sleep: io.sleep ?? delay, now });
      } catch (error) {
        if (!(error instanceof ShopLinkError)) throw error;
        terminal = true;
        notLinked(io, config, rail, error, relink, `${INTENT} wallet link ${rail} --start`);
        return 1;
      }
      // The device code is spent: whatever happens to the tokens now, it cannot be redeemed again.
      terminal = true;
      await grant.discard();
      if (!(await keepLink(io, config, rail, { store, session, key, linked, relink, nextStep: true }))) code = 1;
    } finally {
      await store.close();
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const letGo = terminal ? grant.discard() : grant.release();
    // A failure to let go of the grant never hides the error that stopped the finish: it is said, and that one thrown.
    if (failed) {
      await letGo.catch((letGoError: unknown) => {
        line(io.stderr, printable(`intent: warning: the pending ${name} sign-in could not be ${terminal ? "deleted" : "put back"}: ${letGoError instanceof Error ? letGoError.message : String(letGoError)}`));
      });
    } else await letGo;
  }
  return code;
}

/**
 * After a link: agent payments already on, in the --wait-budget line; otherwise the two lines of the next step, the
 * connections page from Shop's answer (only an https page on shop.app; S1's page when Shop names none), then what to
 * tap, with the connection named by the client recorded in the vault and the suggested limit, in the account's
 * currency. With no advice in it, the tap line names no amount, and a note says why. False when the ceilings could not
 * be read: then the page and the tap line with no amount, and the one "try again" line (the caller exits 1).
 */
async function nextStep(io: Io, config: Config, rail: WalletRail, account: WalletAccount, vaultText: string, store: Store): Promise<boolean> {
  const adviser = await (await budgetAdviser(io, config))(store);
  const connection = connectionName(linkedShopClientId(vaultText));
  if (adviser.unread !== undefined) {
    // Agent payments may be on or low: neither is said without the ceilings, only where to turn them on.
    if (account.manageUrl !== null) line(io.stdout, printable(account.manageUrl));
    line(io.stdout, printable(`Tap ${connection}, turn on Allow agent to pay for me.`));
    line(io.stderr, printable(`intent: ${adviser.unread}`));
    return false;
  }
  if (agentPaymentsOn(io, rail, account, adviser, { page: account.manageUrl, connection })) return true;
  // A page Shop names off shop.app is never printed: then only what to tap.
  if (account.manageUrl !== null) line(io.stdout, printable(account.manageUrl));
  const currency = account.budgetRemaining?.currency ?? account.currency ?? null;
  const advice = currency === null ? "Shop shows no currency for this account, so the gateway suggests no amount" : adviser(currency);
  if (typeof advice === "string") {
    line(io.stdout, printable(`Tap ${connection}, turn on Allow agent to pay for me.`));
    line(io.stdout, printable(`Note: ${advice}`));
    return true;
  }
  line(io.stdout, printable(`Tap ${connection}, turn on Allow agent to pay for me, enter ${capText(advice.maxMinor, advice.currency)}.`));
  return true;
}

/** A flow that ended without tokens, in one line: the refused client named, or how to try again. */
function notLinked(io: Io, config: Config, rail: WalletRail, error: ShopLinkError, relink: boolean, retry: string): void {
  const name = RAIL_NAMES[rail];
  const kept = relink ? `; the earlier link is kept unchanged` : "";
  if (error.code === "invalid_client") line(io.stderr, `intent: ${name} wallet not linked: ${refusedClient(config)}${kept}`);
  else line(io.stderr, `intent: ${name} wallet not linked: ${error.message}${kept}; run ${retry} to try again`);
}

/**
 * The tokens are in hand: an earlier link is ended (revoked first, as `wallet unlink` does), the tokens saved, the
 * link chained, and the budget read once through the log. `nextStep`: also say where Shop lets the buyer turn on
 * agent payments, when Shop's answer names that page.
 */
async function keepLink(
  io: Io,
  config: Config,
  rail: WalletRail,
  link: { store: Store; session: WalletSession; key: WalletKey; linked: LinkedShopVault; relink: boolean; nextStep?: boolean },
): Promise<boolean> {
  const { store, session, key, linked, relink } = link;
  const name = RAIL_NAMES[rail];
  if (relink) {
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
  line(io.stdout, `One-tap with ${name} pays through agent payments only while they are on in the ${name} app and your policy allows one tap; otherwise purchases are handed off to ${name}'s checkout page`);
  if (!linked.refreshIssued) {
    const life = linked.expiresInS === null ? "" : ` (in about ${String(Math.max(1, Math.round(linked.expiresInS / 3600)))} h)`;
    line(io.stdout, `${name} issued no refresh token: when its access token expires${life}, run ${INTENT} wallet link ${rail} again`);
  }
  try {
    const account = await connectShop(session, { ...shopWhere(config), vaultText: linked.vaultText, saveVaultText: vaultSaver(config.dataDir, rail, key) }).account();
    for (const text of accountLines(name, rail, account)) line(io.stdout, text);
    if (link.nextStep === true && account.connected) {
      try {
        if (!(await nextStep(io, config, rail, account, linked.vaultText, store))) return false;
      } catch (error) {
        // The link is made and the budget read; only the suggestion is missing (the policy did not load).
        line(io.stderr, printable(`intent: linked, but the next step could not be worked out: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  } catch (error) {
    // The link is made; only the budget line is missing. The message is the gateway's own, never Shop's text.
    line(io.stderr, printable(`intent: linked, but the ${name} agent payments could not be read: ${error instanceof Error ? error.message : String(error)}`));
  }
  return true;
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
  // Most likely an agent's shell (it could also be a pipe such as tee, so the line asks), where this output may show only
  // after the whole wait; --start prints the link and exits.
  if (!io.isTTY.stdout) line(io.stdout, `Running this from an agent's shell? Stop it and use ${INTENT} wallet link ${name.toLowerCase()} --start, then --finish, so the link shows before the wait.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens the chain, deletes the rail's vault file, then chains the unlink. Exit 0 also when nothing was linked. */
export async function walletUnlink(io: Io, config: Config, rail: string): Promise<number> {
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; the only wallet is ${WALLET_RAILS.join(", ")}`, 2);
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
  if (!isWalletRail(rail)) throw new CliError(`unknown wallet "${rail}"; the only wallet is ${WALLET_RAILS.join(", ")}`, 2);
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
  // One sum per currency, never added across currencies: `21.49 USD`, `21.49 USD and 7.00 CAD`.
  const sums = Object.entries(check.unmatchedTotals).map(([currency, amountMinor]) => amountText({ amountMinor, currency }));
  const totals = sums.length === 0 ? amountText({ amountMinor: 0, currency: CHECK_CURRENCY }) : sums.join(" and ");
  const orders = (n: number): string => `${String(n)} order${n === 1 ? "" : "s"}`;
  line(io.stdout, `${name} reported ${orders(check.orders.length)} since ${check.since}`);
  if (!check.complete) line(io.stdout, `${name} said more orders exist, or returned a full page of 50: these counts cover only the orders it returned`);
  line(io.stdout, `Matched to a purchase in this gateway's chain: ${String(check.orders.length - check.unmatched.length)}`);
  const untotalled = check.unmatchedUntotalled === 0 ? "" : ` (${String(check.unmatchedUntotalled)} without a total, not in the sum)`;
  const label = check.complete ? "Not matched" : "Not matched among the orders returned";
  line(io.stdout, `${label}: ${String(check.unmatched.length)}, totalling ${totals}${untotalled}`);
  for (const order of check.unmatched) {
    const total = order.total === null ? "no total" : amountText(order.total);
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
