# One-tap purchases

With one tap, the buyer approves a purchase with their passkey and the gateway pays it from the agent budget of the developer's own Shop account: no second step at a checkout page. Every request is logged before it leaves, so one purchase gives you evidence you can hand to someone else: the requests sent to Intent Cloud and to Shop, the passkey-signed Approval, what Shop returned for the order and the binding check against what the buyer approved. One gateway policy applies to every purchase: spend limits, stores, categories and whether one tap is allowed at all.

## Who can use it

| | Status |
|---|---|
| [Demo mode](demo.md) | Works for anyone, with no invite and no account. Ask for stickers: the demo searches a local fake Shop, submits the checkout, and pays it in one tap after you approve. `intent log --demo` and `intent verify --demo` show the whole purchase. |
| Real purchases | Need an invite. They go through the Intent Cloud host this preview uses by default, where approving needs an Intent Cloud passkey made at an invite-gated sign-up, and your own Shop account, linked as below. The gateway's code for them is tested against a fake Shop that answers with the shapes the S1 spike captured from Shop (one real order, 2026-10-18). |
| The ceiling | Intent Cloud enforces $50 per order and $100 per week in the preview, and a ceiling for each other currency it lists (`GET /v1/meta`). Suggested caps for your policy: $20 per order and $40 per week. |
| Outside the US | Canada, Australia, the UK, Ireland and the euro countries, in the currency the table Intent Cloud returns gives each (CAD, AUD, GBP, EUR), with the caps scaled by the ceilings Intent Cloud returns ([Gateway policy](policy.md#limits-outside-the-us)). Shop agent payments outside the US are not yet checked against a real account (an open item), so a first order there may go to Shop's checkout page instead. |
| Stores | A Shopify store that Shop search returns. Before paying, the gateway checks the store's `*.myshopify.com` domain against the storefront itself ([the store pair check](#the-store-pair-check)). |

**The Shop budget is the only hard stop.** Any program running as you, your agent included, can read the Shop token and pay Shop directly, around the passkey, your policy, the ceiling and Pause. Keep the agent budget small; to stop agent payments outright, turn the budget off in the Shop app.

## How to turn it on

Read the [known risks](threat-model.md#known-risks) before you link an account. Shop does not accept the gateway's own client yet (a formal registration is pending), so linking needs `INTENT_SHOP_CLIENT_ID` set explicitly to a client Shop accepts, such as Shop's public client for your own agent. The wallet remembers the client it was linked with (below).

```console
$ export INTENT_SHOP_CLIENT_ID=<a client id Shop accepts>
$ export INTENT_WALLET_KEY_FILE=/path/outside/the/data/dir/wallet-key
$ intent init                  # makes the account key; offers "Pay in one tap with Shop?" at a terminal
$ intent wallet link shop      # or link it directly (from an agent's shell: --start, then --finish; below)
$ intent wallet status         # linked, the encrypted vault opens, and the budget Shop shows
```

In the Shop app, turn on "Allow agent to pay" with a budget for the connection. One tap pays from that agent budget only, never from your Shop Pay card. When the budget does not cover a checkout, the purchase goes to Shop's checkout page instead (a hand-off), if your policy allows it.

### Linking from an agent's shell

An agent's shell (Claude Code's Bash tool, for one) shows a command's output only once the command ends, so a link that waits for your approval would hide its code until it gave up. Link in two steps there instead:

```console
$ intent wallet link shop --start
Open https://…/activate?user_code=ABCD-EFGH and approve the code ABCD-EFGH in Shop before 2026-10-18T12:10:00Z, then run intent wallet link shop --finish
$ intent wallet link shop --finish
$ intent wallet status --wait-budget
Agent payments on: $40.00 per week, $40.00 left
```

`--start` sends the device authorization (logged first, like every request), prints that one line and exits. It keeps the pending sign-in, which holds Shop's device code, sealed in the wallet vault like the tokens (`<data dir>/wallet/shop-pending.enc`, mode 0600); the device code is never printed. Running `--start` again replaces it and says so. `--finish` waits for your approval with the same rules as the one-step link (Shop's interval, 5 s more after each `slow_down`, never past the code's expiry, which is 10 minutes at most) and keeps the tokens as it does. Approved, declined, expired or refused, it deletes the pending sign-in. With none pending, or an expired one, it prints one line naming `--start` and sends nothing. A busy Shop (HTTP 429 or 5xx with no error code) is asked again 5 s later. If `--finish` stops before Shop answers (Ctrl-C, a killed shell, a log that cannot be written), run it again: it goes on with the same code. Only one `--finish` at a time can hold a pending sign-in. A sign-in started as another client, or with another `INTENT_SHOP_AUTH_URL` or `INTENT_SHOP_MCP_URL`, is not finished: restore the setting, or `--start` again.

After `--finish` links the wallet, it reads the account once (through the log). When agent payments are already on, it prints the `--wait-budget` line below. Otherwise it prints the next step in two lines: Shop's connections page, then what to do there:

```console
https://shop.app/account/connections
Tap intent, turn on Allow agent to pay for me, enter $160.
```

The page is the one Shop's answer names, printed only when it is an https page on shop.app (S1's `https://shop.app/account/connections` when Shop names none); a page anywhere else is not printed, only the second line. The connection is "Personal Agent" when the wallet was linked as Shop's public client, and "intent" otherwise. The amount is 4 × your policy's weekly cap, at most 4 × the weekly ceiling (also used when the policy sets no weekly cap), in the currency of your Shop account: $160 with `weekly-40`, CAD 224 for an account in Canadian dollars. The gateway reads the ceilings from Intent Cloud's meta (logged, like every request, with its key statement); when it cannot, it says so in a `Note:` line and names no amount.

Agent payments that are on but have less left than one purchase may cost (the smallest of your policy's per-order, per-day and weekly caps and the per-order ceiling, in the budget's currency) would quietly hand every purchase off. So `--finish`, `intent wallet status` and `--wait-budget` print the low case instead, in two lines, the page as above and then:

```console
Agent payments are on, but only $6.02 is left; raise it to $160.
```

In Canadian dollars the same line reads `Agent payments are on, but only CAD 6.00 is left; raise it to CAD 224.`

When the limit is already at or above the suggested amount, the little left comes from spending this period, so the line says to wait for Shop to renew the budget (at the time Shop gives, when it gives one) instead of raising it.

`intent wallet status --wait-budget` then reads the account through the log every 5 seconds (longer after errors, up to a minute), for 10 minutes or `--timeout <s>`, until Shop shows an agent budget with a limit and at least one purchase left. It prints `Agent payments on: <limit> <period>, <amount> left` with the period as Shop names it, and exits 0. While the amount is low it prints the low lines once and keeps reading. A budget in a currency missing from the currency table Intent Cloud returns is not compared with the policy's limits: the success line comes with one note saying so. Above 4 × your policy's weekly cap (or of the weekly ceiling, whichever is lower), it adds a warning line: the Shop budget is the only hard stop. It stops at once, exit 1, when Shop says the connection is gone or refuses the token. On timeout it prints one line saying what to turn on, raise or wait for, naming the page and the connection as the next step does; a budget Shop shows with no limit is named as such. A wallet vault with no token stops it at once, with nothing sent.

`intent init` makes the gateway's account key once, `<data dir>/account-key.json` ([ADR-0022](adr/0022-account-key.md)). There is one per developer: every submitted checkout carries its public half, and your first passkey approval pins it to you. To replace it today, move `account-key.json` aside and run `intent init` again.

`intent wallet link shop` prints a code and a Shop page; you approve there, in your own browser. The gateway asks for the scope `openid personal_agent` (no email) and keeps the tokens in an encrypted file in the data dir ([wallet vault](#what-the-gateway-keeps)). Shop's access token lasts an hour; the gateway refreshes it with the refresh token Shop issued, logging that request first with the refresh token as a digest, and keeps the new tokens in the vault. If Shop refuses the refresh, link again.

Without `INTENT_SHOP_CLIENT_ID`, the gateway signs in as its own Shop client, `https://gateway.intentai.shop/shop-client.json`; today Shop answers `invalid_client`. The command then prints one line that says which client Shop refused and names `INTENT_SHOP_CLIENT_ID`, and sends nothing more; the gateway never switches to another client by itself. A linked wallet keeps the client it was linked with, in its vault, for every Shop call, refresh and revocation, so a gateway started without `INTENT_SHOP_CLIENT_ID` (the `claude mcp add` line sets only `INTENT_CLOUD_URL`) still uses it. If `INTENT_SHOP_CLIENT_ID` later names another client, the gateway says so in one line and keeps the linked one; only `intent wallet link shop` again changes it. A vault from before the client was kept in it uses `INTENT_SHOP_CLIENT_ID` when set, else the gateway's own client, and records it at the next refresh. `intent init` skips the Shop step with `--yes`, in demo mode and when there is no terminal to ask at.

Your policy decides whether one tap may be used: `completion` lists `handoff`, `one_tap` or both, and both is the default ([Gateway policy](policy.md#completion-modes)). Restart the gateway after linking. `intent wallet unlink shop` asks Shop to revoke the refresh token and the access token, deletes the vault file whatever the answers, and records whether Shop answered that it revoked both. Revoking does not remove the connection from the Shop app: remove it there too (Shop app › Connections). `intent wallet status` reads the account once, through the log; a connection removed in the Shop app shows as not linked at Shop, with one tap unavailable.

## What happens in one purchase

1. **Search.** The agent calls `find_offers`. With Shop linked, the gateway runs the search itself, through Shop ([ADR-0021](adr/0021-search-seam.md)), and filters the results under your policy and the excluded categories. Nothing is sent to Intent Cloud for a search. The agent sees an opaque offer handle and display fields only.
2. **Checkout.** The agent calls `create_cart`. The gateway asks Shop for a checkout with the item and quantity only, reads it back, and checks it: the same store, variant and quantity, totals that add up, a currency in the currency table Intent Cloud returns and the search country's own, a destination in the search's country whose coarse postcode matches the search's, and your policy's caps in that currency. It then chooses the completion mode (one tap when the policy allows it and the agent budget covers the total, otherwise a hand-off to Shop's checkout page) and submits the checkout to Intent Cloud for passkey approval (contract 1.7.1, [ADR-0024](adr/0024-submit-shop-checkout.md)).
3. **Approval.** The buyer approves with their Intent Cloud passkey on intent's confirm page, after checking the item, total and check code.
4. **Payment.** The agent calls `get_approval_status`. The gateway checks the Approval, then completes the purchase inside that call: it checks the store pair against the merchant's storefront, reads the submitted checkout again and checks it against what the buyer approved (store, item, postcode, total), reports `completing` to Intent Cloud, and sends one `complete_checkout` paying with the agent budget.
5. The agent calls again until the status says `ordered`, `failed` or `mismatch`. `ordered (read from Shop)` means Shop returned the order on a checkout read and the binding check passed.

What leaves the gateway on the submit: the store, the item, the quantity, the totals and currency, the country and coarse postcode, a checkout reference hash, the completion mode, and two public keys (the account key and the purchase's completer key). A hand-off submit also carries Shop's checkout page link, which holds the checkout's key; the log keeps it only as its sha256 ([the log](log.md)).

When one tap cannot pay an approved purchase (the store refuses agent payment, or the budget no longer covers it), the purchase ends `failed` before anything is paid. The hand-off to Shop's checkout page then needs a second approval: a new cart, approved again with the passkey, then paid by hand on Shop's page.

The per-order limit is the smallest of your policy's `per_order_usd`, the agent budget left that Shop returns for the account, and the ceiling Intent Cloud enforces. A `complete_checkout` that may have left is never sent again: after a crash or a restart the gateway only reads the checkout, and an answer it cannot settle stays `indeterminate` ("Sent to Shop, result unknown: check Shop orders") with its spend held ([ADR-0019](adr/0019-one-tap-completion.md)).

## The store pair check

Shop names a store by its `*.myshopify.com` domain; the buyer sees the storefront. Intent Cloud pairs the two, and the passkey signs the pair, but the buyer cannot judge it. So before it pays, the gateway asks the storefront itself ([ADR-0020](adr/0020-signed-store-pair-and-storefront-check.md)):

- One `GET https://<storefront>/meta.json`, before the gateway reports `completing` and before any Shop checkout is made. The request carries a fixed set of headers and nothing else: no cookie, no credential, no `Authorization`, nothing about the buyer. It is logged before it leaves, as destination `storefront`, and its answer is kept as a status, a sha256 and a size.
- It passes only when the answer is a 200 `application/json` object, at most 64 KiB, with no duplicate member names, whose `myshopify_domain` is, lowercased, exactly the signed one (ASCII only). A redirect is never followed. The storefront has 5 seconds. The gateway refuses a storefront name that is an IP address or `localhost`, or that resolves to a private or other non-public address, and it connects only to the address it checked.
- A failure ends the purchase `failed` before anything is paid or reported (`store_pair:<rule>` in the log); no report is sent to Intent Cloud, so the approval is left approved there; a new cart, approved again, can hand the purchase off. A pass is reused for 24 hours at most, by any gateway process on the data dir, and a failure is never reused. If the pair no longer passes right before `complete_checkout`, nothing is sent.

What it proves: at that moment, the storefront at the origin the buyer approved names the same Shopify store the passkey signed. What it does not prove: who runs the storefront. Whoever controls that origin controls the answer, as they control the checkout. What it costs: the merchant's storefront sees your IP address before a one-tap purchase: once per store and day while the check passes, and on each purchase after a failure. A hand-off purchase never makes this request.

## What Shop holds, and what the gateway sends

Shop, not the gateway, holds the buyer's card, saved addresses and Shop budget. The gateway never sees or sends them (invariant 3):

- It sends no address and no address id: `create_checkout` carries the item and quantity only. If Shop asks for address fields, the step fails and nothing more is sent.
- It keeps from each Shop answer only the fields it names (budget left, status, lines, total, store, order id, whether the agent budget is offered, the destination's country and coarse postcode) and drops the rest on receipt.
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
| `<data dir>/wallet/shop-pending.enc` | Only between `intent wallet link shop --start` and `--finish`: the pending sign-in (Shop's device code, the client, the resource, the poll interval and the expiry), sealed the same way. Deleted when Shop answers or the code expires. |
| `<data dir>/wallet/shop-checkouts/` | Each checkout id Shop issued for a purchase, sealed the same way, so a restarted gateway can read a checkout it may have completed. Deleted when the purchase ends. |
| The wallet key | From `INTENT_WALLET_KEY_FILE` (refused inside the data dir), else `INTENT_WALLET_KEY`, else a generated 600 file in your config folder. |
| `<data dir>/account-key.json` | The account key: an Ed25519 key `intent init` makes once, mode 600, never replaced ([ADR-0022](adr/0022-account-key.md)). Only its public half is ever sent. |
| `<data dir>/completer/` | One key per open cart, which signs that approval's reads and outcome reports ([ADR-0016](adr/0016-per-approval-completer-key.md)). |

Against malware running as your user, these files are obfuscation, not protection: see [Known risks](threat-model.md#known-risks).

## What you can check

- `intent log` shows each Shop call, and the store pair check's GET to the storefront, as a `call` line, `✓ answered 200 (no receipt: unsigned)`, and each outcome report sent to Intent Cloud ([a one-tap purchase in the log](log.md#a-one-tap-purchase)); `intent log -v` shows every entry, with the token as `redacted`.
- `intent verify` re-checks the outcomes, that each purchase has at most one `complete_checkout`, sent after it was claimed, and that a purchase whose snapshot signs a store pair was redeemed only after the store pair check passed.
- With a linked wallet, `intent wallet check shop` compares the orders Shop returns for the account with the purchases in the log ([orders the log does not name](log.md#orders-the-log-does-not-name)).

What these show is what the gateway sent, what Intent Cloud acknowledged and what Shop returned. They make no claim about what Shop or the merchant does afterwards.
