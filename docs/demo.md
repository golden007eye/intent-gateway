# Demo mode

Demo mode runs the whole gateway flow on your machine before you can reach an Intent Cloud host: a Shop search for stickers, the checkout submitted for approval, one tap to order it after you approve, and the checks afterwards. The [Quickstart](quickstart.md) walks through it.

```console
$ claude mcp add intent -- npx -y "file:$PWD/intent-gateway.tgz" demo
```

Every tool result, the confirm page and the gateway's stderr say so:

```text
DEMO: test keys, sample catalog, nothing can be bought.
```

## What runs

| Part | What it is |
|---|---|
| Demo Intent Cloud | A stand-in for Intent Cloud inside the gateway process, on `127.0.0.1`, following the public contract. It signs receipts, key statements and approvals with the published test keys. |
| Demo Shop catalog | What the demo Shop's search returns: a holographic sticker from `stickers.example`, a vinyl sticker sheet from `paper.example`, and two items the gateway drops before your agent sees them (a CBD product and a digital gift card). Searches run in the gateway against the demo Shop; nothing is sent to Intent Cloud for them. Ask for stickers: other products find nothing. See [A one-tap run](#a-one-tap-run). |
| Local confirm page | `http://127.0.0.1:8788/confirm/c/<link>`, with the receipt (total, items, check code) and **Approve $<total> with demo passkey** and **Reject**; Approve turns on once the six digits of the demo code are in. A click signs on the server with a demo passkey kept in `<data dir>/demo/demo-passkey.json`. Approve also needs the demo code (below). |
| Demo code | Six digits, new on every start, printed on the gateway's stderr with the next steps and kept in `<data dir>/demo/approval-code` (mode 600). It never appears in a tool result. Type or paste it as it comes: only its digits count, so `469 226`, `469-226` and `Demo code: 469226` all work. When your agent started the gateway, you do not see its stderr: the confirm page shows the command that reads the file. |
| Demo Shop wallet | A fake Shop on `127.0.0.1`, already linked, for [one-tap purchases](one-tap.md) and an agent budget with $50 left. A cart creates the Shop checkout, and the gateway submits it to the demo Intent Cloud for your approval (contract 1.7.1). The holographic sticker's store accepts agent checkouts, so after your approval the gateway completes it with one tap instead of handing it off. Its checkout ids stay in memory: after a demo restart, an unfinished one-tap purchase cannot be read again. |
| Demo data dir | `<data dir>/demo`. Its chain starts with a demo `session` entry, and the gateway refuses to mix a demo chain with a real one. |

The gateway itself is the same code as in a real run: the same policy, identity block, disclosure log, receipt checks, approval proof check and approver pin.

## Starting it

