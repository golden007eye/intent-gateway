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
  DEFAULT_SHOP_MCP_URL,
  type DeviceGrantPrompt,
  parseShopCredentials,
  runDeviceFlow,
  SHOP_ACCOUNTS_SECRET_PATHS,
  SHOP_SECRET_PATHS,
  shopCredentialsText,
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
  readonly timeoutMs?: number;
  /** Makes each create_checkout idempotency key (a UUID v4); random by default, fixed by tests. */
  readonly newKey?: () => string;
  /** Where Shop's raw checkout ids are kept between processes (the encrypted checkout vault, ADR-0019); memory by default. */
  readonly checkoutIds?: CheckoutIdStore;
}

/** The Shop wallet adapter, every send of it logged first by the disclosure core of `owner`. */
export function connectShop(owner: DisclosedCloud | WalletSession, connection: ShopConnection): WalletAdapter {
  const credentials = parseShopCredentials(connection.vaultText);
  const timing = connection.timeoutMs === undefined ? {} : { timeoutMs: connection.timeoutMs };
  const mcp = createDisclosedWallet(
    createShopMcpTransport({
      url: connection.mcpUrl ?? DEFAULT_SHOP_MCP_URL,
      accessToken: credentials?.accessToken ?? "",
      clientVersion: BUILD.version,
      ...timing,
    }),
    owner,
    { destination: "shop", secretPaths: SHOP_SECRET_PATHS },
  );
  return createShopAdapter({
    mcp,
    accounts: accountsOf(owner, connection),
    credentials,
    ...(connection.newKey === undefined ? {} : { newKey: connection.newKey }),
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

export interface ShopLink {
  /** INTENT_SHOP_MCP_URL; null for Shop's own. Its origin is the resource the tokens are asked for. */
  readonly mcpUrl: string | null;
  /** INTENT_SHOP_AUTH_URL; null for Shop's own. */
  readonly authUrl: string | null;
  /** The gateway's registered Shop client (INTENT_SHOP_CLIENT_ID). */
  readonly clientId: string;
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
  const linked = await runDeviceFlow(accountsOf(owner, link), { clientId: link.clientId, resource, show: link.show, sleep: link.sleep, now: link.now });
  return { vaultText: shopCredentialsText(linked.credentials), refreshIssued: linked.credentials.refreshToken !== null, expiresInS: linked.expiresInS };
}
