// A fake merchant storefront for tests and demo mode (contract 1.6.1 store pair check): an in-memory storefront
// transport that answers `GET https://<host>/meta.json` for the stores it knows, with faults for attack tests. It
// builds each request with the real transport's prepare, so what the disclosure core logs is what production logs;
// only the network part is replaced. The real transport's DNS, address and size rules are tested against a local
// server in src/storefront.
import { createStorefrontTransport, type StorefrontRequest, type StorefrontResponse, type StorefrontTransport, StorefrontTransportError } from "../storefront/index.ts";

/** One storefront's answer to meta.json, as the fake sends it (the body is cut at 64 KiB + 1 bytes, as the real reader stops). */
export interface FakeMetaAnswer {
  readonly status?: number;
  /** One Content-Type header; null sends none; an array sends each. */
  readonly contentType?: string | null | readonly string[];
  readonly body?: string | Uint8Array;
}

/** A network failure instead of an answer: `refused` is a name that resolves to a non-public address (never sent). */
export type FakeMetaFault = "network_error" | "timeout" | "refused";

export interface FakeStorefront {
  readonly transport: StorefrontTransport;
  /** Every request that reached the fake, in order. */
  readonly requests: StorefrontRequest[];
  /** Pairs a storefront host with the myshopify domain its meta.json names. */
  pair(host: string, myshopifyDomain: string): void;
  /** Answers this host with `answer` (or fails with a fault) instead of its pairing; null goes back to the pairing. */
  answer(host: string, answer: FakeMetaAnswer | FakeMetaFault | null): void;
}

const MAX_READ = 64 * 1024 + 1;

/** The fake. `stores` maps a storefront host (`stickers.example`) to the myshopify domain its meta.json names. */
export function createFakeStorefront(stores: Readonly<Record<string, string>> = {}): FakeStorefront {
  const real = createStorefrontTransport();
  const pairs = new Map(Object.entries(stores));
  const overrides = new Map<string, FakeMetaAnswer | FakeMetaFault>();
  const requests: StorefrontRequest[] = [];

  function respond(host: string): StorefrontResponse {
    const override = overrides.get(host);
    if (override === "network_error") throw new StorefrontTransportError(host, "network error", false);
    if (override === "timeout") throw new StorefrontTransportError(host, "no complete answer within the time limit", false);
    if (override === "refused") throw new StorefrontTransportError(host, "the name resolves to a non-public address", true);
    const domain = pairs.get(host);
    const answer: FakeMetaAnswer =
      override ?? (domain === undefined ? { status: 404, contentType: "text/html", body: "<h1>Not found</h1>" } : { body: JSON.stringify({ name: host, myshopify_domain: domain }) });
    const type = answer.contentType === undefined ? "application/json; charset=utf-8" : answer.contentType;
    const types = type === null ? [] : typeof type === "string" ? [type] : type;
    const body = typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : Buffer.from(answer.body ?? new Uint8Array(0));
    return { status: answer.status ?? 200, headers: types.map((t) => ["content-type", t] as const), body: body.subarray(0, MAX_READ) };
  }

  return {
    transport: {
      prepare: (operation, payload) => real.prepare(operation, payload),
      send(request) {
        const host = new URL(request.path).host;
        if (overrides.get(host) !== "refused") requests.push(request);
        return Promise.resolve().then(() => respond(host));
      },
    },
    requests,
    pair(host, myshopifyDomain) {
      pairs.set(host, myshopifyDomain);
    },
    answer(host, answer) {
      if (answer === null) overrides.delete(host);
      else overrides.set(host, answer);
    },
  };
}