| Command | What it does |
|---|---|
| `intent demo`, started by an MCP client | MCP over stdio. This is what `claude mcp add … demo` runs. |
| `intent demo`, typed in a terminal | MCP over HTTP on `127.0.0.1:8787`; it prints the `claude mcp add --transport http` line and the demo code. |
| `intent demo --http`, `intent serve --demo --http` | The same, explicitly. |
| `INTENT_DEMO=1` | The same as `--demo`, for any command. |
| `docker run … -e INTENT_DEMO=1 …` | The image in demo mode, with the confirm page on port 8788; see [Quickstart](quickstart.md#with-docker). |

Here `intent` stands for the command that runs your gateway: `npx -y "file:$PWD/intent-gateway.tgz"` for a local build, `npx -y intent-gateway@next` for the preview release. The gateway prints its own commands with the prefix that started it.

Every other command takes `--demo` and then reads the demo data dir: `intent log --demo`, `intent verify --demo`, `intent panel --demo`, `intent doctor --demo`, `intent policy show --demo`, `intent approver list --demo`.

In demo mode the policy file is `<data dir>/demo/policy.yaml`. With none, the bundled `zip-only` policy applies, as it does outside the demo.

If Claude Code already has an MCP server named `intent` (for example a connector added in your Claude account), add the demo under another name, so the agent cannot pick the wrong one:

```console
$ claude mcp add intent-demo -- npx -y "file:$PWD/intent-gateway.tgz" demo
```

### The confirm page's port

The confirm page listens on `127.0.0.1:8788`, and the demo prints its address with the next steps. If 8788 is taken (another demo is running, say), it uses a free port and says so on startup. Set `INTENT_DEMO_CONFIRM_PORT` to choose the port. A port you chose is never swapped for another: if it is taken, the demo stops with a line saying so. On a host the page listens on `127.0.0.1` only.

When the gateway runs on a remote machine over SSH and your browser runs on your laptop, forward the confirm page's port when you connect. With npx and with Docker it is the same one port, because the agent runs on the server and reaches the gateway there:

```console
$ ssh -L 8788:127.0.0.1:8788 <host>
```

## A one-tap run

Ask your agent for stickers shipped to ZIP 94107 in the US, under $20. This is what a run printed, shortened.

`find_offers` searches the demo Shop from the gateway. The CBD product is hidden by the bundled policy:

```text
2 offers from Shop search, made by this gateway; nothing was sent to Intent Cloud for it. Shipping is shown at checkout. 1 more hidden by the gateway policy (excluded_categories).

- Holographic sticker (Default) from stickers.example: $5.00, shipping shown at checkout, in stock.
- Vinyl sticker sheet (Default) from paper.example: $3.50, shipping shown at checkout, in stock.
```

`create_cart` for the holographic sticker creates the Shop checkout, reads it back and submits it to the demo Intent Cloud. Only the country and the 5-digit ZIP go with it:

```text
Shop checkout: 1 × Holographic sticker from stickers.example, total $8.99 (shipping $3.99, tax $0.00), paid at once by one tap.
Approval link: http://127.0.0.1:8788/confirm/c/<link>
```

Open the link, enter the demo code and click **Approve $8.99 with demo passkey**. Then `get_approval_status` checks the passkey proof, completes the checkout with the demo Shop's agent budget and reads the order back:

```text
One-tap: ordered (read from Shop), order gid://shopify/Order/5001
```

`intent log --demo` then lists each step. The submit is listed with the cart:

```text
call      Shop search_catalog · …                                ✓ answered 200 (no signed receipt)
call      Shop create_checkout · …                               ✓ answered 200 (no signed receipt)
call      Shop get_checkout · …                                  ✓ answered 200 (no signed receipt)
call      Shop get_account · …                                   ✓ answered 200 (no signed receipt)
cart      submit checkout · Holographic sticker ×1 · $8.99 · stickers.example  → approval link  ✓ receipt
status    approval ap_3jnL…VYQs                                  → Intent Cloud says approved · ✓ receipt
approved  $8.99 · passkey efed…c048 (pinned now)                 ✓ passkey proof checked
call      Shop complete_checkout · …                             ✓ answered 200 (no signed receipt)
outcome   outcome report sent to Intent Cloud · approval ap_3jnL…VYQs  ✓ receipt
```

`intent verify --demo` on the same chain says `verify: ok`.

Items in the excluded categories are refused, so you can watch it happen: a search that names such a category (alcohol, say) is blocked by the gateway before anything is sent, and the demo Shop's CBD product never reaches your agent.

## What it proves, and what it does not

The demo shows that the gateway's checks work: `intent verify --demo` re-checks every receipt and the approval proof against the test root key, and fails if you edit a line of `<data dir>/demo/audit.jsonl`.

It proves nothing about Intent Cloud or Shop. The demo Shop wallet follows the shape of Shop's tools as the gateway uses them, not Shop's own behaviour. The test keys' private halves are published with the contract's test vectors, so anyone can sign a demo receipt. That is why:

- the demo trusts the test root key only in demo mode, and it may never be pinned for an Intent Cloud host;
- a demo chain lives in its own folder and never mixes with a real one;
- `intent verify --demo` skips the install self-check unless you ask for it with `--install npm` or `--image`.

The confirm page is a local stand-in for the passkey step, not proof that a person approved. Any program that can reach `127.0.0.1` can press its buttons, and the demo passkey is a software key on your disk, not a passkey on your phone. The demo code is only a speed bump: an agent that reads only tool results cannot approve, but a program that can read the gateway's stderr or `<data dir>/demo/approval-code` can. A wrong code shows the form again with the number of tries left; after five wrong codes the page refuses approvals until the demo restarts. Nothing can be bought in demo mode. On a real run, the buyer approves on intent's confirm page with their own passkey.

## Starting over

Stop the agent's gateway, then delete `<data dir>/demo`. The next demo run starts a new chain, a new demo passkey and a new approver pin.
