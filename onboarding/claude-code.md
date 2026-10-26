<!--
Onboarding prompt for Claude Code, for intent-gateway 0.1.0-preview.5 (`pnpm release` sets the version below).
Intent Cloud serves it from the try link and fills in the placeholders per invite before serving:
  {{INTENT_INVITE}}        the invite token of this try link; passed to no gateway command
  {{INTENT_CLOUD_URL}}     the Intent Cloud host for this lane; today it equals the gateway's default host
  {{INTENT_SIGNUP_URL}}    the invite-gated sign-up page where the developer creates the passkey
-->

# Set up intent with Claude Code

You are setting up intent-gateway for the developer you are talking to. The gateway lets you find products and prepare carts; the developer approves every purchase with their passkey, and Shop pays only when the developer allows agent payments there. This prompt was served for invite `{{INTENT_INVITE}}`. Never pass that invite to any command.

How to work:

- Do one step at a time, in order. Run the commands yourself.
- Do not narrate commands or paste their output. Between developer actions, say only the status line: `✓ <n>/9  <what happened>. Next: <what>.` Here `<n>` is the step just finished and 9 is the number of steps. Use that mark and that form every time. The only other thing you may say is a command's error line and the fix it names.
- Anything the developer must see, click or type (a link, a code, a choice) goes in your own reply, written out in full, never only in a command's output. Why: Claude Code does not reliably show command output to the developer.
- Each developer action is a block in your own reply, copied from this prompt with its link or code filled in. It starts with the bold **Your turn:** marker and a short label. It gives one action, in short lines, with its link or code on its own line. It ends with "Reply done" only when no command can see that the action is done. Where a command can see it (the Shop link, agent payments, the purchase), run that command instead of asking. Say nothing after a block while the developer acts.
- The commands that wait (`intent wallet link shop --finish`, `intent wallet status --wait-budget`, `get_approval_status`) send only the gateway's normal requests to Shop and Intent Cloud and read what each returns; every request is in the log before it leaves.
- Never ask for, type or store the developer's name, postal address or card. They give those to Shop themselves.
- If a command fails, show its error line and the fix it names, and stop at that step. Do not work around it.
- If the developer is stuck, tell them, in these words: "If you get stuck, you can send this conversation to the intent team. It contains your invite link, so don't post it publicly."

In every step, `intent <command>` means this exact command line:

```console
$ INTENT_CLOUD_URL={{INTENT_CLOUD_URL}} npx -y intent-gateway@0.1.0-preview.5 <command>
```

Your first reply is this opening, and nothing else:

> Setting up intent: about 10 minutes. You'll do 8 things: sign up and create a passkey, approve the Shop link, turn on agent payments, look at your rules (optional), restart Claude Code, say what to buy, pick an offer, approve with your passkey.

## Step 1: check Node and the folder

1. Run `node --version`. The gateway needs Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+. Node 23 and 25 are not supported. If this Node is outside that range, follow "Get a supported Node" below, then come back to this step.
2. Run `pwd`. You must be in a project folder that the developer chose, not their home folder or `/`. If you are not, ask them to open Claude Code in a project folder and paste this prompt again. Why: step 6 installs a skill into this project's `.claude/skills/`, and nothing is installed globally.

### Get a supported Node

1. Find what installs Node on this computer and use the first one found:
   - nvm, if `test -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh"` succeeds. nvm is a shell function, so `command -v nvm` does not find it.
   - fnm, if `command -v fnm` prints a path.
   - Homebrew, if `command -v brew` prints a path.
2. Show the developer the command for it and ask before you install anything. If they say no, stop here.
   - nvm: `. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install 24 && nvm alias default 24`
   - fnm: `fnm install 24 && fnm default 24`
   - Homebrew: `brew install node@24`. Brew does not put node@24 on the PATH, so also ask before adding it to their shell profile, once: `grep -qs 'node@24/bin' ~/.zshrc || echo "export PATH=\"$(brew --prefix node@24)/bin:\$PATH\"" >> ~/.zshrc`. If their shell is bash, use `~/.bash_profile` on macOS (Terminal starts a login shell) or `~/.bashrc` on Linux in both places.
   - None of them: ask the developer to install Node 24 LTS from https://nodejs.org and say when it is done.
3. Each command you run may start a fresh shell, so until the developer restarts Claude Code (start of step 8), start every command that runs Node (`node`, `npx`, `npm` and every `intent` command) with the switch for the tool you used. Run `claude mcp add` without it: with nvm or fnm, a `claude` installed with npm can drop off the PATH.
   - nvm: `. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 24 >/dev/null && `
   - fnm: `eval "$(fnm env)" && fnm use 24 >/dev/null && `
   - Homebrew: `PATH="$(brew --prefix node@24)/bin:$PATH" `
   - the installer: nothing; if `node --version` still shows the old Node, show the restart block from step 8 now (step 8 shows it again, for Shop).
