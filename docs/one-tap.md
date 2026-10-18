# One-tap purchases

With one tap, the buyer approves a purchase with their passkey and the gateway completes it with the developer's own Shop account: no second step at the merchant's checkout. Two things stay the same as for a hand-off. Every request is logged before it leaves, so one purchase gives you evidence you can hand to someone else: the requests sent to Intent Cloud and to Shop, the passkey-signed Approval, what Shop returned for the order and the binding check against what the buyer approved. And one gateway policy applies to every wallet: spend limits, merchants, categories and whether one tap is allowed at all.

## What works today, and what is planned

| | Status |
|---|---|
| One tap in [demo mode](demo.md) | Works. Ask for stickers and buy the holographic sticker: the demo completes it with a local fake Shop, and `intent log --demo` and `intent verify --demo` show the whole purchase. |
| The code path in `intent serve` | Built and tested against the fake Shop: when a Shop client is set and a Shop wallet is linked, `get_approval_status` completes a verified one-tap approval. |
| One tap for you | Planned: it needs a registered Shop client, and none exists yet (below). |
| Stores one tap can reach | Only a store whose storefront is its own `*.myshopify.com` domain. Every other merchant's cart is handed off from the start, until the store alias rule is settled. |
| Real purchases of any kind | Wait for the [launch gate](adr/0004-public-pre-alpha.md): the preview talks to the Intent Cloud staging host. |

<!-- feature: one-tap -->
!!! planned "One tap with your own Shop account"
    The gateway has no Shop client built in. Shop's public device-flow client is for a shopper's own agent, and a gateway shipped to others needs a client registered with Shop; that registration is being arranged. Until it exists, one tap runs in demo mode only. Every purchase outside the demo is handed off to the merchant's checkout.

## How to turn it on

Read the [known risks](threat-model.md#known-risks) before you link an account. Once you have a Shop client id:

```console
$ export INTENT_SHOP_CLIENT_ID=<client id>
$ export INTENT_WALLET_KEY_FILE=/path/outside/the/data/dir/wallet-key
$ intent init                  # offers "Pay in one tap with Shop?" at a terminal
$ intent wallet link shop      # or link it directly
$ intent wallet status         # linked, and the encrypted vault opens
```

`intent wallet link shop` prints a code and a Shop page; you approve there, in your own browser. The gateway asks for the scope `openid personal_agent` (no email) and keeps the token in an encrypted file in the data dir ([wallet vault](#what-the-gateway-keeps)). Without `INTENT_SHOP_CLIENT_ID` it sends nothing and says so. `intent init` skips the step with `--yes`, in demo mode and when there is no terminal to ask at; purchases are then handed off.

Your policy decides whether one tap may be used: `completion` lists `handoff`, `one_tap` or both, and both is the default ([Gateway policy](policy.md#completion-modes)). Restart the gateway after linking. `intent wallet unlink shop` asks Shop to revoke the token, deletes the vault file whatever the answer, and records whether Shop answered that it revoked it.

## What happens in one purchase

1. The agent calls `create_cart`. With a linked wallet and a store Shop can reach, the cart request offers `shop_agent` beside `handoff`, and the snapshot the buyer approves names the mode Intent Cloud returns.
2. The buyer approves with their passkey on intent's confirm page, as for any purchase.
3. The agent calls `get_approval_status`. The gateway checks the Approval, then completes the purchase inside that call: it asks Shop for a checkout, checks it against the approved snapshot (merchant, item, ZIP, total), reports `completing` to Intent Cloud, reads the checkout again, and sends one `complete_checkout`.
4. The agent calls again until the status says `ordered`, `failed` or `mismatch`. `ordered (read from Shop)` means Shop returned the order on a checkout read and the binding check passed.

The per-order limit is the smaller of your policy's `per_order_usd` and the budget Shop returns for the account. A purchase whose total is above it is refused before anything is sent to Shop. A `complete_checkout` that may have left is never sent again: after a crash or a restart the gateway only reads the checkout, and an answer it cannot settle stays `indeterminate` ("Sent to Shop, result unknown: check Shop orders") with its spend held ([ADR-0019](adr/0019-one-tap-completion.md)).

## What Shop holds, and what the gateway sends

Shop, not the gateway, holds the buyer's card, saved addresses and Shop budget. The gateway never sees or sends them (invariant 3):

- It chooses delivery by a saved-address id, an opaque id from the Shop account, never by address fields. If Shop asks for the fields, the step fails and nothing is sent.
- It keeps from each Shop answer only the fields it names (status, lines, total, store, order id, the ZIP as `match` or `differs`) and drops the rest on receipt.
- It logs each request to Shop with its token as a sha256 digest, and each answer only as a status, a sha256 and a size.

A dispute about a charge, a delivery or a refund is between the buyer, Shop and the merchant. What the gateway gives you is the record: `intent evidence <approval handle>` writes the purchase's [evidence pack](evidence.md), which anyone can check offline.

Shop's terms limit use to "personal, individual shopping use only, unless separately authorized by Shopify". Use one tap with your own Shop account only, within those terms.

## What the gateway keeps

| File | What it is |
|---|---|
| `<data dir>/wallet/shop.enc` | The Shop token, AES-256-GCM, mode 600. |
| `<data dir>/wallet/shop-checkouts/` | Each checkout id Shop issued for a purchase, sealed the same way, so a restarted gateway can read a checkout it may have completed. Deleted when the purchase ends. |
| The wallet key | From `INTENT_WALLET_KEY_FILE` (refused inside the data dir), else `INTENT_WALLET_KEY`, else a generated 600 file in your config folder. |
| `<data dir>/completer/` | One key per open cart, which signs that approval's reads and outcome reports ([ADR-0016](adr/0016-per-approval-completer-key.md)). |

Against malware running as your user, these files are obfuscation, not protection: see [Known risks](threat-model.md#known-risks).

## What you can check

- `intent log` shows each Shop call as a `call` line, `✓ answered 200 (no receipt: unsigned)`, and each outcome report sent to Intent Cloud ([a one-tap purchase in the log](log.md#a-one-tap-purchase)); `intent log -v` shows every entry, with the token as `redacted`.
- `intent verify` re-checks the outcomes and that each purchase has at most one `complete_checkout`, sent after it was claimed.
- Once a Shop client exists, `intent wallet check shop` compares the orders Shop returns for the account with the purchases in the log ([orders the log does not name](log.md#orders-the-log-does-not-name)).

What these show is what the gateway sent, what Intent Cloud acknowledged and what Shop returned. They make no claim about what Shop or the merchant does afterwards.
