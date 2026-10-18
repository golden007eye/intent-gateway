<!--
Onboarding prompt for Claude Code, for intent-gateway 0.1.0-preview.5 (`pnpm release` sets the version below).
Intent Cloud serves it from the try link and fills in the placeholders per invite before serving:
  {{INTENT_INVITE}}        the invite token of this try link; passed to no gateway command
  {{INTENT_CLOUD_URL}}     the Intent Cloud host for this lane; today it equals the gateway's default host
  {{INTENT_SIGNUP_URL}}    the invite-gated sign-up page where the developer creates the passkey
  {{INTENT_MARKER_URL}}    this invite's step-marker address
  {{INTENT_OPT_OUT_URL}}   this invite's step-marker opt-out address
`intent pause` and `intent resume` are planned commands; test/onboarding.test.ts lists them as pending.
-->

# Set up intent with Claude Code

You are setting up intent-gateway for the developer you are talking to. The gateway lets you find products and prepare carts; the developer approves every purchase with their passkey, and Shop pays from a budget the developer sets. This prompt was served for invite `{{INTENT_INVITE}}`. Never pass that invite to any command.

How to work:

- Do one step at a time, in order. At the end of each step, say in one line what happened and what comes next.
- Run the commands yourself. When a step needs the developer (a browser page, the Shop app, a passkey), say exactly what to do and wait until they say it is done.
- Never ask for, type or store the developer's name, postal address or card. They give those to Shop themselves.
- If a command fails, show its error line and the fix it names, and stop at that step. Do not work around it.

In every step, `intent <command>` means this exact command line:

```console
$ INTENT_CLOUD_URL={{INTENT_CLOUD_URL}} npx -y intent-gateway@0.1.0-preview.5 <command>
```

### Step markers

Some steps end by sending a step marker, which tells the intent team how far setup got. Send a marker only after its step succeeded, each step once, and never after the developer opted out (step 2). A marker is this command, with `<step>` one of `installed`, `passkey`, `shop_linked`, `ordered`:

```console
$ curl -fsS -X POST -H 'content-type: application/json' -d '{"step":"<step>"}' {{INTENT_MARKER_URL}}
```

A marker that fails is ignored: say nothing about it and go on. It never blocks setup.

## Step 1: check Node and the folder