4. Run `node --version` with that switch and continue at step 1. The restart at the start of step 8 makes the new Node the one Claude Code and the gateway use, so the developer restarts only once.

## Step 2: install the gateway

1. Check that the package runs: `intent --version` must print `0.1.0-preview.5`.
2. Add the gateway to Claude Code for this project:

```console
$ claude mcp add intent -e INTENT_CLOUD_URL={{INTENT_CLOUD_URL}} -- npx -y intent-gateway@0.1.0-preview.5
```

If Claude Code already has an MCP server named `intent` (for example a connector added in the developer's Claude account), ask the developer before you add this one under another name, such as `intent-gateway`, so you never pick the wrong one.

## Step 3: first run and the default policy

1. Run `intent init`. It checks the setup, makes the gateway's account key, and prints the line that connects an agent; you already ran that line in step 2. If it mentions Shop, that is step 5.
2. Run `intent policy show`. Only if it says `no policy file at`, apply the default policy, $20 per order and $40 per 7 days:

```console
$ intent policy add per-order-20 --yes
$ intent policy add weekly-40 --yes
```

   If a policy file exists, leave it as it is: it is the developer's. Step 6 shows the rules either way.

## Step 4: sign up and create the passkey

This step is required: never skip it, also when the developer says they already have an account. Never open the page or fill it in for them. No command can see this step, so show this block and wait for "done". Every purchase needs this passkey; the first purchase's approval (step 8) is where it is really checked.

> **Your turn:** sign up and create a passkey
>
> Sign up with your invited email and create a passkey.
>
> Already have an account? Check its account page shows a passkey.
>
> {{INTENT_SIGNUP_URL}}
>
> Reply done

## Step 5: link Shop and turn on agent payments

1. Run `intent wallet link shop --start`. It prints one line, `Open <link> and approve the code <CODE> in Shop before <time>, then run <the --finish command>`, and exits; the command it names is the one you ran, with `--finish`. Show the link and the code from that line:

> **Your turn:** approve the Shop link
>
> Open this link and approve intent in Shop.
>
> The code is already filled in if you use this link.
>
> <the link, as a clickable link>
>
> <the code>

2. Right away, run `intent wallet link shop --finish`, with a long timeout (10 minutes): it waits for the approval. If it stops early, run `intent wallet link shop --finish` again. If the code expired, go back to 1. If Shop denied the link, ask the developer whether to try again. If the developer has no Shop account, they create one from that link or in the Shop app, and add a payment card in Shop.
3. Agent payments are Shop's permission for the agent to pay at all: without them no purchase completes in one tap, and every order goes to Shop's checkout page, where the developer pays by hand. Once the link is approved, `--finish` prints one of four outcomes:
   - `Agent payments on: …` (they are already on): skip the block below and go to the note in 4.
   - Agent payments are on and the limit is high enough, but this period's amount is spent: one line that starts `Agent payments are on, but only <left> is left until Shop renews it` and ends `so wait for that renewal rather than raising it.` There is nothing to raise: say that line as a one-line status, not a **Your turn** block, and add in one line that until Shop renews it, purchases are handed off to Shop's checkout page. Then skip 4 and go to step 6. `intent wallet status` and `intent wallet status --wait-budget` can print the same line; say it the same way.
   - Agent payments are off: a Shop page, then `Tap …, turn on Allow agent to pay for me, enter <amount>.`, with the amount it prints: the gateway sets it from the policy, in the Shop account's currency, so never say another.
   - Agent payments are on but too little is left for one purchase: a Shop page, then `Agent payments are on, but only <left> is left; raise it to <amount>.`

   For the last two, show the last two lines `--finish` printed, word for word, and nothing else (when Shop names no page, it prints only the second line; leave the link line out). `intent wallet status --wait-budget` can print the same low lines when it starts; show them the same way:

> **Your turn:** turn on agent payments
>
> <the last line `--finish` printed>
>
> <the line before it, the Shop page, as a clickable link>

4. Right away, run `intent wallet status --wait-budget --timeout 540`, with a 10-minute timeout for the command (540 s leaves time for `npx` to start, so its own timeout line is printed before the command is stopped). It waits until Shop shows agent payments on, with at least one purchase's limit left. When it prints `Agent payments on: …`, say that line, any line it prints that starts `intent: warning: this limit is above` or `Note:` (why it names no amount), and this note, in two short lines:
   - "Shop says it enforces this amount itself, as a safety net; intent's policy does the day-to-day limiting."
   - "It is the only stop an agent with shell access can't get around: any program running as you can read the Shop token on this computer."

   If it prints a line that starts `intent: no Shop agent payments seen after` or `intent: Shop agent payments are still low after`, say that line and ask whether to wait again; if yes, run `intent wallet status --wait-budget --timeout 540` again. If the developer would rather not turn on agent payments, go on: every order then goes to Shop's checkout page.

   If `--finish` or `--wait-budget` prints a line that starts `intent: the ceilings Intent Cloud returns could not be read`, it exits 1 and the amount left was not checked. `--finish` has still linked Shop, and prints the Shop page and what to tap, with no amount: show those two lines as the **Your turn** block above. Say that line, then run `intent wallet status --wait-budget --timeout 540` once more. If it prints the same line again, say in one line that the amount could not be checked right now, and go on to step 6; run it again before the first purchase.

## Step 6: the policy

Install the policy-advisor skill from this exact package version into this project's `.claude/skills/`:

```console
$ tmp="$(mktemp -d)"
$ npm pack intent-gateway@0.1.0-preview.5 --pack-destination "$tmp"
$ tar -xzf "$tmp/intent-gateway-0.1.0-preview.5.tgz" -C "$tmp" package/onboarding/skills/policy-advisor
$ mkdir -p .claude/skills
$ cp -R "$tmp/package/onboarding/skills/policy-advisor" .claude/skills/
```

Then run the skill `policy-advisor`. If it is not listed yet, read `.claude/skills/policy-advisor/SKILL.md` and follow it. It shows the rules in the gateway's panel (the "look at your rules" block), changes them only when the developer asks, and ends with `intent policy test`. The restart in step 8 picks up any change.

## Step 7: Pause

Tell the developer these two lines, exactly:

> intent pause stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off the budget in the Shop app.

Then add, in one line, that turning off agent payments in Shop is that hard stop.

## Step 8: the first purchase

1. Claude Code starts the gateway only when Claude Code starts, and the gateway reads its policy and looks for the Shop wallet then. One restart now picks up the gateway, the policy, the Shop link and, if you switched it in step 1, the new Node. If you switched Node, first say in one line: "If `claude` is not found in the new terminal, reinstall Claude Code with `npm i -g @anthropic-ai/claude-code`, or with its native installer." Then show:

> **Your turn:** restart Claude Code
>
> Quit Claude Code. In a new terminal in this folder, run this and say "continue":
>
> `claude --continue`

2. After "continue": check that you have the `intent` tools (`find_offers`, `create_cart`, `get_approval_status`) and that `node --version` is in the range of step 1. If not, show the block again. `find_offers` takes a country, a postcode and a budget in that country's currency. Show:

> **Your turn:** say what to buy
>
> Tell me one small thing to buy, and the most you'll spend (under $20, CAD 28 or AUD 30).
>
> Where should it ship? Country and postcode.

3. Call `find_offers` with what they said, with `country` (its two-letter code), `postcode` and `budget` as they gave them. If it refuses the country, say its line as it is. List the top 2 or 3 offers, numbered, one short line each: item, store and price, as the result writes them (a Shop offer shows no total: shipping is shown at checkout). Then show:

> **Your turn:** pick an offer
>
> Reply with the number of the offer you want.

4. Call `create_cart` for the offer they picked, with its `offer_handle`. Never approve for them. Show:

> **Your turn:** approve with your passkey
>
> Open the approval page, check the item and total, and approve with your passkey.
>
> <the approval link, as a clickable link>

5. Right away, call `get_approval_status`. Call it again, about 5 s later each time, only while its result says `Waiting for` (the approval is pending) or tells you to call `get_approval_status` again. If it still tells you to call again after about 3 minutes (a one-tap purchase whose result Shop has not confirmed), stop calling and relay the result's own advice, such as "Check the order in the Shop app", in one line. Any other result is final: relay what it says, in one line, and no more. Never offer a link or a next step the result does not give; if it says to create a new cart, offer that.

## Step 9: read the log together

1. Run `intent log` and go through it with the developer in at most five short lines: what was sent, what came back and what was blocked. A call to Shop shows its status, with no receipt because Shop signs none.
2. Run `intent verify`. It re-checks the local hash chain, every receipt Intent Cloud returns and every approval, and ends with `verify: ok`.
3. Tell them, in one line, what these prove: what the gateway sent, what Intent Cloud acknowledged receiving and what Shop returned. They make no claim about what happens to that data afterwards.

Setup is done. To change the limits later, the developer runs the policy-advisor skill again. End with this card, and nothing after it. Fill it in from the text the tools returned, and only with what that text says:

- the outcome: `ordered`, with `order <number>` only when the `get_approval_status` result names one (`One-tap: ordered …, order <number>`, or "placed the order (order <number>)"); "handed off to Shop's checkout" when the result says the buyer pays at the checkout or was handed off; otherwise "not completed" and the reason the result gives. Never say paid or ordered unless the result says ordered.
- the store and total: from the `create_cart` result's line `… from <store>, total <total> …`.

> **Done:** <outcome>, from <store>, total <total>
>
> `intent log` shows what the gateway sent.
>
> `intent pause` stops every purchase that goes through intent and isn't paid yet.
