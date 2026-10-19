<!--
Onboarding prompt for Claude Code, for intent-gateway 0.1.0-preview.5 (`pnpm release` sets the version below).
Intent Cloud serves it from the try link and fills in the placeholders per invite before serving:
  {{INTENT_INVITE}}        the invite token of this try link; passed to no gateway command
  {{INTENT_CLOUD_URL}}     the Intent Cloud host for this lane; today it equals the gateway's default host
  {{INTENT_SIGNUP_URL}}    the invite-gated sign-up page where the developer creates the passkey
`intent pause` and `intent resume` are planned commands; test/onboarding.test.ts lists them as pending.
-->


# Set up intent with Claude Code

You are setting up intent-gateway for the developer you are talking to. The gateway lets you find products and prepare carts; the developer approves every purchase with their passkey, and Shop pays within the amount the developer allows there. This prompt was served for invite `{{INTENT_INVITE}}`. Never pass that invite to any command.

How to work:

- Do one step at a time, in order. Run the commands yourself. Between developer actions, say only one short status line: what happened and what comes next.
- Anything the developer must see, click or type (a link, a code, a choice) goes in your own reply, written out in full, never only in a command's output. Why: Claude Code does not reliably show command output to the developer.
- Each developer action is a block in your own reply, copied from this prompt with its link or code filled in: it starts with a bold **Your turn** line, gives one numbered action, puts its link or code on its own line, and ends with "Reply done" only when no command can see that the action is done. Where a command can see it (the Shop link, agent payments, the purchase), run that command instead of asking.
- The commands that wait (`intent wallet link shop --finish`, `intent wallet status --wait-budget`, `get_approval_status`) send only the gateway's normal requests to Shop and Intent Cloud and read what each returns; every request is in the log before it leaves.
- Never ask for, type or store the developer's name, postal address or card. They give those to Shop themselves.
- If a command fails, show its error line and the fix it names, and stop at that step. Do not work around it.
- If the developer is stuck, tell them, in these words: "If you get stuck, you can send this conversation to the intent team. It contains your invite link, so don't post it publicly."

In every step, `intent <command>` means this exact command line:

```console
$ INTENT_CLOUD_URL={{INTENT_CLOUD_URL}} npx -y intent-gateway@0.1.0-preview.5 <command>
```

## Step 1: check Node and the folder

1. Run `node --version`. The gateway needs Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+. Odd-numbered releases such as Node 25 are not supported. If this Node is outside that range, follow "Get a supported Node" below, then come back to this step.
2. Run `pwd`. You must be in a project folder that the developer chose, not their home folder or `/`. If you are not, ask them to open Claude Code in a project folder and paste this prompt again. Why: step 6 installs a skill into this project's `.claude/skills/`, and nothing is installed globally.

### Get a supported Node

1. Find what installs Node on this computer and use the first one found:
   - nvm, if `test -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh"` succeeds. nvm is a shell function, so `command -v nvm` does not find it.
   - fnm, if `command -v fnm` prints a path.
   - Homebrew, if `command -v brew` prints a path.
2. Show the developer the command for it and ask before you install anything. If they say no, stop here.
   - nvm: `. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install 24 && nvm alias default 24`
   - fnm: `fnm install 24 && fnm default 24`
   - Homebrew: `brew install node@24`. Brew does not put node@24 on the PATH, so also ask before adding it to their shell profile: `echo "export PATH=\"$(brew --prefix node@24)/bin:\$PATH\"" >> ~/.zshrc` (`~/.bashrc` if their shell is bash).
   - None of them: ask the developer to install Node 24 LTS from https://nodejs.org and say when it is done.
3. Ask the developer to quit Claude Code, open a new terminal in this folder, check that `node --version` there shows the new Node, run `claude --continue` and say "continue". Why: each command you run may start a fresh shell, so a Node switched there does not reach your next command, and Claude Code starts the gateway (step 2) with `npx` on its own PATH. Starting Claude Code from a terminal where the new Node is active fixes both.
4. Run `node --version` again and continue at step 1.

## Step 2: install the gateway

1. Check that the package runs: `intent --version` must print `0.1.0-preview.5`.
2. Add the gateway to Claude Code for this project:

```console
$ claude mcp add intent -e INTENT_CLOUD_URL={{INTENT_CLOUD_URL}} -- npx -y intent-gateway@0.1.0-preview.5
```

