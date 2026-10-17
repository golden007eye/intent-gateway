# ADR-0018: One-tap completion: step machine, compare-and-append, restarts

Status: accepted · 2026-10-17

## Context

A verified `shop_agent` approval (contract 1.6.0, Appendix G) is completed by the gateway with the developer's linked Shop wallet (ADR-0017). Spending real money from an agent's tool call has to hold across crashes, restarts and two gateway processes on one data dir:

- never two `complete_checkout` sends for one approval, and never one the chain does not show was owned and logged first;
- a send that may have left is never repeated, whether or not Shop honours idempotency keys;
- spend-cap room comes back only on evidence the gateway holds itself (ADR-0015);
- Intent Cloud has received and accepted the redemption report before the wallet is charged (Appendix G completer precheck).

Shop's checkout id can carry a credential (`?key=`), so the chain names a checkout only by its hash, and the adapter held the raw id in memory only. A restarted gateway that may have completed a checkout must still be able to read it, or every crash after a send would end `indeterminate` for good.

## Decision

- **Driven from `get_approval_status`, never in the background.** `src/gateway/complete.ts` runs inside the status call, after the approval is chained, on both status paths (a new approval, and one already chained, which is the path every resume after a restart takes), until the first wait state or 20 s. Every request to Intent Cloud the gateway signs here uses the approval's completer key (ADR-0016).
- **Steps, each chained before its effect.** Preconditions (policy allows one_tap, a wallet, before `expires_at`); the effective per-order cap `min(policy, wallet budget)`; the quote (`create_checkout`) and binding-v1 checks 1, 3, 4 and 5 on it; the `completion` entry; the `completing` report; the `complete_attempt` entry; the completer precheck on a fresh `get_checkout` (same process, no cached read: check 2 against the completion's hash, checks 1, 3, 4, 5, expiry, and Appendix E again, step 7 included); `complete_checkout`; the local `outcome`; the report of it. A refusal before Intent Cloud accepted `completing` is a local outcome only; after it, it is reported as `failed` / `gateway_precheck`.
- **Compare-and-append in the store.** `Store.appendUnless(kind, body, conflict)` evaluates `conflict` over the chain while holding the lease, after reading every entry other writers appended and checking the tail, and before the write. A conflict throws `StoreConflictError`, writes nothing, and does not fence the handle: a lost race is an answer. One `completion` and one `complete_attempt` per approval are appended this way.
- **The send itself is compare-and-appended.** The disclosure core takes an `unless` condition for a send: the `complete_checkout` disclosure is appended, and the request sent, only while the attempt's owner token (random, memory only) is this process's, no `complete_checkout` for the purchase is logged and no outcome is chained. Otherwise nothing is logged or sent (`DisclosureConflictError`), and the core keeps sending; the session's disclosure numbers stay without a gap.
- **Reconcile, never re-send.** An owner token dies with its process, so after a restart an attempt is only reconciled. An attempt with no `complete_checkout` logged after the approval was provably never sent (log before send): `failed` (`gateway_precheck`, `not_sent`), compare-and-appended against such a disclosure, so it and a live owner's send exclude each other. Any `complete_checkout` logged after the approval, whichever purchase its local `purchase` field names, means the purchase may have been sent (fail closed, as `chargedNothing` and `intent verify`): `get_checkout` only. Open, not found, or an error is `indeterminate`, reported once, with the reservation held past `expires_at`.
- **Reports from the chain.** The `completing` report's body is fixed by the `completion` entry (`report_id`, checkout ref hash, `observed_at`), and every later report's by its first logged disclosure, so a retry after a restart resends the byte-identical body (R2). Report ids are `or_` + 22 base64url characters from the CSPRNG; every later report carries `completing_report_id`. A report refused with a 4xx is not resent.
- **Raw checkout ids in an encrypted checkout vault, keyed by checkout ref.** Chosen over `search_orders`: an order search cannot tell an open checkout from a lost one, carries no checkout id for binding check 2, and returns the buyer's whole order history. The Shop adapter keeps each raw id AES-256-GCM sealed under the wallet key (ADR-0013's vault, `src/wallet`), one 0600 file per checkout in `<data>/wallet/shop-checkouts/<hex of the ref>.enc`, with the AAD naming the rail and the ref, so a file copied under another ref's name does not open. Keyed by the checkout ref rather than the approval handle so the adapter owns it end to end and the gateway never sees a raw id. A file is deleted once the purchase has a terminal outcome, and any file older than 73 h (the completer read window after a 15-minute snapshot, plus a day) when the vault is opened. The checkout ref is the contract's checkout ref hash of the part before `?` (amendment L1), so reads with a different `?key=` name the same checkout.
- **Where Shop's store comes from is configurable and fails closed.** Shop names a store by its myshopify domain. Until the alias rule is decided (S1, D7), the default resolves only a storefront origin that is itself a myshopify host; any other is refused locally (`store_unknown`) before anything is sent to Shop. Demo mode and tests map the fake storefront to the fake store.

## Consequences

- Two gateway processes, a crash at any step and a restart each end in one send at most, an `ordered`, `mismatch` or `failed` read from evidence, or an `indeterminate` that holds the reservation.
- A purchase interleaved with another one-tap purchase's send after its approval can no longer be shown provably unsent: it is reconciled instead, and may stay `indeterminate`.
- The checkout vault is as safe as the wallet vault: against same-user malware it is obfuscation (AC-X3), and it holds a credential to read one checkout, not to pay.
- Real one-tap stays off until the store alias rule is decided: until then every real merchant whose storefront is not its myshopify domain is refused locally.
