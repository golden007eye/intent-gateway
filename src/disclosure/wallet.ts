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
import type { Store } from "../store/index.ts";
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
}

/** An answer as the transport returned it, plus the seq of the `disclosure` entry that logged its request. */
export type WalletResult = TransportResponse & { readonly disclosureSeq: number };

export interface DisclosedWallet {
  readonly destination: string;
  /**
   * Prepares, logs, then sends one request. `purchase` is the approval handle the call belongs to: it is kept in the
   * disclosure entry and never sent.
   */
  call(operation: string, payload: unknown, options?: { purchase?: string }): Promise<WalletResult>;
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
  const core = coreOf(cloud);

  return {
    destination,
    async call(operation, payload, callOptions = {}) {
      const { purchase } = callOptions;
      if (purchase !== undefined && !PURCHASE.test(purchase)) throw new TypeError(`not an approval handle: ${JSON.stringify(purchase)}`);
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
        { secretPaths, ...(purchase === undefined ? {} : { purchase }) },
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
