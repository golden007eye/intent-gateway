# ADR-0014: Log before send to every outside destination

Status: accepted · 2026-10-16 · amended by [ADR-0017](0017-wallet-adapters-in-the-gateway.md) (compound token names, form bodies) · amended by [ADR-0024](0024-submit-shop-checkout.md) (one credential to Intent Cloud)

## Context

Invariant 2 was written for one destination: every field sent to Intent Cloud is appended to the local hash chain before the request leaves. One-tap purchases add a second kind of destination: a wallet the developer links, such as their own Shop account, which the gateway reaches with a bearer token. Three things differ from Intent Cloud:

- A wallet signs no receipt, so its answer cannot be checked against the log.
- A wallet request carries a credential, an `authorization` header or a token in the body. The disclosure log keeps every header value and the exact body bytes (ADR-0006, ADR-0007), so as written it would copy the credential into the chain and from there into any evidence the developer shares.
- A wallet's answers can carry buyer identity (invariant 3).

A second log path for wallets would mean two implementations of invariant 2, and they would drift apart.

## Decision

- **One disclosure core for every destination.** `src/disclosure` holds the only code that checks, logs and follows up a request to an outside destination. Requests to Intent Cloud and to every wallet destination go through it. An adapter to a new destination implements the `DestinationTransport` port: `prepare` builds the final request bytes, then `send` writes exactly those bytes. The core appends the `disclosure` entry between the two calls, so when the append fails, `send` is never called. The core holds one gateway session per gateway start and one stop for all destinations: after a failed append around a send to any destination, every destination refuses to send.
- **`destination` names where a request went.** A disclosure entry to a wallet carries `destination` (for example `shop`, `shop_accounts`). A disclosure entry without it went to Intent Cloud, so chains written before this change keep their meaning. A wallet disclosure may also carry `purchase`, the approval handle the call belongs to. It is kept on this machine and is never in the bytes sent.
- **Exact bytes except digested secrets.** Before the append, the core replaces each of these values with `[redacted sha256:<hex>]` in the logged request of a wallet destination:
  - the `authorization`, `proxy-authorization`, `cookie` and `x-api-key` headers;
  - every body value, at any depth, under a secret key. A key is compared as its words (split on `_`, `-`, spaces and camelCase, lower-cased), so `accessToken`, `Refresh_Token` and `api-key` count. The secret keys are `token`, `access_token`, `refresh_token`, `id_token`, `device_code`, `code_verifier`, `client_secret`, `client_assertion`, `password` and `api_key`. `code` counts only beside an OAuth sibling (`grant_type`, `redirect_uri`, `code_verifier` or `client_id`), so a promo or product code stays readable;
  - every value at a body path the destination declares secret (`secretPaths`). Declare only high-entropy values there (tokens, keys): the marker is an unsalted sha256, so a low-entropy value (a PIN, a short code) can be recovered from it by trying every candidate.

  The hex is the sha256 of the value as sent. `redacted: [{at, sha256}]` lists each replacement. A body with a redacted value is logged as the JSON text of the redacted body. Every other request is logged byte for byte as sent, as before.
- **What cannot be logged as sent is not sent.** The core refuses the request (a `block` entry with the reason, no send) when:
  - a wallet body is not exactly `JSON.stringify` of its own parse. Duplicate keys, spacing and escapes would make the logged and scanned body differ from the sent one: a duplicate key could carry an email that the parsed body hides;
  - a wallet request's query names a secret key (`?access_token=`), which the log cannot digest;
  - a request to Intent Cloud carries any credential: requests to Intent Cloud are never redacted.

  Each `block` entry the core writes names what held the request back in `rule`: `logging` for these refusals, `identity` for a buyer-identity finding. `intent log` and the panel read `rule` rather than the reason's wording, and show no value for either. A block entry without `rule` (a policy block, or a chain written before `rule` existed) is read from its reasons.
