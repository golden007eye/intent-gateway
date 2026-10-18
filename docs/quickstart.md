# Quickstart

This runs the [demo](demo.md) end to end: an agent finds offers, prepares a Shop checkout, you approve it, the demo Shop pays it in one tap, and you check what was sent. It needs no invite, no account and no config. Nothing can be bought. Real purchases need an invite; see [One-tap purchases](one-tap.md).

You need Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+ and an MCP client. Claude Code is the example. Odd-numbered releases such as Node 25 are not supported; [Docker](#with-docker) needs no Node.

## 1. Connect your agent

The preview release is on npm as `intent-gateway@next`:

```console
$ claude mcp add intent -- npx -y intent-gateway@next demo
```

Claude Code starts the gateway over stdio when it needs it. The gateway starts a demo Intent Cloud, a demo Shop with an agent budget and a local confirm page on `127.0.0.1`, and keeps its data in `<data dir>/demo` (on Linux `~/.local/share/intent-gateway/demo`).

## 2. Ask for something

Start `claude` and ask:

```text
> Find stickers to ZIP 94107, under $20, and prepare a cart for the cheapest.
```

1. The agent calls `find_offers`. The gateway searches the demo Shop itself; nothing is sent to Intent Cloud for the search. Each result ends with what the gateway sent (field names, never values) and what it blocked.
2. It calls `create_cart`. The gateway creates the Shop checkout, reads it back and submits it to the demo Intent Cloud for approval, then shows an approval link, `http://127.0.0.1:<port>/confirm/c/…`, with a check code and a QR code.
3. Open the link. The page shows the item, store, total, the ZIP code and the check code. Enter the demo code and click **Approve $<total> with demo passkey**. The code is six digits, new on every start and never shown to the agent. Claude Code does not show the gateway's terminal output, so the page shows the command that reads it: `cat <data dir>/demo/approval-code`.
4. Ask the agent whether it was approved. Keep the Claude Code session open until then: the confirm page runs inside the gateway it started. The agent calls `get_approval_status` and reports it approved, with the approver passkey's fingerprint, and the gateway pays it from the demo Shop's agent budget: `One-tap: ordered (read from Shop)`. The first passkey that approves becomes the [approver pin](threat-model.md#phone-hand-off-and-self-approval).

## 3. Check what was sent

```console
$ npx -y intent-gateway@next log --demo
$ npx -y intent-gateway@next verify --demo
```

`log` lists each entry of the local hash chain. `verify` re-checks the chain, each receipt and the approval, and ends with `verify: ok` and the chain's head seq and hash. [Verify](verify.md) says what each check proves.

## 4. See what one tap sent

`log --demo` shows the calls to Shop (the search, the checkout and its reads, the one `complete_checkout`), each answered with its status and no receipt, since Shop signs none, and the submit and outcome reports sent to the demo Intent Cloud, each with its receipt. `verify --demo` re-checks the order against what you approved. [One-tap purchases](one-tap.md) says what a real purchase needs: an invite, your own Shop account linked with `INTENT_SHOP_CLIENT_ID` set explicitly, and an agent budget in the Shop app.

## Without an MCP client

`demo --http` (or `demo` run in a terminal) serves MCP over HTTP on `127.0.0.1:8787` and prints the line to connect with and the demo code:

```console
$ npx -y intent-gateway@next demo --http
DEMO: test keys, sample catalog, nothing can be bought.
Add the demo gateway to Claude Code:
  claude mcp add --transport http intent http://127.0.0.1:8787/mcp
...
Demo code for the confirm page: 123456 (new on every start; also in …/demo/approval-code; never sent to the agent)
...
```

The commands the gateway prints start with the invocation that runs it, here `npx -y intent-gateway@next`.

## From a clone

To run the code on `main` instead of the preview release, build the package from a clone (this needs pnpm: `corepack enable`):

```console
$ git clone https://github.com/golden007eye/intent-gateway.git
$ cd intent-gateway
$ pnpm install && pnpm build && npm pack && mv intent-gateway-*.tgz intent-gateway.tgz
$ claude mcp add intent -- npx -y "file:$PWD/intent-gateway.tgz" demo
$ npx -y ./intent-gateway.tgz verify --demo
```

`npm pack` writes the same package a release publishes; renaming it to `intent-gateway.tgz` keeps the commands the same for every version. In that folder, `npx -y ./intent-gateway.tgz` takes the place of `npx -y intent-gateway@next` in the steps above.

## With Docker

The image runs the same package and serves MCP over HTTP on port 8787. Pull the preview from GHCR and name it `intent-gateway`, the name the commands below and the gateway's own hints use (or build it from a clone: `docker build --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" -t intent-gateway .`, where the build-arg is optional and records the commit):

```console
$ docker pull ghcr.io/golden007eye/intent-gateway:0.1.0-preview.4
$ docker tag ghcr.io/golden007eye/intent-gateway:0.1.0-preview.4 intent-gateway
$ docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 \
    -e INTENT_DEMO=1 -v intent-data:/data intent-gateway
$ docker logs intent
```

On its first start the container makes an HTTP token and saves it in `/data/http-token`; once the gateway is serving it prints the token once, inside the line to paste (a start that fails prints no line). That line is also kept in the container's log (`docker logs`); add `-e INTENT_QUIET_TOKEN=1` to never print it.

```console
$ claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"
```

Later starts reuse the token without printing it: their connect line reads it from the container (`$(docker exec <container id> cat /data/http-token)`), or read it yourself with `docker exec intent cat /data/http-token`. The log holds one connect line only; the demo's next steps point at it. Port 8788 is the demo's confirm page and must be published on the same host port, as above. The demo code is in `docker logs intent`, or read it with `docker exec intent cat /data/demo/approval-code`. Check what was sent with `docker exec intent intent verify --demo`.

- Always publish ports as `-p 127.0.0.1:…`, never a bare `-p 8787:8787`: inside the container the gateway listens on every interface, and the token is then the only protection.
- The gateway runs as uid 1000, which owns the `/data` volume. For a bind mount, run as its owner: `--user "$(id -u):$(id -g)" -v "$PWD/data:/data"`.
- Without `INTENT_DEMO=1` the container talks to the Intent Cloud host this preview uses by default, whose root key this build pins. When it cannot reach that host, the container exits with a line saying so and how to re-run it in demo mode.

## Next

- `intent init` checks the setup for a real run, makes the gateway's account key once (`<data dir>/account-key.json`, mode 600, never replaced; it prints only its thumbprint), offers to link Shop for one tap at a terminal (it skips the step with `--yes`, in demo mode and without a terminal), and prints the line that connects your agent. There is one account key per developer, and your first approval pins it; to replace it today, move `account-key.json` aside and run `intent init` again.
- `intent doctor --demo` checks the setup; every problem it finds comes with its fix.
- `intent pause` stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off the budget in the Shop app. `intent status` shows the pause; `intent resume` needs your passkey. The Shop budget is the only hard stop, because any program running as you can read the Shop token.
- [Gateway policy](policy.md): narrow what leaves the gateway.
- [Panel](panel.md): a local page with the same log, pending approvals, the approver pin and a Pause button.