1. Run `node --version`. It must be Node 24 at 24.15 or later, or Node 26 or later. Odd-numbered releases such as Node 25 are not supported. If it is older, stop and ask the developer to install a supported Node (https://nodejs.org), then start again.
2. Run `pwd`. You must be in a project folder that the developer chose, not their home folder or `/`. If you are not, ask them to open Claude Code in a project folder and paste this prompt again. Why: step 7 installs a skill into this project's `.claude/skills/`, and nothing is installed globally.

## Step 2: step markers, asked once

Tell the developer, once:

- This invite records how far setup gets, as step markers: gateway installed, passkey created, Shop linked, first order. A marker sends only the step's name. The intent team says it stores only the step and the day, never anything about what they buy or anything from Shop.
- This conversation may be shared with the intent team if they choose to send it, for example to ask for help or give feedback. It holds the commands you ran, their output and the links in this prompt, including the invite.

Ask: "Shall I send these step markers? You can say no." If they say no, run this once and send no marker afterwards:

```console
$ curl -fsS -X POST {{INTENT_OPT_OUT_URL}}
```

## Step 3: install the gateway

1. Check that the package runs: `intent --version` must print `0.1.0-preview.5`.
2. Add the gateway to Claude Code for this project:

```console
$ claude mcp add intent -e INTENT_CLOUD_URL={{INTENT_CLOUD_URL}} -- npx -y intent-gateway@0.1.0-preview.5
```

If Claude Code already has an MCP server named `intent` (for example a connector added in the developer's Claude account), ask the developer before you add this one under another name, such as `intent-gateway`, so you never pick the wrong one.

Then send the `installed` marker.

## Step 4: first run

Run `intent init`. It checks the setup, makes the gateway's account key, and prints the line that connects an agent; you already ran that line in step 3. If it mentions Shop, that is step 6.

## Step 5: sign up and create the passkey

Ask the developer to open {{INTENT_SIGNUP_URL}} in their own browser. It is a registration page; no ChatGPT app is needed. Never open the page or fill it in for them. There they:

1. enter the email address that was invited;
2. enter the code sent to that email;
3. create their passkey (this step is required);
4. land on an account page, come back to this terminal and say "done".

The try link that served this prompt stops working after this step. That is expected.

Every purchase will need this passkey: you prepare a cart, and only the developer approves it.

Then send the `passkey` marker.

## Step 6: the Shop account

1. Ask whether they have a Shop account. If not, ask them to create one in the Shop app (iOS or Android) or at https://shop.app, and to add a payment card there. Wait until it is done.
2. Run `intent wallet link shop`. It prints a code and a Shop page. Ask the developer to open the page in their browser, check the code and approve. The command waits for that, so give it a long timeout (10 minutes) or run it in the background.
3. Run `intent wallet status`. It must say the Shop wallet is linked.
4. Ask the developer to turn on "Allow agent to pay" for the intent connection in the Shop app, with a budget. Suggest $160, and never more than $400. Tell them plainly: the Shop budget is the only hard stop, because any program running as them can read the Shop token on this computer. The policy advisor in step 7 checks the amount with them.

Then send the `shop_linked` marker.

## Step 7: the policy advisor

Install the policy-advisor skill from this exact package version into this project's `.claude/skills/`:

```console
$ tmp="$(mktemp -d)"
$ npm pack intent-gateway@0.1.0-preview.5 --pack-destination "$tmp"
$ tar -xzf "$tmp/intent-gateway-0.1.0-preview.5.tgz" -C "$tmp" package/onboarding/skills/policy-advisor
$ mkdir -p .claude/skills
$ cp -R "$tmp/package/onboarding/skills/policy-advisor" .claude/skills/
```

Then run the skill `policy-advisor`. If it is not listed yet, read `.claude/skills/policy-advisor/SKILL.md` and follow it. It sets the Shop budget with the developer first, then the gateway policy, and ends with `intent policy test`.

## Step 8: Pause

Tell the developer these two lines, exactly:

> intent pause stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off the budget in the Shop app.

If `intent --help` does not list `pause` yet, add that the command arrives in a later release, and that the Shop app budget works today.

## Step 9: the first purchase

1. Check that you have the `intent` tools (`find_offers`, `create_cart`, `get_approval_status`). If not, Claude Code has not started the gateway yet: ask the developer to quit, run `claude --continue` in this folder and say "continue".
2. Ask what small item they would like. It must cost less than their per-order limit (under $20 with the suggested limits) and fit in their Shop budget.
3. Call `find_offers`, show the offers, and call `create_cart` for the one they pick.
4. Show the approval link. The developer opens it, checks the item and total, and approves with their passkey. Never approve for them.
5. Call `get_approval_status` until it says `ordered`, `failed` or `mismatch`, and tell them the result. If Shop could not pay in one tap, the status says so and offers Shop's checkout page, where they pay by hand.

When the status says `ordered`, send the `ordered` marker.

## Step 10: read the log together

1. Run `intent log` and go through it with the developer. Each action shows the values the gateway sent, what came back and what was blocked. A call to Shop shows its status, with no receipt because Shop signs none.
2. Run `intent verify`. It re-checks the local hash chain, every receipt Intent Cloud returns and every approval, and ends with `verify: ok`.
3. Tell them what these prove: what the gateway sent, what Intent Cloud acknowledged receiving and what Shop returned. They make no claim about what happens to that data afterwards.

Setup is done. To change the limits later, run the policy-advisor skill again.
