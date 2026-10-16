# The log

`intent log` prints the local hash chain: every request the gateway sent, what came back for it, what it held back, and each approval. It reads `<data dir>/audit.jsonl` and never reaches the network. `intent log --demo` reads the demo chain. [`intent verify`](verify.md) is the integrity check: it re-checks every hash, receipt and approval against the pinned root key.

## Views

| Command | What it prints |
|---|---|
| `intent log` | One line per chain entry, field names only. |
| `intent log -v` | One block per action (a search, a cart, an approval-status check, an approval, a block), each entry of it, and the values each request sent, read from the exact bytes the chain holds, with its method and path, `content-digest`, signing keyid and the key that signed its receipt. |
| `intent log --json` | One JSON object per action and per line, for scripts and `jq` (schema below). |

The values are the developer's own record of what left the machine: the category, product, must-haves, budget and ZIP code of a search, the offer handle, quantity and ZIP code of a cart. A blocked request's values are never logged: only its field names and the rule or identity finding that held it back.

`-v` shows times in the local time zone; `--utc` shows them in UTC. `--json` keeps each entry's `ts`, which is UTC.

Colour is used only when the output is a terminal, and never with `NO_COLOR` set, `TERM=dumb` or `--no-color`. `--json` is never coloured.

## Filters

| Option | Keeps |
|---|---|
| `--action search,cart` | The actions of these kinds: `start`, `keys`, `search`, `cart`, `status`, `approval`, `blocked`, `pin`, `flagged`. |
| `--since 30m` | Actions from that long ago (`s`, `m`, `h`, `d`, `w`), or from a date (`2026-10-16`, local midnight; UTC with `--utc`) or time (`2026-10-16T09:00:00Z`). |
| `--last 5` | The last N actions, after the other filters. |

The plain view then lists only the entries of the kept actions and says how many it shows. A line that is not an entry (torn or edited) is always shown.

`--follow` (`-f`) keeps reading the chain and prints what is appended, until Ctrl-C. In the plain view each new entry is printed once. With `-v` or `--json` an action is printed once it is complete: when a later action starts, or when every request of it has an answer and nothing changed for one read. An action that grows after it was printed (a late answer) is printed again with the same `seq`.

## Actions

The actions group the chain's entries:

- `start`: a gateway session entry and the key reads that follow it (`getMeta`, `getSignatureKeys`, `getKeyStatement`) with the key statement recorded. `keys` is the same reads and statement without a session start.
- `search`: one `searchCatalog` request.
- `cart`: one `createCart` request, the `createApproval` request after it, and the approval link the gateway gave the agent.
- `status`: one `getApproval` request.
- `approval`: an Approval the gateway checked and chained, with the approver pin written with it, if it was the first.
- `blocked`: a request the gateway held back; nothing was sent.
- `pin`: an approver pin written by `intent approver accept`. `flagged`: a passkey flagged as not the pinned approver.

A cart or status check the gateway refused after an answer (the cart, snapshot or proof did not match) carries outcome `refused` and the reasons in `blocked`.

## JSON lines

Each line is one action. Fields are always present; `null` means the chain does not hold the value.

```json
{"v":1,"time":"2026-10-16T17:27:37.000Z","seq":1,"seqs":[1,2],"action":"search","outcome":"acknowledged",
 "facts":{"category":"running shoes","must_haves":["road"],"budget_minor":12000,"currency":"USD","zip":"94103","country":"US"},
 "blocked":[],
 "requests":[{"seq":1,"time":"2026-10-16T17:27:37.000Z","endpoint":"searchCatalog","method":"POST","path":"/v1/catalog/search",
   "fields":{"category":"running shoes","must_haves":["road"],"budget_max.amount_minor":12000,"budget_max.currency":"USD","ship_to.country":"US","ship_to.postal_code":"94103"},
   "field_names":["category","must_haves","budget_max.amount_minor","budget_max.currency","ship_to.country","ship_to.postal_code"],
   "content_digest":"sha-256=:…:","keyid":"gw-…","delivery":"acknowledged",
   "response":{"seq":2,"kind":"receipt","status":200,"acknowledged":true,"signature_checked":true,"receipt_kid":"cloud-receipt-202610","reason":null}}]}
```

(Shown across lines here; each object is one line.)

| Field | Meaning |
|---|---|
| `v` | The format version, 1. A field is only ever added within a version. |
| `time`, `seq` | The `ts` and seq of the action's first entry. |
| `seqs` | Every entry of the action, in chain order. |
| `action` | One of the kinds above. |
| `outcome` | For requests, the worst `delivery` of the action's requests; otherwise `blocked`, `refused`, `approval_asked`, `approved`, `pinned`, `flagged` or `recorded` (a key statement or session start with no request). |
| `facts` | The readable facts the action's entries hold, each present only when held: `category`, `product`, `must_haves`, `budget_minor`, `currency`, `zip`, `country`, `offer_handle`, `quantity`, `approval_handle`, `approval_url`, `total_minor`, `expires_at`, `fingerprint`, `pinned`, `flag_reason`, `key_kid`, `keys_expire_at`, `session_id`, `endpoint` and `field_names` (of a blocked request). |
| `blocked` | What held a request back, or why an answer was refused. |
| `requests[]` | Each request the action logged. |
| `requests[].fields` | The values sent, by dotted path, from the logged bytes; `{}` for no body; `null` for an entry without body bytes. |
| `requests[].delivery` | `acknowledged`: a receipt came back. `unacknowledged`: it left and no receipt came back. `not_sent`: no connection was made, it never left. `maybe_sent`: no answer recorded (the gateway stopped first, or is still waiting). `discarded`: a response without a valid receipt was not used. These are `intent verify`'s categories. |
| `requests[].response` | The follow-up entry, or `null`: its `seq`, `kind` (`receipt`, `unacknowledged`, `discarded`), HTTP `status`, `acknowledged`, `signature_checked` (the gateway checked the receipt's signature when it logged it; receipts of the first key reads are checked by `intent verify`), `receipt_kid` (read from the receipt, not a check) and `reason`. |

For example, every value a search sent to Intent Cloud today:

```sh
intent log --json --action search --since 1d | jq -c '.requests[].fields'
```
