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
| Sample catalog | A handful of items: running shoes, headphones, a mug, and items the gateway must refuse (a drop-shipper, an excluded category), so a policy has something to act on. |
| Local confirm page | `http://127.0.0.1:<port>/confirm/c/<link>`, with **Approve with demo passkey** and **Reject**. A click signs on the server with a demo passkey kept in `<data dir>/demo/demo-passkey.json`. Approve also needs the demo code (below). |
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

## What it proves, and what it does not

The demo shows that the gateway's checks work: `intent verify --demo` re-checks every receipt and the approval proof against the test root key, and fails if you edit a line of `<data dir>/demo/audit.jsonl`.

It proves nothing about Intent Cloud. The test keys' private halves are published with the contract's test vectors, so anyone can sign a demo receipt. That is why:

- the demo trusts the test root key only in demo mode, and it may never be pinned for an Intent Cloud host;
- a demo chain lives in its own folder and never mixes with a real one;
- `intent verify --demo` skips the install self-check unless you ask for it with `--install npm` or `--image`.

The confirm page is a local stand-in for the passkey step, not proof that a person approved. Any program that can reach `127.0.0.1` can press its buttons, and the demo passkey is a software key on your disk, not a passkey on your phone. The demo code is only a speed bump: an agent that reads only tool results cannot approve, but a program that can read the gateway's stderr or `<data dir>/demo/approval-code` can. After five wrong codes the page refuses approvals until the demo restarts. Nothing can be bought in demo mode. On a real run, the buyer approves on intent's confirm page with their own passkey.

## Starting over

Stop the agent's gateway, then delete `<data dir>/demo`. The next demo run starts a new chain, a new demo passkey and a new approver pin.
