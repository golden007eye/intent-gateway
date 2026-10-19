// The one way to reach the developer's Shop account (ADR-0017): the Shop adapter with both of its transports behind
// the disclosure core, as connectCloud is for Intent Cloud. Destination `shop` is Shop's MCP server, `shop_accounts`
// its account server (revocation, and the device flow that links the account). Both share the gateway session and
// the stop of `owner`.
import { BUILD } from "../config/index.ts";
import type { CheckoutIdStore, WalletAdapter } from "../wallet/index.ts";
import {
  createShopAccountsTransport,
  createShopAdapter,
  createShopMcpTransport,
  DEFAULT_SHOP_AUTH_URL,
  DEFAULT_SHOP_CLIENT_ID,
  DEFAULT_SHOP_MCP_URL,
  type DeviceGrant,
  type DeviceGrantPrompt,
  deviceGrantText,
  parseDeviceGrant,
  parseShopCredentials,
  pollDeviceGrant,
  runDeviceFlow,
  SHOP_ACCOUNTS_SECRET_PATHS,
  SHOP_OPAQUE_IDS,
  SHOP_SECRET_PATHS,
  shopCredentialsText,
  startDeviceFlow,
} from "../wallet-shop/index.ts";
import type { DisclosedCloud } from "./disclosure.ts";
import { createDisclosedWallet, type WalletSession } from "./wallet.ts";

export interface ShopConnection {
  /** INTENT_SHOP_MCP_URL; null for Shop's own. */
  readonly mcpUrl: string | null;
  /** INTENT_SHOP_AUTH_URL; null for Shop's own. */
  readonly authUrl: string | null;
  /** The wallet vault's text for `shop`. When it holds no usable tokens, every call fails and revoke sends nothing. */
  readonly vaultText: string;
  /**
   * INTENT_SHOP_CLIENT_ID, or null. Used only for a vault from before the link's client id was kept in it; the gateway's
   * own client (DEFAULT_SHOP_CLIENT_ID) when it is null too. A vault that names its client always uses that one.
   */
  readonly clientId?: string | null;
  readonly timeoutMs?: number;
  /** Makes each create_checkout idempotency key (a UUID v4); random by default, fixed by tests. */
  readonly newKey?: () => string;
  /** Where Shop's raw checkout ids are kept between processes (the encrypted checkout vault, ADR-0019); memory by default. */
  readonly checkoutIds?: CheckoutIdStore;
  /**
   * Keeps refreshed tokens: called with the new vault text after each refresh (the wallet vault in production). Without
   * it the new tokens live in this process only, and the next process refreshes again.
   */
  readonly saveVaultText?: (text: string) => Promise<void>;
  /** Milliseconds since the epoch, for the access token's expiry; Date.now by default. */
  readonly now?: () => number;
}

/** The Shop wallet adapter, every send of it logged first by the disclosure core of `owner`. */
export function connectShop(owner: DisclosedCloud | WalletSession, connection: ShopConnection): WalletAdapter {
  let credentials = parseShopCredentials(connection.vaultText, connection.clientId ?? DEFAULT_SHOP_CLIENT_ID);
  const timing = connection.timeoutMs === undefined ? {} : { timeoutMs: connection.timeoutMs };
  const mcp = createDisclosedWallet(
    createShopMcpTransport({
      url: connection.mcpUrl ?? DEFAULT_SHOP_MCP_URL,
      // Read at each request: a refresh replaces it.
      accessToken: () => credentials?.accessToken ?? "",
      clientVersion: BUILD.version,
      ...timing,
    }),
    owner,
    { destination: "shop", secretPaths: SHOP_SECRET_PATHS, opaqueIds: SHOP_OPAQUE_IDS },
  );
  return createShopAdapter({
    mcp,
    accounts: accountsOf(owner, connection),
    credentials,
    onCredentials: async (renewed) => {
      credentials = renewed;
      await connection.saveVaultText?.(shopCredentialsText(renewed));
    },
    ...(connection.newKey === undefined ? {} : { newKey: connection.newKey }),
    ...(connection.now === undefined ? {} : { now: connection.now }),
    ...(connection.checkoutIds === undefined ? {} : { checkoutIds: connection.checkoutIds }),
  });
}

function accountsOf(owner: DisclosedCloud | WalletSession, connection: Pick<ShopConnection, "authUrl" | "timeoutMs">) {
  const timing = connection.timeoutMs === undefined ? {} : { timeoutMs: connection.timeoutMs };
  return createDisclosedWallet(createShopAccountsTransport({ url: connection.authUrl ?? DEFAULT_SHOP_AUTH_URL, ...timing }), owner, {
    destination: "shop_accounts",
    secretPaths: SHOP_ACCOUNTS_SECRET_PATHS,
  });
}

/** Whether `vaultText` holds a token connectShop can use (it falls back to the gateway's own client, as connectShop does). */
export function shopVaultHasToken(vaultText: string): boolean {
  return parseShopCredentials(vaultText, DEFAULT_SHOP_CLIENT_ID) !== null;
}

/** The client id the wallet in `vaultText` was linked with, or null when the vault names none (an older vault). */
export function linkedShopClientId(vaultText: string): string | null {
  return parseShopCredentials(vaultText)?.clientId ?? null;
}

