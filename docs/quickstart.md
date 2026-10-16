# Quickstart

This runs the [demo](demo.md) end to end: an agent finds offers, prepares a cart, you approve it, and you check what was sent. It needs no account and no config. Nothing can be bought.

You need Node 24 or later, pnpm (`corepack enable`) and an MCP client. Claude Code is the example.

## 1. Build the package

There is no release on npm yet, so build the package from a clone:

```console
$ git clone https://github.com/golden007eye/intent-gateway.git
$ cd intent-gateway
$ pnpm install && pnpm build && npm pack
```

`npm pack` writes `intent-gateway-0.0.0.tgz`, the same package a release publishes.

## 2. Connect your agent

From the same folder:

```console
$ claude mcp add intent -- npx -y "file:$PWD/intent-gateway-0.0.0.tgz" demo
```

Claude Code starts the gateway over stdio when it needs it. The gateway starts a demo Intent Cloud and a local confirm page on `127.0.0.1`, and keeps its data in `<data dir>/demo` (on Linux `~/.local/share/intent-gateway/demo`).

## 3. Ask for something

Start `claude` and ask:

```text
> Find running shoes to ZIP 94103, under $200, and prepare a cart for the cheapest.
```

1. The agent calls `find_offers`. Each result ends with what the gateway sent (field names, never values) and what it blocked.
2. It calls `create_cart` and shows an approval link, `http://127.0.0.1:<port>/confirm/c/…`, with a check code and a QR code.
3. Open the link. The page shows the item, merchant, total, the ZIP prefix and the check code. Click **Approve with demo passkey**.
4. Ask the agent whether it was approved. It calls `get_approval_status` and reports it approved, with the approver passkey's fingerprint. The first passkey that approves becomes the [approver pin](threat-model.md#phone-hand-off-and-self-approval).

## 4. Check what was sent

In the cloned folder:

```console
$ npx -y ./intent-gateway-0.0.0.tgz log --demo
$ npx -y ./intent-gateway-0.0.0.tgz verify --demo
```

`log` lists each entry of the local hash chain. `verify` re-checks the chain, each receipt and the approval, and ends with `verify: ok` and the chain's head seq and hash. [Verify](verify.md) says what each check proves.

## Without an MCP client

`demo` run in a terminal serves MCP over HTTP on `127.0.0.1:8787` and prints the line to connect with:

```console
$ npx -y ./intent-gateway-0.0.0.tgz demo
DEMO: test keys, sample catalog, nothing can be bought.
Add the demo gateway to Claude Code:
  claude mcp add --transport http intent http://127.0.0.1:8787/mcp
...
```

## From the first preview release

Once `0.1.0-preview.1` is on npm, skip step 1:

```console
$ claude mcp add intent -- npx -y intent-gateway@next demo
$ npx -y intent-gateway@next verify --demo
```

<!-- feature: docker-image -->
!!! planned "Docker"
    The Docker image runs the same package and, with `INTENT_DEMO=1`, serves the demo over MCP HTTP on port 8787, bound to `127.0.0.1` on the host side. The image and its exact `docker run` flags are available with the first preview release.

## Next

- `intent doctor --demo` checks the setup; every problem it finds comes with its fix.
- [Gateway policy](policy.md): narrow what leaves the gateway.
- [Panel](panel.md): a read-only page with the same log, pending approvals and the approver pin.
