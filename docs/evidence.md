# Evidence pack

`intent evidence <approval handle>` writes one purchase's record as one file. You can hand it to anyone who needs to check the purchase, such as a bank, a merchant or a dispute desk. They check it offline with `intent verify --evidence <file>`, with no account, no network and no access to your machine ([ADR-0018](adr/0018-evidence-pack.md)).

```console
$ intent evidence ap_N5bRA9JDjEf8qgb6
evidence: wrote /home/you/evidence-ap_N5bRA9JDjEf8qgb6.json
  purchase ap_N5bRA9JDjEf8qgb6: 25 of the 29 entries of the chain; head seq 28 hash fe4d220a…4935
  Anyone can check it offline: intent verify --evidence /home/you/evidence-ap_N5bRA9JDjEf8qgb6.json

$ intent verify --evidence evidence-ap_N5bRA9JDjEf8qgb6.json
evidence pack: ok
  purchase ap_N5bRA9JDjEf8qgb6: 25 of the 29 entries of the chain
  every entry hashes to its place in a chain that links from genesis to the head
purchase: ok
  holds search: 1, cart request: 1, approval request: 1, approval pending: 1, approval: 1, status read: 3, outcome: 2, answer: 6, observed: 6, key statement: 1, approver pin: 1, session: 1
key statements: ok
  1 recorded, checked offline against the pinned root key
disclosures: ok
  sent: 6
  acknowledged by a receipt from Intent Cloud's public edge: 6
  sent, not acknowledged: 0
  discarded: 0
  answers summarised locally (observed, never sent): 6
approvals: ok
  verified: 1
outcomes: ok
  re-checked: 2 (handed_off: 1, ordered: 1)
head: seq 28 hash fe4d220a…4935
  Compare this head with a copy of the chain taken earlier, or with your receipts.
verify: ok
```

The approval handle is the `ap_…` value `intent log` shows for the purchase. `--out <file>` names the file; the default is `evidence-<handle>.json` in the current directory, and an existing file is never overwritten. `intent evidence` checks the pack exactly as `intent verify --evidence` will and writes nothing if it does not verify. Both commands read the root key pinned for your Intent Cloud host, or `--trust-keys <file>`; the receiver needs the same root key. With `--demo` they use the demo chain and its test keys.

`intent verify --evidence` exits 0 when every check passes, 1 when one fails (naming the field or entry), and 2 for a usage error. It reads only the file: it does not open the data directory, makes no network request, and runs no install self-check.

## What the pack holds

| Part | What it is |
|---|---|
| The requests sent for the purchase | Each as the gateway logged it before sending (invariant 2): the cart request, the approval request, each status read and outcome report, any wallet request for the purchase, and the search the offer came from when its summary lists the offer. The body bytes and signature parameters are exact; a credential is a `[redacted sha256:…]` marker. |
| What came back | The receipt Intent Cloud signs for each request, over the digest of the bytes it received, or the follow-up recorded when there was none. The local summaries (`observed`), never sent. |
| The purchase the buyer approved | The `approval_pending` entry, with `sent`: the cart request, the offer and the cart that Appendix E step 7 matches the snapshot to. The `approval` entry, with the proof Intent Cloud returns: the snapshot, the buyer's passkey assertion over it, and Intent Cloud's signature. The approver pin in force then. |
| What happened next | Each `outcome` entry: what Intent Cloud reported, its outcome statement as signed, and the gateway's own binding-v1 result and shown state. A purchase with no outcome yet has none. |
| The keys | The key statements in force, which the root key signs, and the root key the gateway pinned (`pinned_root`). |
| The chain around it | `skeleton`: the `seq`, `prev` and `hash` of every entry of the chain, from the first to the head, so each entry's place in the chain can be checked. |

What it never holds: buyer identity (the gateway never stores a name, a postal address or a card, invariant 3); a credential in clear; anything kept beside the chain, such as the wallet vault, the wallet key, or the completer and session private keys. Other purchases appear only as the hashes in `skeleton`.

## What the checks prove

| Check | What it proves | What it does not |
|---|---|---|
| `evidence pack` | The file is canonical JSON in format v1, unchanged since export. Each entry hashes to its own content and sits at its row of a skeleton that links from the first entry to the head. The pack's root key is the one this verifier pins. | That the skeleton rows of entries outside the pack are real: their content is not in the pack (see the limits below). |
| `purchase` | Every entry belongs to the purchase the pack names, found from the entries themselves; the pack has its pending entry and its approval; nothing it says was sent looks like buyer identity. | That no entry of the purchase was left out. |
| `key statements` | Each key statement was signed by the pinned root key and was valid when it was recorded. | |
| `disclosures` | Each receipt is signed by a receipt key from the statement and covers the bytes the pack says were sent; no request holds a credential in clear. | What Intent Cloud, a merchant or a wallet did with a request after it was received. |
| `approvals` | The passkey assertion is over this snapshot, the proof carries a good signature by Intent Cloud, the snapshot is the purchase that was asked for (step 7), and the passkey is the pinned approver. | That the person who holds the passkey meant to buy. |
| `outcomes` | Each outcome statement verifies, and the shown state is never more than it supports (ADR-0015). | That the order was delivered. |

## Checking a pack without our code

The format is small enough to check with any JSON and Ed25519 library, against the [public contract](https://github.com/golden007eye/intent-gateway/tree/main/contract):

1. The file is the RFC 8785 canonical form of its JSON, followed by a newline.
2. `skeleton[i].seq` is `i`; `skeleton[0].prev` is 64 zeros; each later `prev` is the `hash` of the row before; `head` is the last row.
3. Each entry's `hash` is the hex SHA-256 of the canonical JSON of `{seq, prev, ts, kind, body}`, and its `prev` and `hash` equal `skeleton[seq]`.
4. The key statement (`keys` entry, `body.statement`) verifies with the root key you trust for the host (Appendix F); receipts verify with its receipt keys (Appendix D); the approval proof and outcome statements with its approval keys (Appendices E and G).
5. A disclosure's `body_b64` hashes to its `content_digest`, which its receipt covers with the same `method`, `path`, `keyid`, `nonce` and `created`.

## Limits

- The signed parts (receipts, the approval proof, key and outcome statements) are what you can check without trusting the developer. The skeleton rows of entries outside the pack are the exporter's account: they cannot be recomputed from the pack. Compare the head with one saved earlier, or with another pack from the same chain: a later head must have a higher `seq` and keep the earlier hash at the earlier `seq`.
- A pack shows what is in it. One built by hand could leave out an entry of the purchase, such as a later outcome.
- A pack says what the gateway sent and what Intent Cloud signs or acknowledged receiving. It says nothing about what happens to that data afterwards.
- The format is the gateway's own. A mapping to AP2 or ACP mandates and receipts may follow once they publish a stable format.
