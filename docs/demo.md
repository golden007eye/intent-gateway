# Demo mode

Demo mode runs the whole gateway flow on your machine before you can reach an Intent Cloud host: search, cart, approval, and the checks afterwards. The [Quickstart](quickstart.md) walks through it.

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
| Sample catalog | About seventy US offers from `*.example` merchants across everyday categories: running shoes, water bottles and mugs, coffee and kitchen gear, headphones and phone accessories, backpacks, books, toys and games, home basics, office supplies, camping gear, pet supplies, beauty basics and gifts under $30. Some exist so a seed policy has something to act on: electronics (`no-electronics`), drop-ship merchants (`block-dropship`) and items over $60 (`per-order-60`). See [Searching the sample catalog](#searching-the-sample-catalog). |
| Local confirm page | `http://127.0.0.1:8788/confirm/c/<link>`, with **Approve with demo passkey** and **Reject**. A click signs on the server with a demo passkey kept in `<data dir>/demo/demo-passkey.json`. Approve also needs the demo code (below). |
| Demo code | Six digits, new on every start, printed on the gateway's stderr with the next steps and kept in `<data dir>/demo/approval-code` (mode 600). It never appears in a tool result. When your agent started the gateway, you do not see its stderr: the confirm page shows the command that reads the file. |
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

Here `intent` stands for the command that runs your gateway: `npx -y "file:$PWD/intent-gateway.tgz"` for a local build, `npx -y intent-gateway@next` once a preview is published. The gateway prints its own commands with the prefix that started it.

Every other command takes `--demo` and then reads the demo data dir: `intent log --demo`, `intent verify --demo`, `intent panel --demo`, `intent doctor --demo`, `intent policy show --demo`, `intent approver list --demo`.

In demo mode the policy file is `<data dir>/demo/policy.yaml`. With none, the bundled `zip-only` policy applies, as it does outside the demo. Try `intent policy add per-order-60 --demo` and then ask for something over $60.

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

## Searching the sample catalog

The demo Intent Cloud searches the way a shop's search box does, so the first thing you ask for should find something. For example, "a stainless water bottle around 1 liter, ZIP 10001, budget $40" returns several bottles.

- Case, plurals and common synonyms do not matter: "Sneakers", "running shoe" and "running shoes" find the same shoes, and "earbuds" finds headphones.
- A category matches at any level: "drinkware", "kitchen" and "water bottles" all find water bottles.
- Each must-have has to match. A size matches within 20%, so "1 liter" also finds a 32 oz bottle, but not a 750 ml one.
- The budget counts shipping.
- Results are ranked by how many of your words match, then by price.

When a search finds nothing, the result still has 0 offers. In demo mode the gateway adds one line, "The demo catalog has: running shoes, water bottles, …", so your agent can try something the catalog holds.

The catalog also holds items in the excluded categories, such as alcohol, tobacco, weapons, health products and gift cards, so you can watch them being refused:

- A search that names such a category is blocked by the gateway before anything is sent.
- A search that names only the product is sent, but the demo Intent Cloud never returns the item, as Intent Cloud never does.

## What it proves, and what it does not

The demo shows that the gateway's checks work: `intent verify --demo` re-checks every receipt and the approval proof against the test root key, and fails if you edit a line of `<data dir>/demo/audit.jsonl`.

It proves nothing about Intent Cloud. The test keys' private halves are published with the contract's test vectors, so anyone can sign a demo receipt. That is why:

- the demo trusts the test root key only in demo mode, and it may never be pinned for an Intent Cloud host;
- a demo chain lives in its own folder and never mixes with a real one;
- `intent verify --demo` skips the install self-check unless you ask for it with `--install npm` or `--image`.

The confirm page is a local stand-in for the passkey step, not proof that a person approved. Any program that can reach `127.0.0.1` can press its buttons, and the demo passkey is a software key on your disk, not a passkey on your phone. The demo code is only a speed bump: an agent that reads only tool results cannot approve, but a program that can read the gateway's stderr or `<data dir>/demo/approval-code` can. After five wrong codes the page refuses approvals until the demo restarts. Nothing can be bought in demo mode. On a real run, the buyer approves on intent's confirm page with their own passkey.

## Starting over

Stop the agent's gateway, then delete `<data dir>/demo`. The next demo run starts a new chain, a new demo passkey and a new approver pin.
