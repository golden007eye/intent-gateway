# ADR-0011: Pin the first approving passkey

Status: accepted · 2026-10-15

## Context

Invariant 4 requires a passkey-signed Approval the gateway has verified and chained. Intent Cloud returns each Approval with the passkey assertion and the credential's public key, and the gateway re-verifies the assertion itself. That alone proves only that some passkey signed: if Intent Cloud were wrong or compromised, a passkey other than the buyer's would pass. Accepting Approvals on Intent Cloud's signature alone was considered; it needs about a third of the code, but a bug or a minted key at Intent Cloud would go unnoticed. An agent with shell access could also try to approve its own purchases.

## Decision

- **Trust on first use.** The first Approval the gateway verifies writes an `approver_pin` entry to the chain with that passkey credential's id and public key. The pin's fingerprint is printed to stderr and shown in the read-only panel when it is created.
- **A different credential is flagged.** An Approval signed by any other credential writes an `approver_flag` entry. The purchase is not reported as approved; the agent gets a warning that names `intent approver accept`.
- **`intent approver accept` needs a person at a terminal.** It refuses unless stdin and stdout are both TTYs, asks for the fingerprint the panel shows, and refuses on a mismatch. On success it writes a new pin entry. `intent approver list` shows the pin history.
- **The merchant hand-off is the backstop.** The buyer pays by hand at the merchant's checkout (invariant 3), so a self-approved cart still cannot be paid for without the human.

## Consequences

After the first purchase, the approval check no longer rests on Intent Cloud alone: a new passkey must be accepted at the developer's terminal. The first purchase still trusts Intent Cloud. If the agent enrols a passkey and approves before the human does, its passkey becomes the pin; the fingerprint shown at creation and the human's own passkey being flagged are the signals. The TTY check raises the bar but is not a guarantee, since an agent that can open a pseudo-terminal can pass it; the threat model says so and names payment by hand at the merchant as the backstop.
