# ADR-0016: A per-approval completer key

Status: accepted · 2026-10-17

## Context

The gateway signs every request with a session key that lives for one process (ADR-0006), and Intent Cloud scopes each approval to the session that created its cart: any other key gets 404 when it reads the approval. A stdio gateway restarts with every agent session, so after a restart the gateway could no longer read an approval it had asked for, and could never report what happened to the purchase. Keeping the session key on disk would fix the restart but link every search and cart of every session to one key, which the shopping-session rule forbids (`GLOSSARY.md`). Under contract 1.6.0 (Appendix G R1 and R7), a key the cart request names, and the passkey-signed snapshot binds, may also sign reads and outcome reports for that approval, a rule Intent Cloud enforces.

## Decision

- **One fresh key per cart.** For each cart the gateway makes a new Ed25519 key, the completer key. Its keyid (`gw-` + base64url of the raw public key, as for a session) goes in the cart request as `completer_keyid`, which the disclosure log records and the "Sent:" line names. The snapshot v2 the buyer approves carries it, and the gateway refuses a snapshot whose `completer_keyid` is not the key it made.
- **Saved before the cart request leaves.** The key is written to `<data>/completer/<keyid>.key` (mode 0600, in a 0700 folder that must be a real directory of the current user) and fsync'd before the cart request is logged and sent. A crash after the approval is chained therefore always leaves a key that can read it. The file is named by keyid because the approval handle exists only after the cart request; the chained `approval_pending` entry names the keyid. A cart that goes no further (refused, a failed request, a snapshot that does not match) deletes its key at once.
- **Used only after a restart.** A status read is signed with the session key when this process created the cart, and with the completer key otherwise. The logged disclosure names whichever key signed, so `intent verify` checks the receipt against it.
- **Deleted when no purchase needs it.** On start and after each status call, the gateway deletes a key:
  - with no `approval_pending` entry naming it, an hour after it was made;
  - for a cart never approved, at `expires_at`;
  - for an approved hand-off, once Intent Cloud has reported a terminal outcome;
  - for an approved gateway-wallet purchase, once a terminal outcome report the key signed got a 201 with a verified receipt;
  - in every case, 48 hours after the later of `expires_at` and the terminal outcome, when Intent Cloud stops accepting anything the key signs (Appendix G R7).

## Consequences

A restarted gateway reads, and later reports on, the purchases it started, without a key that links sessions: each completer key names one purchase, and the passkey signs which key that is. One key file exists per open purchase, for at most two days after the purchase ends. Someone who steals a key file can read that one approval and, for a gateway-wallet purchase, race the gateway's own outcome report for it; the key cannot approve or pay for anything. A hand-off whose outcome arrives more than 48 hours after `expires_at` is no longer readable by a restarted gateway, which then keeps showing it as handed off. A gateway that loses its data dir loses its keys, and with them the ability to read its open purchases after a restart, as before this change.