If Claude Code already has an MCP server named `intent` (for example a connector added in the developer's Claude account), ask the developer before you add this one under another name, such as `intent-gateway`, so you never pick the wrong one.

## Step 3: first run

Run `intent init`. It checks the setup, makes the gateway's account key, and prints the line that connects an agent; you already ran that line in step 2. If it mentions Shop, that is step 5.

## Step 4: sign up and create the passkey

This step is required: never skip it, also when the developer says they already have an account. Never open the page or fill it in for them. Show:

> **Your turn**
>
> 1. Open this page in your own browser. Sign up with the email address that was invited, enter the code sent to it, and create your passkey. If you already have an account, check on its account page that it has a passkey, and create one if it has none.
>
> {{INTENT_SIGNUP_URL}}
>
> Reply done

Wait for "done": no command can see this step. Every purchase needs this passkey: you prepare a cart, and only the developer approves it. The first purchase's approval (step 8) is where the passkey is really checked.

## Step 5: link Shop and turn on agent payments

1. Run `intent wallet link shop --start`. It prints a Shop link, a code and when they expire, then exits. Show:

> **Your turn**
>
> 1. Open this link and approve intent in Shop. The code is already filled in if you use this link. No Shop account yet? Create one there or in the Shop app, and add a payment card in Shop.
>
> <the link, as a clickable link>
>
> <the code>

2. Right away, run `intent wallet link shop --finish`. It waits until Shop says the link was approved, denied or expired, so give it a long timeout (10 minutes). If it expired, go back to 1 and start again. If it was denied, ask the developer whether to try again.
3. Turn on agent payments in Shop. This is Shop's permission for the agent to pay at all: without it no purchase completes in one tap, and every order goes to Shop's checkout page, where the developer pays by hand. The amount is set for them: 4 times the weekly limit of the default policy (step 6 applies $40 a week), so $160 a month. Show:

> **Your turn**
>
> 1. Turn on agent payments in Shop: open this page, tap the intent connection, turn on "Allow agent to pay for me" and enter $160 monthly.
>
> https://shop.app/account/connections

   Then say, in one line: Shop enforces this amount itself, as a safety net, while intent's policy does the day-to-day limiting. And in one plain sentence: it is the only stop an agent with shell access cannot get around, because any program running as them can read the Shop token on this computer.
4. Right away, run `intent wallet status --wait-budget`, with a long timeout (10 minutes). It sees the amount once Shop shows it. Show its "Budget seen" line in your reply, and any warning it prints that the amount is too high. If the developer would rather not turn on agent payments, go on: every order then goes to Shop's checkout page.

## Step 6: the policy

Install the policy-advisor skill from this exact package version into this project's `.claude/skills/`:

```console
$ tmp="$(mktemp -d)"
$ npm pack intent-gateway@0.1.0-preview.5 --pack-destination "$tmp"
$ tar -xzf "$tmp/intent-gateway-0.1.0-preview.5.tgz" -C "$tmp" package/onboarding/skills/policy-advisor
$ mkdir -p .claude/skills
$ cp -R "$tmp/package/onboarding/skills/policy-advisor" .claude/skills/
```

Then run the skill `policy-advisor`. If it is not listed yet, read `.claude/skills/policy-advisor/SKILL.md` and follow it. It applies the default rules at once, shows them in the gateway's panel, changes them only when the developer asks, and ends with `intent policy test`.

## Step 7: Pause

Tell the developer these two lines, exactly:

> intent pause stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off the budget in the Shop app.

If `intent --help` does not list `pause` yet, add that the command arrives in a later release, and that turning off agent payments in Shop works today.

## Step 8: the first purchase

1. Check that you have the `intent` tools (`find_offers`, `create_cart`, `get_approval_status`). If not, Claude Code has not started the gateway yet: it starts MCP servers only when it starts, and the gateway reads its policy then. Show:

> **Your turn**
>
> 1. Quit Claude Code, then run this in this folder and say "continue":
>
> `claude --continue`

2. Show:

> **Your turn**
>
> 1. Tell me one small thing to buy, under $20, and the 5-digit ZIP code to ship it to.

3. Call `find_offers` with what they said. Call `create_cart` for the cheapest offer that matches it and fits the policy, and say in one line which one you picked. They see the item and total before they approve, and can decline there.
4. Show:

> **Your turn**
>
> 1. Open the approval page, check the item and total, and approve with your passkey.
>
> <the approval link, as a clickable link>

   Never approve for them.
5. Right away, call `get_approval_status` until it says `ordered`, `failed` or `mismatch`, and tell them the result in one line. If Shop could not pay in one tap, the status says so and offers Shop's checkout page, where they pay by hand.

## Step 9: read the log together

1. Run `intent log` and go through it with the developer, in your reply: for each action, say in your own words what was sent, what came back and what was blocked. A call to Shop shows its status, with no receipt because Shop signs none.
2. Run `intent verify`. It re-checks the local hash chain, every receipt Intent Cloud returns and every approval, and ends with `verify: ok`. Put its last line in your reply.
3. Tell them what these prove: what the gateway sent, what Intent Cloud acknowledged receiving and what Shop returned. They make no claim about what happens to that data afterwards.

Setup is done. To change the limits later, run the policy-advisor skill again.
