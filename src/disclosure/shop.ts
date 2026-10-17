// The one way to reach the developer's Shop account (ADR-0017): the Shop adapter with both of its transports behind
// the disclosure core, as connectCloud is for Intent Cloud. Destination `shop` is Shop's MCP server, `shop_accounts`
// its account server (revocation). Both share the gateway session and the stop of `owner`.
import { BUILD } from "../config/index.ts";
import type { WalletAdapter } from "../wallet/index.ts";
import {
  createShopAccountsTransport,
  createShopAdapter,
  createShopMcpTransport,
  DEFAULT_SHOP_AUTH_URL,
  DEFAULT_SHOP_MCP_URL,
  parseShopCredentials,
  SHOP_SECRET_PATHS,
} from "../wallet-shop/index.ts";
import type { DisclosedCloud } from "./disclosure.ts";
import { createDisclosedWallet, type WalletSession } from "./wallet.ts";

export interface ShopConnection {
  /** INTENT_SHOP_MCP_URL; null for Shop's own. */
  readonly mcpUrl: string | null;
  /** INTENT_SHOP_AUTH_URL; null for Shop's own. */
  readonly authUrl: string | null;
  /** INTENT_SHOP_CLIENT_ID, used to revoke when the vault names no client. */
  readonly clientId: string | null;
  /** The wallet vault's text for `shop`. When it holds no usable tokens, every call fails and revoke sends nothing. */
  readonly vaultText: string;
  readonly timeoutMs?: number;
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
  const accounts = createDisclosedWallet(createShopAccountsTransport({ url: connection.authUrl ?? DEFAULT_SHOP_AUTH_URL, ...timing }), owner, {
    destination: "shop_accounts",
  });
  return createShopAdapter({ mcp, accounts, credentials, clientId: connection.clientId });
}
