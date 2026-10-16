# Quickstart

This runs the [demo](demo.md) end to end: an agent finds offers, prepares a cart, you approve it, and you check what was sent. It needs no account and no config. Nothing can be bought.

You need Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+, pnpm (`corepack enable`) and an MCP client. Claude Code is the example.

## 1. Build the package

There is no release on npm yet, so build the package from a clone:

```console
$ git clone https://github.com/golden007eye/intent-gateway.git
$ cd intent-gateway
$ pnpm install && pnpm build && npm pack && mv intent-gateway-*.tgz intent-gateway.tgz
```

`npm pack` writes the same package a release publishes; renaming it to `intent-gateway.tgz` keeps the commands below the same for every version.

## 2. Connect your agent

From the same folder:

```console
$ claude mcp add intent -- npx -y "file:$PWD/intent-gateway.tgz" demo
```

Claude Code starts the gateway over stdio when it needs it. The gateway starts a demo Intent Cloud and a local confirm page on `127.0.0.1`, and keeps its data in `<data dir>/demo` (on Linux `~/.local/share/intent-gateway/demo`).

## 3. Ask for something

Start `claude` and ask:

```text
> Find running shoes to ZIP 94103, under $200, and prepare a cart for the cheapest.
```

1. The agent calls `find_offers`. Each result ends with what the gateway sent (field names, never values) and what it blocked.
2. It calls `create_cart` and shows an approval link, `http://127.0.0.1:<port>/confirm/c/…`, with a check code and a QR code.
3. Open the link. The page shows the item, merchant, total, the ZIP prefix and the check code. Enter the demo code and click **Approve $<total> with demo passkey**. The code is six digits, new on every start and never shown to the agent. Claude Code does not show the gateway's terminal output, so the page shows the command that reads it: `cat <data dir>/demo/approval-code`.
4. Ask the agent whether it was approved. Keep the Claude Code session open until then: the confirm page runs inside the gateway it started. The agent calls `get_approval_status` and reports it approved, with the approver passkey's fingerprint. The first passkey that approves becomes the [approver pin](threat-model.md#phone-hand-off-and-self-approval).

## 4. Check what was sent

In the cloned folder:

```console
$ npx -y ./intent-gateway.tgz log --demo
$ npx -y ./intent-gateway.tgz verify --demo
```

`log` lists each entry of the local hash chain. `verify` re-checks the chain, each receipt and the approval, and ends with `verify: ok` and the chain's head seq and hash. [Verify](verify.md) says what each check proves.

## Without an MCP client

`demo --http` (or `demo` run in a terminal) serves MCP over HTTP on `127.0.0.1:8787` and prints the line to connect with and the demo code:

```console
$ npx -y ./intent-gateway.tgz demo --http
DEMO: test keys, sample catalog, nothing can be bought.
Add the demo gateway to Claude Code:
  claude mcp add --transport http intent http://127.0.0.1:8787/mcp
...
Demo code for the confirm page: 123456 (new on every start; also in …/demo/approval-code; never sent to the agent)
...
```

The commands the gateway prints start with the invocation that runs it, here `npx -y file:/…/intent-gateway.tgz`.

## From the first preview release

Once `0.1.0-preview.1` is on npm, skip step 1:

```console
$ claude mcp add intent -- npx -y intent-gateway@next demo
$ npx -y intent-gateway@next verify --demo
```

## With Docker

The image runs the same package and serves MCP over HTTP on port 8787. Until the first preview release puts it on GHCR, build it from the cloned folder:

```console
$ docker build --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" -t intent-gateway .   # the build-arg is optional: it records the commit
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
- Without `INTENT_DEMO=1` the container talks to the Intent Cloud staging host, whose root key this build pins. Until that host is open, the container exits with a line saying it cannot be reached and how to re-run it in demo mode.

## Next

- `intent doctor --demo` checks the setup; every problem it finds comes with its fix.
- [Gateway policy](policy.md): narrow what leaves the gateway.
- [Panel](panel.md): a read-only page with the same log, pending approvals and the approver pin.
