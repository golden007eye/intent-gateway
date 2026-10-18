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

Each line's outcome is what the chain records for its requests: `✓ receipt` (a receipt came back), `⚠ sent, no receipt`, `⚠ not sent: no connection was made`, `⚠ maybe sent, no answer recorded` (the gateway stopped first, or is still waiting), `✗ answer discarded: no valid receipt`, `✗ nothing sent` (blocked), `✗ refused` (an answer that did not match what was asked), and for a call to a wallet destination `✓ answered 200 (no receipt: unsigned)` (`⚠` when the status is 400 or more): the destination answered with that status, recorded in a response entry; a wallet signs no receipt. `✓ passkey proof checked` marks an Approval the gateway verified before it chained it; `intent verify` re-checks it. The line "Sent to Intent Cloud only" lists every field of the requests shown that left or may have left. Each wallet destination with a request shown gets a line of its own, "Sent to Shop only: …": its tool arguments by name, then the tool name and the JSON-RPC envelope, and how many credentials went with them (such as the Shop token), which the log holds only as digests. The lines say what was logged as sent, never what a destination does with it. "Never sent: your name, postal address, card" is printed only after the gateway's buyer-identity check finds none in their logged values; otherwise the line names the request where it found one, or says which requests it could not check.

Times and date headers are in the local time zone; `--utc` shows UTC. On a terminal the lines are cut to its width with `…`, the values first so the outcome stays visible; piped, nothing is cut. Without a UTF-8 locale the symbols are plain ASCII (`ok`, `!`, `x`, `->`).

The values are the developer's own record of what left the machine: the category, product, must-haves, budget and ZIP code of a search, the offer handle, quantity and ZIP code of a cart. A request the gateway policy blocked keeps, in its `block` entry, the structured values the policy held back (`held`: the category, such as `alcohol`, the ZIP code, or a cart's offer title and merchant), so the line can name them; they never left the machine. The free text of a search's `product` is never kept: the buyer-identity check cannot tell a name in free text from a product name. A request blocked for buyer identity keeps no value at all: only its field names and the identity finding that held it back. A request the gateway refused to log as it was (a credential in the query, a body that is not plain JSON, a credential in a request to Intent Cloud; see [ADR-0014](adr/0014-log-before-send-every-destination.md)) is shown with that reason as `not logged as sent: …` and `✗ nothing sent`.

A credential in a request to a wallet destination is logged as `[redacted sha256:<hex>]`; every view shows it as `redacted (sha256 1a2b3c4d…)`, and `-v` lists each redacted header the same way. A value under a credential key that is not a redaction marker (a hand-edited chain, which `intent verify` fails) is never printed: the views and `--json` show `[a credential in clear, not shown: intent verify fails this entry]` instead.

`-v` shows times in the local time zone too. `--json` keeps each entry's `ts`, which is UTC.

Colour is used only when the output is a terminal, and never with `NO_COLOR` set, `TERM=dumb` or `--no-color`. `--json` is never coloured.

## Filters

