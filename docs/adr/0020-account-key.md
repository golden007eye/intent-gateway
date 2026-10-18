# ADR-0020: Account key

Status: accepted · 2026-10-18 · Relates to ADR-0016 (completer key), ADR-0017 (wallet adapters)

## Context

The day-one plan has the gateway submit Shop checkouts for passkey approval and lets the developer pause every purchase at once (`intent pause`). Both need a key that stands for the developer's gateway across processes and restarts:

- a pause has to take effect at once, without a passkey tap, and must not be forgeable by anyone else;
- a submitted checkout has to name the gateway that submitted it, so a pause can stop it.

None of the gateway's keys fits. A session key is fresh for each anonymous run and links nothing, by design. A completer key lives for one cart (ADR-0016). The wallet key encrypts the vault and is never a signing key.

## Decision

- **One Ed25519 account key per data dir.** `intent init` makes it with `ensureAccountKey` (`src/account`): `<data dir>/account-key.json`, a private JWK `{kty, crv, x, d}`, file mode 0600, the data dir created 0700 when missing. It is written with exclusive create, so two processes never both write one, and it is never overwritten: a file there that is not an Ed25519 private JWK, or whose `x` is not the public half of its `d`, is an error that names the file and is left as it is. A new key would no longer be the one the platform knows.
- **What the module exposes.** The public JWK `{kty: "OKP", crv: "Ed25519", x}`; its RFC 7638 thumbprint (base64url of the sha256 of `{"crv":"Ed25519","kty":"OKP","x":"<x>"}`, the required members in lexicographic order; tested against RFC 8037 A.3); and `sign(bytes)`, a plain Ed25519 signature (tested against RFC 8037 A.4). The private half never leaves the module or the file; `intent init` prints only the path and the thumbprint.
- **Where it will be used.** The checkout submission (contract 1.7.0) carries the public JWK as `account_key`; a Pause is signed over `"intent-pause-v1\n" + JCS({account_key_thumbprint, counter, issued_at, action: "pause"})`. Both arrive with their own changes, each logged before it leaves (invariant 2) like any other field. This decision only creates the key.
- **Kept with the data dir.** It sits in the data dir, not the config folder, because it belongs to this gateway's chain: a copy of the data dir is the same gateway. Losing the file loses the ability to pause by key; a passkey pause from the confirm page still works.

## Consequences

The account key links the checkouts and pauses of one gateway, which the anonymous session keys were designed not to do. That is the point: a pause has to reach every purchase of the developer. It carries no buyer identity (invariant 3), and searches never carry it.

Like the Shop token, the key is readable by any program running as the developer, including the agent. A stolen account key can only pause, never resume (resume needs the passkey) and never approve (invariant 4).
