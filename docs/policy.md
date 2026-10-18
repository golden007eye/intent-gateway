# Gateway policy

A gateway policy (`policy.yaml`) decides what may leave the gateway and how much may be spent. It can only **narrow** the rules Intent Cloud enforces, never loosen them: a policy that turns purchase approval off, or tries to allow anything the baseline refuses, is rejected at load time with an error. This is why a policy shared through the [policy library](policy-library.md) cannot switch off a safety rule ([ADR-0009](adr/0009-policy-v1-narrow-only.md)).

## The default: `zip-only`

With no policy file, the gateway uses the bundled `zip-only` policy and says so on stderr:

```yaml
version: 1
approval: passkey   # required; the only legal value
share:
  ship_to: postcode_only
```

Only a 5-digit ZIP leaves the gateway as the ship-to location, which is the minimum a search needs. Everything else is the baseline below. `intent policy show` prints the policy in force and where it came from.

The policy file is `<data dir>/policy.yaml` (on Linux `~/.local/share/intent-gateway/policy.yaml`), or `<data dir>/demo/policy.yaml` in demo mode. Set `INTENT_POLICY` to use another path. A running gateway reads its policy at start; restart it after a change.

## Schema v1

Every key except `version` and `approval` is optional. Any other key is refused.

```yaml
version: 1                    # required; must be 1
approval: passkey             # required; the only legal value
share:
  ship_to: postcode_only      # postcode_only (a 5-digit ZIP) or none (no ship-to at all)
  history: false              # false is the only legal value
spend:                        # whole US dollars, each optional
  per_order_usd: 60           # price × quantity of one cart
  per_day_usd: 40             # approved purchases in the last 24 hours, plus this cart
  per_week_usd: 150           # approved purchases in the last 7 days, plus this cart
quantity:
  max: 1                      # 1 to 3
merchants:
  allow: [shop.example]       # if present, only these hostnames and their subdomains
  block: [dropship.example]   # these hostnames and their subdomains
categories:
  block: [electronics]        # a category blocks its subcategories (electronics/headphones)
completion: [handoff]         # handoff, one_tap, or both (the default)
```

The offers Intent Cloud returns carry no category of their own, so the gateway checks each offer and cart against the category of the search that found it. When `categories.block` lists anything, a search must therefore name a category. A search for a product alone is not sent; `find_offers` asks the agent for the category.

The **baseline** is the loosest policy the gateway will run, and every loaded policy is combined with it: passkey approval, at most 3 items per cart, a 5-digit US ZIP as the only ship-to detail, the categories excluded under the rules Intent Cloud enforces (health and medical; alcohol, tobacco, cannabis, adult and weapons; gift cards, crypto, subscriptions and digital goods), and both completion modes.

### Completion modes

`completion` lists how an approved purchase may be completed:

- `handoff`: the buyer leaves the confirm page for the merchant's checkout and pays there. A cart that names no mode is a hand-off.
- `one_tap`: the gateway completes the purchase with the developer's own linked Shop account, after the passkey Approval ([One-tap purchases](one-tap.md)). Today this runs in demo mode only: one tap with your own account waits until Shop is proven to accept the gateway's own Shop client.

Absent means both. `completion: [handoff]` keeps every purchase a hand-off; a cart for any other mode is refused with the rule `completion`. With no linked wallet, or for a store one tap cannot reach, a cart is handed off; a policy without `handoff` (`completion: [one_tap]`) then refuses it. Like every other list, `completion` only narrows: combining two policies keeps the modes both allow, and `intent policy add` refuses a library policy that shares no mode with yours. Every purchase still needs your passkey Approval, whatever the mode.

For a one-tap purchase the per-order limit is the smaller of `per_order_usd` and the agent budget Shop returns for the account (in USD). When Shop shows no budget for the connection, one tap is refused before anything is sent to pay, and a new cart hands the purchase off: a budget is never assumed. As for every purchase, it counts against the daily and weekly limits from the moment it waits for approval, and stops counting only on evidence the gateway holds that nothing was charged.

## What is refused at load time

A policy file is read strictly, so it cannot mean one thing to the gateway and another to a reviewer.

| Refused | Why |
|---|---|
| `approval:` anything but `passkey`, or missing | Purchase approval cannot be turned off (invariant 4). |
| `share.ship_to` other than `postcode_only` or `none`; `share.history: true` | Nothing beyond a ZIP can be shared. |
| `quantity.max` above 3; a spend limit that is zero, negative or not a whole number | It would loosen, or read as "no limit". |
| `categories.allow` | A policy can only block categories. |
| A `completion` mode other than `handoff` or `one_tap`, or a list of more than two | An unknown mode could be read as "any way at all". |
| `completion: []` (refused as invalid) | A policy that allows no mode could never complete a purchase. |
| Unknown keys, duplicate keys, YAML merge keys (`<<`), more than 16 aliases, files over 64 KiB | A file that parses two ways could hide a loosened rule. |
| A merchant that is not a bare hostname (a scheme, port, path or `*`) | Hostnames are compared after Unicode and IDN normalisation, so look-alikes match. |

The error names the file, the key and the reason, and the gateway does not start:

```console
$ intent policy show
intent: policy /home/me/.local/share/intent-gateway/policy.yaml: approval: purchase approval must be `passkey`; a policy cannot turn it off or change it; fix that line, or delete the file to use the bundled zip-only policy
```

## The commands

```console
$ intent policy show                   # the active policy and its policy.lock
$ intent policy add per-order-60       # narrow it with a library policy (diff first)
$ intent policy test cases.yaml        # run test cases against the active policy
$ intent policy test cases.yaml --policy other.yaml
```

`intent policy add` is described in [Policy library](policy-library.md).

### Test cases

`intent policy test` runs sample requests against a policy and checks the decision. Each library policy ships its own `cases.yaml`. This file passes against `per-order-60`:

```yaml
- name: a 5-digit ZIP is sent
  outbound: {kind: search, category: home, ship_to_zip: "94110"}
  expect: {send: true}
- name: a ZIP+4 is refused
  outbound: {kind: search, category: home, ship_to_zip: "94110-1234"}
  expect: {send: false, blocked: [share.ship_to]}
- name: a cart over the limit is refused
  outbound: {kind: cart, offer: {merchant: shop.example, category: home, price_usd: 61, quantity: 1}}
  expect: {send: false, blocked: [spend.per_order_usd]}
```

An `outbound` is a `search` (`category`, `must_haves`, `budget_usd`, `ship_to_zip`) or a `cart` (`offer` with `merchant`, `category`, `price_usd`, `quantity`; beside it an optional `completion_mode`, `handoff` when absent). A case may add `now` and a `history` of earlier purchases (`{at, total_usd}`) for the daily and weekly limits. `blocked` lists the rules expected to refuse it. The command prints `ok` or `FAIL` per case and exits 0 only when all pass.

## What a policy cannot do

- Turn off the passkey Approval for a purchase.
- Send the buyer's name, postal address or card: the gateway never holds them.
- Raise a limit above the rules Intent Cloud enforces.