| Option | Keeps |
|---|---|
| `--action search,cart` | The actions of these kinds: `start`, `keys`, `search`, `cart`, `status`, `outcome` (an outcome report the gateway sent to Intent Cloud), `approval`, `blocked`, `pin`, `flagged`, `wallet`, `call`. |
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
- `blocked`: a request the gateway held back; nothing was sent. `facts.block_kind` says what held it: a gateway `policy` rule, buyer `identity` in the body, or a `logging` rule, as the block entry's `rule` records it (a block without `rule` is read from its reasons); for a wallet destination, `facts.destination` names it.
- `pin`: an approver pin written by `intent approver accept`. `flagged`: a passkey flagged as not the pinned approver.
- `wallet`: a wallet change on this machine: the Shop wallet linked, or unlinked (`intent wallet unlink shop` deletes its vault file) with whether Shop confirmed revoking the token (`token revoked at Shop`) or not (`token not revoked (deleted here only)`); or a Shop check (`intent wallet check shop`, [below](#orders-the-log-does-not-name)): how many orders Shop reported and how many no purchase in the log names.
- `call`: one request to a wallet destination (Shop) and its response entry: the operation, its argument names, and the status that came back. A call has no receipt; one without a response entry is `maybe sent`.

A search with a linked Shop wallet (the [search seam](adr/0021-search-seam.md)) is a `call` to Shop, `search_catalog`, and no `search` action: nothing is sent to Intent Cloud for it. Its argument names are the query text, the country and currency context, the price ceiling, the ships-to country and the page size; no postcode. Shop's answer is logged as a status, a sha256 and a size, like every Shop answer.

A cart or status check the gateway refused after an answer (the cart, snapshot or proof did not match) carries outcome `refused` and the reasons in `blocked`.

## A one-tap purchase

A [one-tap purchase](one-tap.md) adds entries after its approval, all appended before the step they record:

- A `call` line to the storefront (destination `storefront`, endpoint `meta_json`): the store pair check's `GET <merchant origin>/meta.json`, logged with its URL and fixed headers before it left, answered with a status and no receipt. It is absent when a pass from the last 24 hours was reused.
- `call` lines to Shop: `create_checkout` (the quote), `get_checkout` (the read before paying, and any read after) and the one `complete_checkout`. Each is answered with a status and no receipt; the checkout id they carry is logged as a digest.
- `outcome` lines: each outcome report sent to Intent Cloud (`completing`, then `ordered`, `failed` or `mismatch`), with its receipt.
- On the approval itself, what happened after it: `--json` gives `facts.outcome_state` (`completing`, `ordered`, `failed`, `mismatch`, `indeterminate`, …), `facts.outcome_basis` (`local`, the gateway's own read of Shop's checkout, or `cloud`, the verified statement Intent Cloud returns), `facts.outcome_source` (`shop_api` for "read from Shop", `gateway_precheck` for the gateway's own refusal) and `facts.order_ref`. Once the gateway has evidence of its own, it wins over what Intent Cloud reported.

The chain also holds a `store_pair` entry for each verdict of the store pair check (`result` `pass` or `fail` with its `reason`, and the GET it read, `disclosure_seq`, or the pass it reused, `cached_from`), a `completion` entry (the redemption: the checkout ref hash and the report id) and a `complete_attempt` entry, each of the last two appended once per purchase, and an `outcome` entry for each outcome with its binding check. `-v` lists them by kind; the panel's Server log shows their bodies field by field, and `intent verify` re-checks them. These say what the gateway sent and what came back from Intent Cloud and Shop; none of them says what Shop or the merchant did afterwards.

## Orders the log does not name

<!-- feature: wallet-check -->
!!! planned "Checking Shop for orders the log does not name"
    `intent wallet check shop` is in the CLI, but it cannot run for you yet: it needs a linked wallet, and Shop does not accept the gateway's own client yet (a formal registration is pending), so linking needs `INTENT_SHOP_CLIENT_ID` set explicitly to a client Shop accepts, such as Shop's public client for your own agent ([One-tap purchases](one-tap.md#how-to-turn-it-on)). The fields it reads from Shop's order list (`shopify_order_id`, `seller.domain`, `placed_at`, `totals`, `pagination.has_next_page`) are the ones the S1 spike saw on a real Shop account (2026-10-18); an order whose fields differ comes back with no total, origin or time, never with buyer details.

The log shows what went through this gateway. A linked Shop account can also be spent from in other ways: in the Shop app, by another agent, or by Shop's own agent payments. `intent wallet check shop` compares the two, on demand; nothing polls in the background.

```sh
intent wallet check shop             # the last 7 days
intent wallet check shop --since 30d # or a date: --since 2026-10-01
```

It asks Shop for the account's recent orders with one `search_orders` request. Like every Shop request, it is appended to the log before it leaves, and the answer is logged only as a status, a sha256 and a size. From each order Shop reported, the gateway keeps four values: its order reference (`gid://shopify/Order/<shopify_order_id>`, the same reference a one-tap checkout returns; Shop's own id for an order it read from an email), its total, the merchant's storefront origin (`https://` and `seller.domain`) and when it was placed. Shop's `checkout_id` on an order is an order-status link with a credential in it, not the checkout, and is never read. Everything else in the answer is dropped on receipt, so the buyer's name, email, phone, addresses and the order's line text are never printed, logged or kept.

The output says how many orders Shop reported in the period, how many a purchase in this log names (an `outcome` entry with that order reference), and lists the rest with their total, merchant origin and time, under "Not matched". An unmatched order is one this log does not name; the check cannot say how it was placed. Only a one-tap purchase writes an `outcome` entry with an order reference, so an order placed by hand-off, in the Shop app or by another agent shows as not matched. Totals are summed in USD; an order Shop reported without a USD total is counted and left out of the sum. The gateway asks for one page of up to 50 orders: when Shop says more exist, or returns a full page of 50, the output says the counts cover only the orders it returned, the unmatched line reads "Not matched among the orders returned", and the entry records `complete: false`.

Each check is chained as a `wallet` entry `{rail, action: "checked", since, order_count, unmatched_count, unmatched_total_minor, complete}`: counts and a total, never an order. `intent verify` fails a `checked` entry with any other key. `intent log` shows it as `Shop wallet checked · Shop reported 3 orders since 2026-10-10 · 2 not matched to a purchase in this log (21.49 USD)`, and the panel's feed shows the same line, as a warning when any order is unmatched or the check covers only part of the orders.

What it can't see: orders Shop does not report to the gateway's token, orders older than the period or beyond the first page, and anything about an order beyond the four values above. The command needs a linked wallet (`intent wallet link shop`); without one it says so, exits 1 and sends nothing.

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
| `v` | The format version, 2. A field is only ever added within a version. Version 2 added `requests[].observed`, the facts from observations and `held`, and the outcomes `rejected` and `expired`; every version 1 field is unchanged, so a reader of version 1 can read version 2 lines. Wallet destinations added, within version 2, the action `call`, the delivery and outcome `answered`, the response kind `response`, `requests[].destination`, `requests[].redacted`, `response.bytes`, `response.body_sha256` and the facts `destination` and `block_kind`; the Shop check added the `check_*` facts. A chain written before observations prints version 2 lines with `observed: null` and none of the new facts. |
| `time`, `seq` | The `ts` and seq of the action's first entry. |
| `seqs` | Every entry of the action, in chain order. |
| `action` | One of the kinds above. |
| `outcome` | For requests, the worst `delivery` of the action's requests (`answered` for a call); otherwise `blocked`, `refused`, `approval_asked`, `approved`, `pinned`, `flagged` or `recorded` (a key statement, a session start with no request, or a wallet change). A status check whose observation says `rejected` or `expired` has that outcome. |
| `facts` | The readable facts the action's entries hold, each present only when held: `category`, `product`, `must_haves`, `budget_minor`, `currency`, `zip`, `country`, `offer_handle`, `quantity`, `approval_handle`, `approval_url`, `total_minor`, `expires_at`, `fingerprint`, `pinned`, `flag_reason`, `outcome_state`, `outcome_basis`, `outcome_source` and `order_ref` (of an approval, once something happened after it), `key_kid`, `keys_expire_at`, `session_id`, `wallet_rail`, `wallet_action` and `revoked` (of a wallet change), `check_since`, `check_orders`, `check_unmatched`, `check_unmatched_total_minor` and `check_complete` (of a Shop check), `destination` and `endpoint` (of a call, and of a blocked request to a wallet destination), `endpoint`, `field_names` and `block_kind` (of a blocked request), `held` (the values a policy block held back), and from observations `offers_count`, `offers_hidden`, `offers`, `title`, `merchant` and `approval_state` (the latest state Intent Cloud returns for the approval; on a cart too). |
| `blocked` | What held a request back, or why an answer was refused. |
| `requests[]` | Each request the action logged. |
| `requests[].destination` | `intent_cloud`, or the other destination the request went to (`shop`, `shop_accounts`, or `storefront` for the store pair check). |
| `requests[].fields` | The values sent, by dotted path, from the logged bytes; `{}` for no body; `null` for an entry without body bytes. A credential is its redaction marker, as logged. |
| `requests[].redacted` | The credentials the logged request holds only as digests: `[{at, sha256}]`, such as `headers.authorization`; `[]` for none. |
| `requests[].delivery` | `acknowledged`: a receipt came back. `answered`: a wallet destination answered, its response entry recorded the status. `unacknowledged`: it left and no receipt came back. `not_sent`: no connection was made, it never left. `maybe_sent`: no answer recorded (the gateway stopped first, or is still waiting). `discarded`: a response without a valid receipt was not used. These are `intent verify`'s categories. |
| `requests[].observed` | The `observed` entry for the request, or `null`: its `seq` and the observation's fields ([What came back](#what-came-back)). |
| `requests[].response` | The follow-up entry, or `null`: its `seq`, `kind` (`receipt`, `unacknowledged`, `discarded`), HTTP `status`, `acknowledged`, `signature_checked` (the gateway checked the receipt's signature when it logged it; receipts of the first key reads are checked by `intent verify`), `receipt_kid` (read from the receipt, not a check), `reason`, and for a response entry `bytes` and `body_sha256` (the size and digest of what came back, never its content). |

For example, every value a search sent to Intent Cloud today:

```sh
intent log --json --action search --since 1d | jq -c '.requests[].fields'
```
