// The one way to reach a merchant storefront (contract 1.6.1 store pair check; ADR-0020): the storefront transport
// behind the disclosure core of `owner`, as destination `storefront`. Each `GET <merchant_origin>/meta.json` is logged
// before it leaves (its URL and its fixed header set; it has no body), and its answer is kept as a `response` entry:
// status, sha256 and size, never the content. A failed append means no GET (invariant 2).
import type { MetaAnswer } from "../contract/index.ts";
import { createStorefrontTransport, META_OPERATION, type StorefrontTransport } from "../storefront/index.ts";
import type { DisclosedCloud } from "./disclosure.ts";
import { createDisclosedWallet, type WalletSession } from "./wallet.ts";

/** The destination's name in the chain. */
export const STOREFRONT = "storefront";

/** What the store pair check reads from a storefront: the answer to one logged GET, and the seq that logged it. */
export interface StorefrontPort {
  /**
   * Logs, then sends `GET url` (a URL contract's metaUrl built) for purchase `purchase`, and returns the status, the
   * Content-Type (null when absent or sent more than once) and at most 64 KiB + 1 bytes of body. Throws when no
   * answer came back (the name did not resolve to public addresses, the connection failed, the time ran out).
   */
  fetchMeta(url: string, purchase: string): Promise<MetaAnswer & { readonly disclosureSeq: number }>;
}

/** The storefront port, every send logged first by the disclosure core of `owner`. `transport` is for tests and demo mode. */
export function connectStorefront(owner: DisclosedCloud | WalletSession, transport: StorefrontTransport = createStorefrontTransport()): StorefrontPort {
  const disclosed = createDisclosedWallet(transport, owner, { destination: STOREFRONT });
  return {
    async fetchMeta(url, purchase) {
      const answer = await disclosed.call(META_OPERATION, { url }, { purchase });
      const types = answer.headers.filter(([name]) => name.toLowerCase() === "content-type");
      return { status: answer.status, contentType: types.length === 1 ? (types[0]?.[1] ?? null) : null, body: answer.body, disclosureSeq: answer.disclosureSeq };
    },
  };
}
