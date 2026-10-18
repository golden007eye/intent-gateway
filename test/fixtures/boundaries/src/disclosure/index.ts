// Allowed: only src/disclosure reaches src/cloud, the wallet adapters and the storefront transport.
import { cloud } from "../cloud/index.ts";
import { storefront } from "../storefront/index.ts";
import { walletShop } from "../wallet-shop/index.ts";

export const disclosure = [cloud, walletShop, storefront];
