# One-tap purchases

With one tap, the buyer approves a purchase with their passkey and the gateway completes it with the developer's own Shop account: no second step at the merchant's checkout. Two things stay the same as for a hand-off. Every request is logged before it leaves, so one purchase gives you evidence you can hand to someone else: the requests sent to Intent Cloud and to Shop, the passkey-signed Approval, what Shop returned for the order and the binding check against what the buyer approved. And one gateway policy applies to every wallet: spend limits, merchants, categories and whether one tap is allowed at all.

## What works today, and what is planned

| | Status |
|---|---|
| One tap in [demo mode](demo.md) | Works. Ask for stickers and buy the holographic sticker: the demo completes it with a local fake Shop, and `intent log --demo` and `intent verify --demo` show the whole purchase. |
| The code path in `intent serve` | Built and tested against a fake Shop that answers with the shapes the S1 spike captured from Shop (one real order, 2026-10-18): when a Shop wallet is linked, `get_approval_status` completes a verified one-tap approval. |
| One tap for you | Planned: Shop does not accept the gateway's own client yet (a formal registration is pending); until it does, linking needs `INTENT_SHOP_CLIENT_ID` (below). |
| One tap on Intent Cloud staging | Not possible: the staging store's test payment gateway makes Shop refuse to pay (`checkout_completion_ineligible`). Staging covers hand-off only; one tap is proven by hand with a small real order at a real store with the developer's own Shop account. |
| Stores one tap can reach | A Shopify store whose `*.myshopify.com` domain Intent Cloud returns with the offer (contract 1.6.1): the offer, the cart and the snapshot the buyer approves name the pair, and before paying the gateway checks it against the storefront itself ([the store pair check](#the-store-pair-check)). Any other merchant's cart is handed off from the start. |
| Real purchases of any kind | Wait for the [launch gate](adr/0004-public-pre-alpha.md): the preview talks to the Intent Cloud staging host. |

<!-- feature: one-tap -->
!!! planned "One tap with your own Shop account"
    The gateway signs in to Shop as its own client: the client-ID metadata document at `https://gateway.intentai.shop/shop-client.json`, whose client id is that URL. Shop does not accept the gateway's own client yet (a formal registration is pending): Shop answers `invalid_client`, and `intent wallet link shop` says so in one line and tries no other client. Until then, linking needs `INTENT_SHOP_CLIENT_ID` set explicitly to a client Shop accepts, such as Shop's public client for your own agent. Until one tap with your own account is proven, every purchase outside the demo is handed off to the merchant's checkout.

## How to turn it on

Read the [known risks](threat-model.md#known-risks) before you link an account. Until Shop accepts the gateway's own client, set `INTENT_SHOP_CLIENT_ID` to a client Shop accepts, such as Shop's public client for your own agent. The wallet remembers the client it was linked with (below).

```console
$ export INTENT_SHOP_CLIENT_ID=<a client id Shop accepts>
$ export INTENT_WALLET_KEY_FILE=/path/outside/the/data/dir/wallet-key
$ intent init                  # offers "Pay in one tap with Shop?" at a terminal
$ intent wallet link shop      # or link it directly
$ intent wallet status         # linked, the encrypted vault opens, and the budget Shop shows
```

In the Shop app, turn on "Allow agent to pay" with a budget for the connection. One tap pays from that agent budget only, never from your Shop Pay card; with no budget shown, every one-tap purchase is refused before anything is sent to pay, and a new cart hands it off.

`intent wallet link shop` prints a code and a Shop page; you approve there, in your own browser. The gateway asks for the scope `openid personal_agent` (no email) and keeps the tokens in an encrypted file in the data dir ([wallet vault](#what-the-gateway-keeps)). Shop's access token lasts an hour; the gateway refreshes it with the refresh token Shop issued, logging that request first with the refresh token as a digest, and keeps the new tokens in the vault. If Shop refuses the refresh, link again.

The gateway signs in as its own Shop client, `https://gateway.intentai.shop/shop-client.json`. `INTENT_SHOP_CLIENT_ID` replaces it with another client id or client-ID metadata URL, for example Shop's public client for your own agent; only that setting changes the client, and the gateway never switches to another one by itself. When Shop answers `invalid_client`, the command prints one line that says which client Shop refused and names `INTENT_SHOP_CLIENT_ID`, and sends nothing more. A linked wallet keeps the client it was linked with, in its vault, for every Shop call, refresh and revocation, so a gateway started without `INTENT_SHOP_CLIENT_ID` (the `claude mcp add` line sets only `INTENT_CLOUD_URL`) still uses it. If `INTENT_SHOP_CLIENT_ID` later names another client, the gateway says so in one line and keeps the linked one; only `intent wallet link shop` again changes it. A vault from before the client was kept in it uses `INTENT_SHOP_CLIENT_ID` when set, else the gateway's own client, and records it at the next refresh. `intent init` skips the step with `--yes`, in demo mode and when there is no terminal to ask at; purchases are then handed off.

Your policy decides whether one tap may be used: `completion` lists `handoff`, `one_tap` or both, and both is the default ([Gateway policy](policy.md#completion-modes)). Restart the gateway after linking. `intent wallet unlink shop` asks Shop to revoke the refresh token and the access token, deletes the vault file whatever the answers, and records whether Shop answered that it revoked both. Revoking does not remove the connection from the Shop app: remove it there too (Shop app › Connections). `intent wallet status` reads the account once, through the log; a connection removed in the Shop app shows as not linked at Shop, with one tap unavailable.

## What happens in one purchase

1. The agent calls `create_cart`. With a linked wallet and an offer that names the merchant's `*.myshopify.com` domain, the cart request offers `shop_agent` beside `handoff`, and the snapshot the buyer approves names the mode Intent Cloud returns and the store pair.
2. The buyer approves with their Intent Cloud passkey (invite-only during preview) on intent's confirm page, as for any purchase.
3. The agent calls `get_approval_status`. The gateway checks the Approval, then completes the purchase inside that call: it reads the account's budget, checks the store pair against the merchant's storefront, asks Shop for a checkout with the item and quantity only, checks it against the approved snapshot (store, item, ZIP, total) and that it offers the agent budget as payment, reports `completing` to Intent Cloud, reads the checkout again, and sends one `complete_checkout` paying with the agent budget.
4. The agent calls again until the status says `ordered`, `failed` or `mismatch`. `ordered (read from Shop)` means Shop returned the order on a checkout read and the binding check passed.

The per-order limit is the smaller of your policy's `per_order_usd` and the agent budget left that Shop returns for the account. A purchase whose total is above it, or made while Shop shows no budget, is refused before anything is sent to Shop. A `create_checkout` that got no usable answer is never sent again for that purchase (Shop makes a new checkout for a repeated request), so the purchase ends `failed` and a new cart hands it off. A `complete_checkout` that may have left is never sent again: after a crash or a restart the gateway only reads the checkout, and an answer it cannot settle stays `indeterminate` ("Sent to Shop, result unknown: check Shop orders") with its spend held ([ADR-0019](adr/0019-one-tap-completion.md)).

## The store pair check

Shop names a store by its `*.myshopify.com` domain; the buyer sees the storefront. Intent Cloud pairs the two, and the passkey signs the pair, but the buyer cannot judge it. So before it pays, the gateway asks the storefront itself ([ADR-0020](adr/0020-signed-store-pair-and-storefront-check.md)):

- One `GET https://<storefront>/meta.json`, before the gateway reports `completing` and before any Shop checkout is made. The request carries a fixed set of headers and nothing else: no cookie, no credential, no `Authorization`, nothing about the buyer. It is logged before it leaves, as destination `storefront`, and its answer is kept as a status, a sha256 and a size.
- It passes only when the answer is a 200 `application/json` object, at most 64 KiB, with no duplicate member names, whose `myshopify_domain` is, lowercased, exactly the signed one (ASCII only). A redirect is never followed. The storefront has 5 seconds. The gateway refuses a storefront name that is an IP address or `localhost`, or that resolves to a private or other non-public address, and it connects only to the address it checked.
- A failure ends the purchase `failed` before anything is paid or reported (`store_pair:<rule>` in the log); the gateway sends Intent Cloud no report, so the approval is left approved there, and a new cart hands the purchase off. A pass is reused for 24 hours at most, by any gateway process on the data dir, and a failure is never reused. If the pair no longer passes right before `complete_checkout`, nothing is sent.

What it proves: at that moment, the storefront at the origin the buyer approved names the same Shopify store the passkey signed. What it does not prove: who runs the storefront. Whoever controls that origin controls the answer, as they control the checkout. What it costs: the merchant's storefront sees your IP address before a one-tap purchase: once per store and day while the check passes, and on each purchase after a failure. A hand-off purchase never makes this request.

## What Shop holds, and what the gateway sends

Shop, not the gateway, holds the buyer's card, saved addresses and Shop budget. The gateway never sees or sends them (invariant 3):

- It sends no address and no address id: `create_checkout` carries the item and quantity only. If Shop asks for address fields, the step fails and nothing more is sent.
- It keeps from each Shop answer only the fields it names (budget left, status, lines, total, store, order id, whether the agent budget is offered, the ZIP as `match` or `differs`) and drops the rest on receipt.
- It logs each request to Shop with its tokens, the checkout id and the payment instrument's credential as sha256 digests, and each answer only as a status, a sha256 and a size.

What the S1 spike saw on one real order (2026-10-18), which the gateway is built to:

- Shop's answers carry the buyer's email, phone, names, full saved addresses and a payment credential per card, under the scope `openid personal_agent` too. The gateway drops them when it reads the answer.
- With the lines alone, `create_checkout` came back with the preferred saved address filled in and ready to complete. A checkout offered two payment instruments, the Shop Pay card and the agent budget; paid from the budget, Shop showed no prompt of its own.
- `complete_checkout` answered in about 4 seconds with the order. The gateway's wallet timeout is 30 seconds; an answer that does not come is reconciled by reading the checkout, never by sending again.
- A checkout names no merchant; it lives at the store's `*.myshopify.com` domain. The binding check therefore reads the store the checkout is at, and accepts it only as the myshopify domain the buyer's passkey signed beside the storefront.
- A store that agents cannot complete at answered `checkout_completion_ineligible`; the gateway reports that as failed and never as ordered.

A dispute about a charge, a delivery or a refund is between the buyer, Shop and the merchant. What the gateway gives you is the record: `intent evidence <approval handle>` writes the purchase's [evidence pack](evidence.md), which anyone can check offline.

Shop's terms limit use to "personal, individual shopping use only, unless separately authorized by Shopify". Use one tap with your own Shop account only, within those terms.

## What the gateway keeps

| File | What it is |
|---|---|
| `<data dir>/wallet/shop.enc` | The Shop token, AES-256-GCM, mode 600. |
| `<data dir>/wallet/shop-checkouts/` | Each checkout id Shop issued for a purchase, sealed the same way, so a restarted gateway can read a checkout it may have completed. Deleted when the purchase ends. |
| The wallet key | From `INTENT_WALLET_KEY_FILE` (refused inside the data dir), else `INTENT_WALLET_KEY`, else a generated 600 file in your config folder. |
| `<data dir>/account-key.json` | The account key: an Ed25519 key `intent init` makes once, mode 600, never replaced ([ADR-0022](adr/0022-account-key.md)). Only its public half is ever sent. |
| `<data dir>/completer/` | One key per open cart, which signs that approval's reads and outcome reports ([ADR-0016](adr/0016-per-approval-completer-key.md)). |

Against malware running as your user, these files are obfuscation, not protection: see [Known risks](threat-model.md#known-risks).

## What you can check

- `intent log` shows each Shop call, and the store pair check's GET to the storefront, as a `call` line, `✓ answered 200 (no receipt: unsigned)`, and each outcome report sent to Intent Cloud ([a one-tap purchase in the log](log.md#a-one-tap-purchase)); `intent log -v` shows every entry, with the token as `redacted`.
- `intent verify` re-checks the outcomes, that each purchase has at most one `complete_checkout`, sent after it was claimed, and that a purchase whose snapshot signs a store pair was redeemed only after the store pair check passed.
- Once a Shop client exists, `intent wallet check shop` compares the orders Shop returns for the account with the purchases in the log ([orders the log does not name](log.md#orders-the-log-does-not-name)).

What these show is what the gateway sent, what Intent Cloud acknowledged and what Shop returned. They make no claim about what Shop or the merchant does afterwards.
