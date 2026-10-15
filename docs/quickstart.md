# Quickstart

!!! planned "Planned"
    None of these commands works yet: the Docker image and the MCP endpoint do not exist. This page shows the intended first run so you can judge the design. It will be rewritten against the first release, and every command will be run against that build before this notice is removed.

## 1. Run the gateway next to your agent

```console
$ docker run -d -p 8787:8787 -v intent-data:/data \
    ghcr.io/golden007eye/intent-gateway:0.1
```

The volume holds the local audit trail: the disclosure log and each verified Approval.

## 2. Connect your agent over MCP

```console
$ claude mcp add intent --transport http http://localhost:8787/mcp
```

Any MCP client works the same way; Claude Code is the example.

## 3. Ask for something

```text
> "Find a 1 L stainless water bottle under $40"
```

The agent searches and builds carts within your [gateway policy](policy.md). When the buyer chooses to buy, they approve with a passkey on their phone, on intent's confirm page, and pay on the merchant's checkout.
