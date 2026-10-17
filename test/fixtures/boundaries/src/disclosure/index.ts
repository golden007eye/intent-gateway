// Allowed: only src/disclosure reaches src/cloud and the wallet adapters.
import { cloud } from "../cloud/index.ts";
import { walletShop } from "../wallet-shop/index.ts";

export const disclosure = [cloud, walletShop];
