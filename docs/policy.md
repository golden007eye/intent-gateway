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

At most the country and a coarse postcode leave the gateway as the ship-to location: a search through Shop sends only the country, and a submitted checkout carries the country and the coarse postcode (for the US, the 5-digit ZIP; for Canada, the first 3 characters; for Australia, the 4-digit postcode). The gateway coarsens the postcode as soon as `find_offers` gets it, and keeps or logs only the coarse part. Everything else is the baseline below. `intent policy show` prints the policy in force and where it came from.

The policy file is `<data dir>/policy.yaml` (on Linux `~/.local/share/intent-gateway/policy.yaml`), or `<data dir>/demo/policy.yaml` in demo mode. Set `INTENT_POLICY` to use another path. A running gateway reads its policy at start; restart it after a change.

## Schema v1

Every key except `version` and `approval` is optional. Any other key is refused.

```yaml
version: 1                    # required; must be 1
approval: passkey             # required; the only legal value
share:
  ship_to: postcode_only      # postcode_only (a coarse postcode) or none (no ship-to at all)
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

Offers carry no category of their own, so the gateway checks each offer and cart against the category of the search that found it. When `categories.block` lists anything, a search must therefore name a category. A search for a product alone is not sent; `find_offers` asks the agent for the category.

The **baseline** is the loosest policy the gateway will run, and every loaded policy is combined with it: passkey approval, at most 3 items per cart, a coarse postcode as the only ship-to detail, the categories excluded under the rules Intent Cloud enforces (health and medical; alcohol, tobacco, cannabis, adult and weapons; gift cards, crypto, subscriptions and digital goods), and both completion modes. In the preview, Intent Cloud also enforces a ceiling of $50 per order and $100 per week, and one for each other currency it lists; a policy limit above it changes nothing, since a checkout over the ceiling is refused at submit. The suggested caps are $20 per order and $40 per week: `intent policy add per-order-20` and `intent policy add weekly-40` ([Policy library](policy-library.md)).

### Limits outside the US

Spend limits are written in whole US dollars. A purchase is in the ship-to country's currency, and its price is never converted: instead the gateway puts each limit in that currency with the ceilings Intent Cloud returns in `GET /v1/meta`. For currency C, a limit is the USD limit × (C's ceiling / the USD ceiling), with the per-order ceilings for `per_order_usd` and `per_day_usd` and the weekly ceilings for `per_week_usd`, rounded down to a whole cent. With today's ceilings the suggested $20 and $40 are:

| Ships to | Per order | Per week |
|---|---|---|
| the US | $20 | $40 |
| Canada | CAD 28 | CAD 56 |
| Australia | AUD 30 | AUD 60 |

The daily and weekly limits count only purchases in the same currency, the way Intent Cloud enforces its weekly ceiling. When the meta Intent Cloud returns holds no valid currency table, or none for the currency, a search in it is refused with one line, and a purchase in it is never let through with no limit.

The gateway has the coarse-postcode rules for the UK (the outward code: `SW1A 1AA` is `SW1A`), Ireland (the Eircode's routing key: `D02`) and the euro countries Germany, France, the Netherlands, Spain, Italy, Belgium, Austria, Portugal and Finland (the first two digits: `10115` is `10`). It ships there once a later contract version adds them; until then a search there is refused: `intent ships to the US, Canada and Australia for now; the UK is coming soon.`

### Completion modes

`completion` lists how an approved purchase may be completed:

- `handoff`: the buyer pays by hand on the checkout page (Shop's, for a Shop checkout). A cart that names no mode is a hand-off.
- `one_tap`: the gateway pays the purchase from the agent budget of the developer's own linked Shop account, after the passkey Approval ([One-tap purchases](one-tap.md)).

Absent means both. `completion: [handoff]` keeps every purchase a hand-off; a cart for any other mode is refused with the rule `completion`. The mode is chosen at `create_cart`, before the passkey: one tap when the policy allows it and the agent budget covers the total, otherwise a hand-off; a policy without `handoff` (`completion: [one_tap]`) then refuses it. When one tap cannot pay an approved purchase, the hand-off is a new cart that needs a second approval. Like every other list, `completion` only narrows: combining two policies keeps the modes both allow, and `intent policy add` refuses a library policy that shares no mode with yours. Every purchase still needs your passkey Approval, whatever the mode.

For a one-tap purchase the per-order limit is the smallest of `per_order_usd`, the agent budget Shop returns for the account and the ceiling. When Shop shows no budget for the connection, a budget is never assumed: the cart is a hand-off, if the policy allows one. As for every purchase, it counts against the daily and weekly limits from the moment it waits for approval, and stops counting only on evidence the gateway holds that nothing was charged.

## What is refused at load time

A policy file is read strictly, so it cannot mean one thing to the gateway and another to a reviewer.

| Refused | Why |
|---|---|
| `approval:` anything but `passkey`, or missing | Purchase approval cannot be turned off (invariant 4). |
| `share.ship_to` other than `postcode_only` or `none`; `share.history: true` | Nothing beyond a coarse postcode can be shared. |
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

An `outbound` is a `search` (`category`, `must_haves`, `budget_usd`, `ship_to_zip`, the coarse postcode, and `ship_to_country`, US when absent) or a `cart` (`offer` with `merchant`, `category`, `price_usd`, `quantity`; beside it an optional `completion_mode`, `handoff` when absent). A case may add `now` and a `history` of earlier purchases (`{at, total_usd}`) for the daily and weekly limits. `blocked` lists the rules expected to refuse it. The command prints `ok` or `FAIL` per case and exits 0 only when all pass.

## What a policy cannot do

- Turn off the passkey Approval for a purchase.
- Send the buyer's name, postal address or card: the gateway never holds them.
- Raise a limit above the rules Intent Cloud enforces, such as the preview ceiling of $50 per order and $100 per week.
- Stop a program that reads the Shop token and pays Shop directly. The Shop budget is the only hard stop, because any program running as you can read the Shop token.
