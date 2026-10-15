# ADR-0007: The local store is a JSONL hash chain with a fenced lease

Status: accepted · 2026-10-15

## Context

The disclosure log and the local audit trail are evidence the developer reads and verifies. They must be easy to inspect with ordinary tools, must not fork when two gateway processes share a data directory, and a failed write must stop the send it was recording (invariant 2). A process that pauses while holding the lock (a laptop going to sleep, a stopped container) must not later write as if nothing had happened.

## Decision

- **One JSONL file, one hash chain.** Each line is one entry in RFC 8785 canonical JSON, linked to the previous entry by its hash. Entry kinds: `session`, `keys`, `disclosure`, `receipt`, `unacknowledged`, `discarded`, `block`, `approval_pending`, `approval`, `approver_pin`, `approver_flag`. Each write is followed by `fdatasync`.
- **A fenced lease lock.** A writer holds a lease with a token and an expiry. An expired lease is taken over by atomic rename. Before each write the holder checks its lease token and the chain's tail hash; after each write it checks the tail again. A writer whose token or tail no longer matches is refused, so the send it was recording does not happen. A tail mismatch found after a write stops all sends and is reported.
- **No content scanning in the store.** The store appends and verifies; it does not inspect what an entry says. The check for buyer identity runs on the outbound body before the append, in the one module that sends (invariant 3).
- SQLite in WAL mode was considered and rejected: a binary file is harder to read as evidence, and it would become a second source of truth beside the chain.

## Consequences

`intent verify` can name the first entry where a chain was tampered with, truncated, reordered or had an entry deleted. Two processes on one data directory produce one valid chain, and a paused holder's late write is refused instead of forking it. Writes are slower than an embedded database, which is acceptable at the gateway's request rate. `fdatasync` is weaker on macOS than on Linux; this is documented, and any reported write failure still blocks the send.