export interface ShopLink {
  /** INTENT_SHOP_MCP_URL; null for Shop's own. Its origin is the resource the tokens are asked for. */
  readonly mcpUrl: string | null;
  /** INTENT_SHOP_AUTH_URL; null for Shop's own. */
  readonly authUrl: string | null;
  /** INTENT_SHOP_CLIENT_ID; null for the gateway's own client (DEFAULT_SHOP_CLIENT_ID). */
  readonly clientId: string | null;
  readonly show: (prompt: DeviceGrantPrompt) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

/** What linking gives back: the wallet vault's text for `shop`, whether Shop issued a refresh token, and the access token's lifetime. */
export interface LinkedShopVault {
  readonly vaultText: string;
  readonly refreshIssued: boolean;
  readonly expiresInS: number | null;
}

/**
 * Links the developer's Shop account with the OAuth device flow (plan G8), every request logged by the disclosure
 * core of `owner` before it leaves: the device code and the tokens are digested in the log, and answers are kept
 * as a digest and a size. Throws ShopLinkError when the flow ends without tokens.
 */
export async function linkShop(owner: DisclosedCloud | WalletSession, link: ShopLink): Promise<LinkedShopVault> {
  const resource = new URL(link.mcpUrl ?? DEFAULT_SHOP_MCP_URL).origin;
  const linked = await runDeviceFlow(accountsOf(owner, link), {
    clientId: link.clientId ?? DEFAULT_SHOP_CLIENT_ID,
    resource,
    show: link.show,
    sleep: link.sleep,
    now: link.now,
    shopPagesOnly: link.authUrl === null,
  });
  return vaultOf(linked);
}

const vaultOf = (linked: Awaited<ReturnType<typeof pollDeviceGrant>>): LinkedShopVault => ({
  vaultText: shopCredentialsText(linked.credentials),
  refreshIssued: linked.credentials.refreshToken !== null,
  expiresInS: linked.expiresInS,
});

/** Where a link is made: the same settings as ShopLink, without the printing and the waiting. */
export type ShopLinkWhere = Pick<ShopLink, "mcpUrl" | "authUrl" | "clientId" | "timeoutMs">;

/** What the first half of a link gives back: the pending grant's text (a credential: seal it, never print it) and what to show. */
export interface StartedShopLink {
  readonly pendingText: string;
  readonly prompt: DeviceGrantPrompt;
  /** When the code stops counting, in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/**
 * The first half of linking (`intent wallet link shop --start`): the device authorization only, logged by the core of
 * `owner` before it leaves, as linkShop sends it. Throws ShopLinkError when Shop refuses it.
 */
export async function startShopLink(owner: DisclosedCloud | WalletSession, link: ShopLinkWhere & { readonly now: () => number }): Promise<StartedShopLink> {
  const where = settingsOf(link);
  const { grant, prompt } = await startDeviceFlow(accountsOf(owner, link), { clientId: where.clientId, resource: where.resource, now: link.now, shopPagesOnly: link.authUrl === null });
  return { pendingText: deviceGrantText(grant, where.authUrl), prompt, expiresAt: grant.expiresAt };
}

const PENDING_GRANT = new WeakMap<PendingShopLink, DeviceGrant>();

/** A pending grant that matches the settings in effect, ready to finish. Its device code is readable only in this module. */
export interface PendingShopLink {
  readonly expiresAt: number;
  readonly clientId: string;
}

/** The pending grant cannot be finished with the settings in effect. The message never holds the device code. */
export class ShopPendingError extends Error {
  override name = "ShopPendingError";
  /** `unreadable`: no setting can make it a grant again; `mismatch`: it was made with other settings. */
  readonly reason: "unreadable" | "mismatch";
  constructor(reason: "unreadable" | "mismatch", message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * The pending grant in `pendingText`, checked against the settings in effect: the same client (INTENT_SHOP_CLIENT_ID,
 * or the gateway's own), the same account server (the device code goes back only to the server that issued it) and the
 * same resource. Throws ShopPendingError otherwise: a grant made as another client is never polled as this one.
 */
export function openPendingShopLink(pendingText: string, link: ShopLinkWhere): PendingShopLink {
  const parsed = parseDeviceGrant(pendingText);
  if (parsed === null) throw new ShopPendingError("unreadable", "the pending Shop sign-in cannot be read");
  const where = settingsOf(link);
  const { grant } = parsed;
  if (grant.clientId !== where.clientId) {
    throw new ShopPendingError("mismatch", `the pending Shop sign-in was started as the client ${grant.clientId}, but the client in effect now is ${where.clientId}`);
  }
  if (parsed.authUrl !== where.authUrl || grant.resource !== where.resource) {
    throw new ShopPendingError("mismatch", "the pending Shop sign-in was started with another INTENT_SHOP_AUTH_URL or INTENT_SHOP_MCP_URL than the ones in effect now");
  }
  const pending: PendingShopLink = Object.freeze({ expiresAt: grant.expiresAt, clientId: grant.clientId });
  PENDING_GRANT.set(pending, grant);
  return pending;
}

/**
 * The second half (`--finish`): token polls with the pending grant until Shop answers, each logged by the core of
 * `owner` before it leaves, with the device code digested. Throws ShopLinkError when the flow ends without tokens.
 */
export async function finishShopLink(
  owner: DisclosedCloud | WalletSession,
  pending: PendingShopLink,
  link: ShopLinkWhere & { readonly sleep: (ms: number) => Promise<void>; readonly now: () => number },
): Promise<LinkedShopVault> {
  const grant = PENDING_GRANT.get(pending);
  if (grant === undefined) throw new TypeError("not a pending Shop link from openPendingShopLink");
  return vaultOf(await pollDeviceGrant(accountsOf(owner, link), grant, { sleep: link.sleep, now: link.now }));
}

function settingsOf(link: ShopLinkWhere): { clientId: string; authUrl: string; resource: string } {
  return {
    clientId: link.clientId ?? DEFAULT_SHOP_CLIENT_ID,
    authUrl: link.authUrl ?? DEFAULT_SHOP_AUTH_URL,
    resource: new URL(link.mcpUrl ?? DEFAULT_SHOP_MCP_URL).origin,
  };
}
