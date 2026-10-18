// Log before send to a wallet destination (ADR-0014): a DestinationTransport wrapped in the same disclosure core as
// Intent Cloud, sharing the disclosed cloud's gateway session and its stop.
//
// A wallet destination signs no receipt, so each exchange is followed by a `response` entry
// {disclosure_seq, status, body_sha256, bytes}: what came back, as a digest and a size, never its content (a wallet's
// answers can carry buyer identity, invariant 3). No answer at all is `unacknowledged`, as for Intent Cloud, with the
// NOT_SENT_REASON rule when no connection was made. The disclosure body holds the request as logged (credentials
// digested), `destination`, and `content_digest` over the logged body bytes.
import { createHash } from "node:crypto";
import { parsePath } from "../privacy/index.ts";
import { contentDigest } from "../signing/index.ts";
import type { Entry, Store } from "../store/index.ts";
import {
  coreOf,
  createDisclosureCore,
  DESTINATION_NAME,
  type DestinationTransport,
  INTENT_CLOUD,
  type OutboundRequest,
  registerCore,
  type TransportResponse,
} from "./core.ts";
import type { DisclosedCloud } from "./disclosure.ts";

export interface WalletDisclosureOptions {
  /** The destination's name in the chain, e.g. `shop` or `shop_accounts`; never `intent_cloud`. */
  readonly destination: string;
  /**
   * Body paths whose values are digested in the log (`params.arguments.refresh_token`, `items[0]["a.b"]`), besides
   * the `authorization` header and the secret keys (privacy's SECRET_KEYS), which are digested wherever they are.
   */
  readonly secretPaths?: readonly string[];
  /**
   * Wallet-issued ids let through the identity scan at exactly their dotted path (plain keys only), while the whole
   * value matches the pattern (`{path: "params.arguments.id", pattern}`). A pattern with the `g` or `y` flag is
   * refused: it keeps state between tests.
   */
  readonly opaqueIds?: readonly { readonly path: string; readonly pattern: RegExp }[];
}

/** An answer as the transport returned it, plus the seq of the `disclosure` entry that logged its request. */
export type WalletResult = TransportResponse & { readonly disclosureSeq: number };

export interface DisclosedWallet {
  readonly destination: string;
  /**
   * Prepares, logs, then sends one request. `purchase` is the approval handle the call belongs to: it is kept in the
   * disclosure entry and never sent.
   */
  call(operation: string, payload: unknown, options?: { purchase?: string; unless?: (entries: readonly Entry[]) => boolean }): Promise<WalletResult>;
}

const PURCHASE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A gateway session of its own for wallet sends made with no Intent Cloud connection (`intent wallet unlink`
 * revoking a token): a disclosure core over `store`, with its own `session` entry and stop.
 */
export interface WalletSession {
  readonly walletSession: true;
}

export function openWalletSession(store: Store): WalletSession {
  const session: WalletSession = { walletSession: true };
  registerCore(session, createDisclosureCore(store));
  return session;
}

/**
 * `transport` behind the disclosure core of `cloud` (or of a wallet session): its sends are logged first, and stop
 * when the cloud's stop.
 */
export function createDisclosedWallet(transport: DestinationTransport, cloud: DisclosedCloud | WalletSession, options: WalletDisclosureOptions): DisclosedWallet {
  const { destination } = options;
  if (destination === INTENT_CLOUD || !DESTINATION_NAME.test(destination)) {
    throw new TypeError(`a wallet destination is a lower-case name other than ${INTENT_CLOUD}, not ${JSON.stringify(destination)}`);
  }
  const secretPaths = (options.secretPaths ?? []).map((path) => {
    const segments = parsePath(path.startsWith("[") ? path : `.${path}`);
    if (segments === null || segments.length === 0) throw new TypeError(`not a body path: ${JSON.stringify(path)}`);
    return segments;
  });
  const opaqueIds = (options.opaqueIds ?? []).map((o) => {
    const at = o.path.split(".");
    if (!at.every((k) => /^[A-Za-z_$][\w$]*$/.test(k))) throw new TypeError(`not a plain body path: ${JSON.stringify(o.path)}`);
    // `g` and `y` make test() resume at lastIndex, so the same id would pass on one send and fail on the next.
    if (o.pattern.global || o.pattern.sticky) throw new TypeError(`an opaque-id pattern may not use the g or y flag: ${String(o.pattern)}`);
    return { at, pattern: o.pattern };
  });
  const core = coreOf(cloud);

  return {
    destination,
    async call(operation, payload, callOptions = {}) {
      const { purchase, unless } = callOptions;
      if (purchase !== undefined && !PURCHASE.test(purchase)) throw new TypeError(`not an approval handle: ${JSON.stringify(purchase)}`);
      // The double-charge rules (ADR-0019) count a payment by its purchase and admit it only by compare-and-append:
      // a complete_checkout without both is refused before anything is logged or sent.
      if (operation === "complete_checkout" && (purchase === undefined || unless === undefined)) {
        throw new TypeError("a complete_checkout send needs its purchase and its send condition (unless)");
      }
      core.assertOpen();
      const request = transport.prepare(operation, payload);
      const { result, seq } = await core.disclose(
        destination,
        {
          // The core logs the prepared request; send is called only once that append is on disk.
          run: async (beforeSend) => {
            await beforeSend(request);
            return transport.send(request);
          },
          body: walletBody,
          answered: async (logged, response) => {
            await core.store.append("response", {
              disclosure_seq: logged.seq,
              status: response.status,
              body_sha256: createHash("sha256").update(response.body).digest("hex"),
              bytes: response.body.length,
            });
            return null;
          },
          discard: (logged, _response, reason) => new Error(`response to disclosure #${String(logged.seq)} discarded: ${reason}`),
        },
        { secretPaths, opaqueIds, ...(purchase === undefined ? {} : { purchase }), ...(unless === undefined ? {} : { unless }) },
      );
      return { ...result, disclosureSeq: seq };
    },
  };
}

function walletBody(request: OutboundRequest, fields: string[]) {
  return {
    endpoint: request.operation,
    method: request.method,
    path: request.path,
    fields,
    body_b64: Buffer.from(request.body).toString("base64"),
    headers: request.headers.map(([name, value]) => [name, value]),
    content_digest: contentDigest(request.body),
  };
}
