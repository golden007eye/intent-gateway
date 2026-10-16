# The log

`intent log` prints the local hash chain: every request the gateway sent, what came back for it, what it held back, and each approval. It reads `<data dir>/audit.jsonl` and never reaches the network. `intent log --demo` reads the demo chain. [`intent verify`](verify.md) is the integrity check: it re-checks every hash, receipt and approval against the pinned root key.

## Views

| Command | What it prints |
|---|---|
| `intent log` | The action timeline: one line per action with the values it sent and its outcome, then what was sent and what never was, and the counts. |
| `intent log -v` | One block per action (a search, a cart, an approval-status check, an approval, a block), each entry of it, and the values each request sent, read from the exact bytes the chain holds, with its method and path, `content-digest`, signing keyid and the key that signed its receipt. |
| `intent log --json` | One JSON object per action and per line, for scripts and `jq` (schema below). |

```text
intent log · DEMO chain (test keys) · ~/.local/share/intent-gateway/demo · 33 entries

Friday 16 October 2026
16:09:11  start     gateway started · keys signed by cloud-root-1 · valid until 2027-01-14  ✓ 2 receipts
16:09:11  search    running shoes · under $120 · ZIP 94103                → 6 offers · ✓ receipt
16:09:11  blocked   search for "alcohol": category excluded by your gateway policy  ✗ nothing sent
16:09:11  cart      Budget Running Shoe ×1 · $41.98 · Resale Hub          → approval link  ✓ 2 receipts
16:09:11  status    approval ap_xyCp…lXmw                                 → Intent Cloud says approved · ✓ receipt
16:09:11  approved  $41.98 · passkey a295…1de0 (pinned now)               ✓ passkey proof checked
16:09:11  cart      Road Runner 2 ×1 · $64.99 · Road Runners              → approval link  ✓ 2 receipts
16:09:11  rejected  $64.99 · Road Runner 2 · approval ap_po2-…IqmW        → Intent Cloud says rejected · ✓ receipt

Sent to Intent Cloud only: category, budget, offer, quantity, ZIP code, country.
Never sent: your name, postal address, card.

8 actions · 1 search · 2 carts · 2 status checks · 1 approval · 1 blocked · 9 receipts
Details: intent log --demo -v · Machine-readable: intent log --demo --json · Integrity: intent verify --demo
```

Each command in the last line starts with the invocation that runs this gateway (`intent`, `npx -y intent-gateway@next`, `node /abs/dist/main.js`); a long one is named once on a line of its own (`Run each as: … <command>`). That line is never cut to the terminal's width: on a terminal too narrow for it, each command gets a line of its own.