- **`content_digest` covers the logged bytes.** For Intent Cloud, the logged bytes are the sent bytes, so `content_digest` (the request's `Content-Digest`) and the receipt over it stay checkable against the log. For a wallet, `content_digest` is the digest of the logged body. That body equals the sent body except at the values `redacted` lists, which hold the sha256 of what was sent there; since the sent body is the plain JSON of the same value, a developer who holds the secrets can rebuild the sent bytes exactly.
- **A `response` entry follows a wallet exchange.** It holds `{disclosure_seq, status, body_sha256, bytes}`: the status, plus a digest and a size of what came back, never its content. A send with no answer at all is `unacknowledged`, as for Intent Cloud, with the "not sent" rule when no connection was made. A `receipt` stays the only follow-up to an answer that arrived from Intent Cloud.
- **`intent verify` refuses credentials in clear.** In any disclosure, to any destination, a credential header or a secret body key that holds anything but a redaction marker, or a query parameter named as a secret key, fails verify with "holds a credential". Verify uses the same rules as the core (`src/privacy`). Every `redacted[].at` must name a value in the logged request that is the marker for its `sha256`. A `response` must name an earlier disclosure to a wallet destination (one with `destination`), and a `receipt` that names one fails.
- **The chain format grows once.** New entry kinds: `response`, plus `completion`, `complete_attempt`, `outcome` and `wallet`, which are reserved for one-tap purchases so that the format changes only once.
- **Module rules.** Only `src/disclosure` may import a wallet adapter (`only-disclosure-reaches-wallets`). Only tests and demo mode may load a wallet fake. Wallet adapters and their fakes join the modules allowed to open connections.

## Consequences

Invariant 2 now reads "any outside destination". The disclosure log holds exact bytes except digested secrets. A developer who knows a secret can still check that it was the one sent, by its sha256. A credential never lands in the chain, and `intent verify` fails on a chain where one did. A wallet's answer is recorded as a status, a digest and a size: the log shows that the wallet answered and how much came back, not what it said, and nothing checks that answer the way a receipt is checked. The summary line of a tool result names the destination of such a send and says its answer is unsigned.

A gateway older than this change reads a chain holding a `response` entry as broken (unknown kind), so `intent log` and `intent verify` need this version or a later one. Chains written before it verify unchanged.

Redaction is by header name, by key name and by declared path. An MCP tool call's `params.name` (when `method` is `tools/call` and the name is a plain lower-case identifier) is exempt from the identity check's name-key rule for wallet destinations; its value is still scanned. A secret sent under another name, and not declared by its destination's adapter, would be logged in clear. Each wallet adapter must therefore declare its secret paths, and its tests must show that its tokens are not in `audit.jsonl`.

The core does not look inside string values. A token in JSON text carried as a string (`state: "{\"access_token\":\"…\"}"`) under a plain key is logged as sent. `intent verify` reports it as a warning that names its path, never its value, and does not fail (`src/privacy`'s `nestedSecrets`, the same detector the views use). `intent log` (every view) and the panel show such a value as "JSON text holding a credential, not shown", but `audit.jsonl` holds it, and so does any copy of the chain the developer shares. The fix stays the same: the adapter declares the path in `secretPaths`.

The credential and identity scans walk at most 64 levels of nesting (`SCAN_DEPTH`). A request body nested deeper is blocked before the log and the send (`too_deep`), and the views show a deeper logged value as "nested too deep, not shown", so a hand-edited chain cannot crash `intent log`; `intent verify` fails such a disclosure, since it cannot check it for a credential.

An opaque-id pattern (ADR-0019) with the `g` or `y` flag is refused when the wallet is built: such a pattern keeps state between tests, so the same id could pass one send and be blocked on the next.

## Amendment: one credential to Intent Cloud (ADR-0024)

In contract 1.7.0, one credential is what Intent Cloud receives from the gateway: a hand-off checkout's `continue_url`, which holds the checkout's key. It is the only exception to "requests to Intent Cloud never carry a credential": it is redacted in the log as its sha256 at exactly `body.checkout.continue_url` of `createCheckout` (privacy's `CLOUD_SECRET_PATHS`), every other credential to Intent Cloud is still refused, and `content_digest` keeps naming the sent bytes, which the receipt covers. `intent verify` accepts such a redacted body only at that path.
