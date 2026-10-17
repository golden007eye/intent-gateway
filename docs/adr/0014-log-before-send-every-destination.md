# ADR-0014: Log before send to every outside destination

Status: accepted · 2026-10-16

## Context

Invariant 2 was written for one destination: every field sent to Intent Cloud is appended to the local hash chain before the request leaves. One-tap purchases add a second kind of destination: a wallet the developer links, such as their own Shop account, which the gateway reaches with a bearer token. Three things differ from Intent Cloud:

- A wallet signs no receipt, so its answer cannot be checked against the log.
- A wallet request carries a credential, an `authorization` header or a token in the body. The disclosure log keeps every header value and the exact body bytes (ADR-0006, ADR-0007), so as written it would copy the credential into the chain and from there into any evidence the developer shares.
- A wallet's answers can carry buyer identity (invariant 3).

A second log path for wallets would mean two implementations of invariant 2, and they would drift apart.

## Decision

- **One disclosure core for every destination.** `src/disclosure` holds the only code that checks, logs and follows up a request to an outside destination. Requests to Intent Cloud and to every wallet destination go through it. An adapter to a new destination implements the `DestinationTransport` port: `prepare` builds the final request bytes, then `send` writes exactly those bytes. The core appends the `disclosure` entry between the two calls, so when the append fails, `send` is never called. The core holds one gateway session per gateway start and one stop for all destinations: after a failed append around a send to any destination, every destination refuses to send.
- **`destination` names where a request went.** A disclosure entry to a wallet carries `destination` (for example `shop`, `shop_accounts`). A disclosure entry without it went to Intent Cloud, so chains written before this change keep their meaning. A wallet disclosure may also carry `purchase`, the approval handle the call belongs to. It is kept on this machine and is never in the bytes sent.
- **Exact bytes except digested secrets.** Before the append, the core replaces each of these values with `[redacted sha256:<hex>]` in the logged request:
  - the `authorization` header;
  - every body value under a secret key (`refresh_token`, `access_token`, `id_token`, `device_code`, `code_verifier`, `client_secret`, `code`), at any depth;
  - every value at a body path the destination declares secret.

  The hex is the sha256 of the value as sent. `redacted: [{at, sha256}]` lists each replacement. A body with a redacted value is logged as the JSON text of the redacted body. Every other request is logged byte for byte as sent, as before.
- **A `response` entry follows a wallet exchange.** It holds `{disclosure_seq, status, body_sha256, bytes}`: the status, plus a digest and a size of what came back, never its content. A send with no answer at all is `unacknowledged`, as for Intent Cloud, with the "not sent" rule when no connection was made. A `receipt` stays the only follow-up to an answer that arrived from Intent Cloud.
- **`intent verify` refuses credentials in clear.** In any disclosure, to any destination, an `authorization` header or a secret body key that holds anything but a redaction marker fails verify with "holds a credential". Every `redacted[].at` must name a value in the logged request that is the marker for its `sha256`. A `response` must name an earlier disclosure to a wallet destination (one with `destination`), and a `receipt` that names one fails.
- **The chain format grows once.** New entry kinds: `response`, plus `completion`, `complete_attempt`, `outcome` and `wallet`, which are reserved for one-tap purchases so that the format changes only once.
- **Module rules.** Only `src/disclosure` may import a wallet adapter (`only-disclosure-reaches-wallets`). Only tests and demo mode may load a wallet fake. Wallet adapters and their fakes join the modules allowed to open connections.

## Consequences

Invariant 2 now reads "any outside destination". The disclosure log holds exact bytes except digested secrets. A developer who knows a secret can still check that it was the one sent, by its sha256. A credential never lands in the chain, and `intent verify` fails on a chain where one did. A wallet's answer is recorded as a status, a digest and a size: the log shows that the wallet answered and how much came back, not what it said, and nothing checks that answer the way a receipt is checked. The summary line of a tool result names the destination of such a send and says its answer is unsigned.

A gateway older than this change reads a chain holding a `response` entry as broken (unknown kind), so `intent log` and `intent verify` need this version or a later one. Chains written before it verify unchanged.

Redaction is by header name, by key name and by declared path. A secret sent under another name, and not declared by its destination's adapter, would be logged in clear. Each wallet adapter must therefore declare its secret paths, and its tests must show that its tokens are not in `audit.jsonl`.