What came back (`→ 6 offers`, the product title, total and merchant of a cart, `→ Intent Cloud says approved`, `rejected`) comes from the `observed` entries the gateway writes after each answer with a verified receipt: a summary of what Intent Cloud returns (the body is not covered by the receipt), kept on this machine and never sent (see [What came back](#what-came-back)). The `✓ receipt` after it is about the request: a receipt covers the request and the status it came back with, not the offers or the state in the body. A chain written before observations existed shows the values sent instead (`offer of_5mOm…t4wK ×1 · at most $41.98 · ZIP 94103`) and no `→ offers` or state.

Each line's outcome is what the chain records for its requests: `✓ receipt` (a receipt came back), `⚠ sent, no receipt`, `⚠ not sent: no connection was made`, `⚠ maybe sent, no answer recorded` (the gateway stopped first, or is still waiting), `✗ answer discarded: no valid receipt`, `✗ nothing sent` (blocked), `✗ refused` (an answer that did not match what was asked). `✓ passkey proof checked` marks an Approval the gateway verified before it chained it; `intent verify` re-checks it. The line "Sent to Intent Cloud only" lists every field of the requests shown that left or may have left. "Never sent: your name, postal address, card" is printed only after the gateway's buyer-identity check finds none in their logged values; otherwise the line names the request where it found one, or says which requests it could not check.

Times and date headers are in the local time zone; `--utc` shows UTC. On a terminal the lines are cut to its width with `…`, the values first so the outcome stays visible; piped, nothing is cut. Without a UTF-8 locale the symbols are plain ASCII (`ok`, `!`, `x`, `->`).

The values are the developer's own record of what left the machine: the category, product, must-haves, budget and ZIP code of a search, the offer handle, quantity and ZIP code of a cart. A request the gateway policy blocked keeps, in its `block` entry, the structured values the policy held back (`held`: the category, such as `alcohol`, the ZIP code, or a cart's offer title and merchant), so the line can name them; they never left the machine. The free text of a search's `product` is never kept: the buyer-identity check cannot tell a name in free text from a product name. A request blocked for buyer identity keeps no value at all: only its field names and the identity finding that held it back.

`-v` shows times in the local time zone too. `--json` keeps each entry's `ts`, which is UTC.

Colour is used only when the output is a terminal, and never with `NO_COLOR` set, `TERM=dumb` or `--no-color`. `--json` is never coloured.

## Filters

| Option | Keeps |
|---|---|
| `--action search,cart` | The actions of these kinds: `start`, `keys`, `search`, `cart`, `status`, `approval`, `blocked`, `pin`, `flagged`. |
| `--since 30m` | Actions from that long ago (`s`, `m`, `h`, `d`, `w`), or from a date (`2026-10-16`, local midnight; UTC with `--utc`) or time (`2026-10-16T09:00:00Z`). |
| `--last 5` | The last N actions, after the other filters. |

The timeline then lists only the kept actions, counts only them and says how many of all it shows. A line that is not an entry (torn or edited) is always shown.

`--follow` (`-f`) keeps reading the chain and prints what is appended, until Ctrl-C. An action is printed once it is complete: when a later action starts, or when every request of it has an answer and nothing changed for one read. An action that grows after it was printed (a late answer) is printed again with the same `seq`.

## Actions

The actions group the chain's entries:

- `start`: a gateway session entry and the key reads that follow it (`getMeta`, `getSignatureKeys`, `getKeyStatement`) with the key statement recorded. `keys` is the same reads and statement without a session start.
- `search`: one `searchCatalog` request.
- `cart`: one `createCart` request, the `createApproval` request after it, and the approval link the gateway gave the agent.
- `status`: one `getApproval` request. When the state Intent Cloud returns for it is `rejected` or `expired`, that is the action's outcome, and the line reads `rejected` or `expired`.
- `approval`: an Approval the gateway checked and chained, with the approver pin written with it, if it was the first.
- `blocked`: a request the gateway held back; nothing was sent.
- `pin`: an approver pin written by `intent approver accept`. `flagged`: a passkey flagged as not the pinned approver.

A cart or status check the gateway refused after an answer (the cart, snapshot or proof did not match) carries outcome `refused` and the reasons in `blocked`.

## What came back

After each answer with a receipt the gateway verified, it appends an `observed` entry: a small summary of what Intent Cloud returns for that request (the body is not covered by the receipt), which names it by `disclosure_seq`.

| Request | What the observation keeps |
|---|---|
| `searchCatalog` | `offers_count` (how many offers Intent Cloud returns), `offers_hidden` (how many the gateway policy hid from the agent), and up to 10 `offers`, each with `offer_handle`, `title`, `merchant`, `price_minor`, `shipping_minor`, `currency`. |
| `createCart` | `title`, `merchant`, `quantity`, `total_minor`, `currency`. |
| `createApproval` | `approval_handle`, `state`, `title`, `merchant`, `quantity`, `total_minor`, `currency`. |
| `getApproval` | `approval_handle`, `state` (`pending`, `approved`, `rejected`, `expired`, `handed_off`, `ordered`), `title`, `merchant`, `total_minor`, `currency`. |

An observation is not a disclosure: nothing in it leaves the machine, and it never stands in for a receipt. It holds only what Intent Cloud returns, never the buyer's details: before it is written, the gateway runs its buyer-identity check over it and replaces any value that looks like an email, a phone number, a card or a street address with `[withheld]`, listing where in `withheld`. A withheld number (a price or total that looked like part of a card number) is stored as 0 with its path, or the offer holding it, in `withheld`; `intent log` and the panel show it as "withheld", never as $0.00, and `--json` lists it in `facts.withheld` (`total_minor`) and in `observed.withheld`. `intent verify` checks every observation: its shape, that it names an earlier request of the same endpoint whose verified receipt came first with a success status, that no other observation names that request, and that it holds no buyer identity ([verify](verify.md)).

Titles and merchant names are the merchant's own text, recorded as Intent Cloud returns it. The public contract bounds only their length (its test vectors carry a tab, DEL and U+2028 in a title), so the gateway accepts any character there. `intent log`, `intent verify`, `intent doctor` and `intent approver list` print every value from the chain through one sanitiser: control characters (C0, DEL, C1), format characters such as bidi overrides and zero-width characters, and lone surrogates are shown as `\u{1b}`-style text, and each run of line breaks as a literal `\n`, so a value can neither move the cursor, set the clipboard, hide a link nor print a line of its own. `--json` escapes the same characters as `\uXXXX`. The panel shows the same characters the same way, and writes every value as text, never as HTML.

The `observed` entry kind is new in this version: a gateway older than it reads a chain holding one as broken (unknown kind), so run `intent log` and `intent verify` with this version or a later one.

## JSON lines

Each line is one action. Fields are always present; `null` means the chain does not hold the value.

```json
{"v":2,"time":"2026-10-16T17:27:37.000Z","seq":1,"seqs":[1,2,3],"action":"search","outcome":"acknowledged",
 "facts":{"category":"running shoes","must_haves":["road"],"budget_minor":12000,"currency":"USD","zip":"94103","country":"US",
   "offers_count":3,"offers_hidden":0,"offers":[{"offer_handle":"of_…","title":"Budget Running Shoe","merchant":"Resale Hub","price_minor":3999,"shipping_minor":199,"currency":"USD"}]},
 "blocked":[],
 "requests":[{"seq":1,"time":"2026-10-16T17:27:37.000Z","endpoint":"searchCatalog","method":"POST","path":"/v1/catalog/search",
   "fields":{"category":"running shoes","must_haves":["road"],"budget_max.amount_minor":12000,"budget_max.currency":"USD","ship_to.country":"US","ship_to.postal_code":"94103"},
   "field_names":["category","must_haves","budget_max.amount_minor","budget_max.currency","ship_to.country","ship_to.postal_code"],
   "content_digest":"sha-256=:…:","keyid":"gw-…","delivery":"acknowledged",
   "response":{"seq":2,"kind":"receipt","status":200,"acknowledged":true,"signature_checked":true,"receipt_kid":"cloud-receipt-202610","reason":null},
   "observed":{"seq":3,"disclosure_seq":1,"endpoint":"searchCatalog","offers_count":3,"offers_hidden":0,"offers":[…]}}]}
```

(Shown across lines here; each object is one line.)

| Field | Meaning |
|---|---|
| `v` | The format version, 2. A field is only ever added within a version. Version 2 added `requests[].observed`, the facts from observations and `held`, and the outcomes `rejected` and `expired`; every version 1 field is unchanged, so a reader of version 1 can read version 2 lines. A chain written before observations prints version 2 lines with `observed: null` and none of the new facts. |
| `time`, `seq` | The `ts` and seq of the action's first entry. |
| `seqs` | Every entry of the action, in chain order. |
| `action` | One of the kinds above. |
| `outcome` | For requests, the worst `delivery` of the action's requests; otherwise `blocked`, `refused`, `approval_asked`, `approved`, `pinned`, `flagged` or `recorded` (a key statement or session start with no request). A status check whose observation says `rejected` or `expired` has that outcome. |
| `facts` | The readable facts the action's entries hold, each present only when held: `category`, `product`, `must_haves`, `budget_minor`, `currency`, `zip`, `country`, `offer_handle`, `quantity`, `approval_handle`, `approval_url`, `total_minor`, `expires_at`, `fingerprint`, `pinned`, `flag_reason`, `key_kid`, `keys_expire_at`, `session_id`, `endpoint` and `field_names` (of a blocked request), `held` (the values a policy block held back), and from observations `offers_count`, `offers_hidden`, `offers`, `title`, `merchant` and `approval_state` (the latest state Intent Cloud returns for the approval; on a cart too). |
| `blocked` | What held a request back, or why an answer was refused. |
| `requests[]` | Each request the action logged. |
| `requests[].fields` | The values sent, by dotted path, from the logged bytes; `{}` for no body; `null` for an entry without body bytes. |
| `requests[].delivery` | `acknowledged`: a receipt came back. `unacknowledged`: it left and no receipt came back. `not_sent`: no connection was made, it never left. `maybe_sent`: no answer recorded (the gateway stopped first, or is still waiting). `discarded`: a response without a valid receipt was not used. These are `intent verify`'s categories. |
| `requests[].observed` | The `observed` entry for the request, or `null`: its `seq` and the observation's fields ([What came back](#what-came-back)). |
| `requests[].response` | The follow-up entry, or `null`: its `seq`, `kind` (`receipt`, `unacknowledged`, `discarded`), HTTP `status`, `acknowledged`, `signature_checked` (the gateway checked the receipt's signature when it logged it; receipts of the first key reads are checked by `intent verify`), `receipt_kid` (read from the receipt, not a check) and `reason`. |

For example, every value a search sent to Intent Cloud today:

```sh
intent log --json --action search --since 1d | jq -c '.requests[].fields'
```
