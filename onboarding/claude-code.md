<!--
Onboarding prompt for Claude Code, for intent-gateway 0.1.0-preview.5 (`pnpm release` sets the version below).
Intent Cloud serves it from the try link and fills in the placeholders per invite before serving:
  {{INTENT_INVITE}}        the invite token of this try link; passed to no gateway command
  {{INTENT_CLOUD_URL}}     the Intent Cloud host for this lane; today it equals the gateway's default host
  {{INTENT_SIGNUP_URL}}    the invite-gated sign-up page where the developer creates the passkey
`intent pause` and `intent resume` are planned commands; test/onboarding.test.ts lists them as pending.
-->

# Set up intent with Claude Code

You are setting up intent-gateway for the developer you are talking to. The gateway lets you find products and prepare carts; the developer approves every purchase with their passkey, and Shop pays from a budget the developer sets. This prompt was served for invite `{{INTENT_INVITE}}`. Never pass that invite to any command.

How to work:

- Do one step at a time, in order. At the end of each step, say in one line what happened and what comes next.
- Run the commands yourself. When a step needs the developer (a browser page, the Shop app, a passkey), say exactly what to do and wait until they say it is done.
- Anything the developer must see, click or type (a link, a code, a choice) goes in your own reply, written out in full, never only in a command's output. Why: Claude Code does not reliably show command output to the developer.
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

Put {{INTENT_SIGNUP_URL}} in your reply as a clickable link and ask the developer to open it in their own browser. It is a registration page; no ChatGPT app is needed. Never open the page or fill it in for them. There they:

1. enter the email address that was invited;
2. enter the code sent to that email;
3. create their passkey (this step is required);
4. land on an account page, come back to this terminal and say "done".

If the developer says they already have an account, do not skip this step: ask them to open {{INTENT_SIGNUP_URL}} (or the account page it leads to), check there that their account has a passkey, create one if it has none, and say "done". Wait for "done" either way.

Every purchase will need this passkey: you prepare a cart, and only the developer approves it. The first purchase's approval (step 8) is where the passkey is really checked.

## Step 5: the Shop account

1. Ask whether they have a Shop account. If not, ask them to create one in the Shop app (iOS or Android) or at https://shop.app, and to add a payment card there. Wait until it is done.
2. Run `intent wallet link shop --start`. It prints a Shop link, a code and when they expire, then exits. In your reply, put the link as a clickable link and the code on its own line, and say: "the code is already filled in if you use this link". Ask the developer to open the link, check the code, approve, and say "done". Wait for "done".
3. Run `intent wallet link shop --finish`. It waits until Shop says the link was approved, denied or expired, so give it a long timeout (10 minutes). If it expired, go back to 2 and start again. If it was denied, ask the developer whether to try again.
4. Run `intent wallet status`. It must say the Shop wallet is linked.
5. Ask the developer to turn on "Allow agent to pay" for the intent connection in the Shop app, with a budget. Suggest $160, and never more than $400. Tell them plainly: the Shop budget is the only hard stop, because any program running as them can read the Shop token on this computer. The policy advisor in step 6 checks the amount with them.

## Step 6: the policy advisor

Install the policy-advisor skill from this exact package version into this project's `.claude/skills/`:

```console
$ tmp="$(mktemp -d)"
$ npm pack intent-gateway@0.1.0-preview.5 --pack-destination "$tmp"
$ tar -xzf "$tmp/intent-gateway-0.1.0-preview.5.tgz" -C "$tmp" package/onboarding/skills/policy-advisor
$ mkdir -p .claude/skills
$ cp -R "$tmp/package/onboarding/skills/policy-advisor" .claude/skills/
```

Then run the skill `policy-advisor`. If it is not listed yet, read `.claude/skills/policy-advisor/SKILL.md` and follow it. It sets the Shop budget with the developer first, then the gateway policy, and ends with `intent policy test`.

## Step 7: Pause

Tell the developer these two lines, exactly:

> intent pause stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off the budget in the Shop app.

If `intent --help` does not list `pause` yet, add that the command arrives in a later release, and that the Shop app budget works today.

## Step 8: the first purchase

1. Check that you have the `intent` tools (`find_offers`, `create_cart`, `get_approval_status`). If not, Claude Code has not started the gateway yet: ask the developer to quit, run `claude --continue` in this folder and say "continue".
2. Ask what small item they would like. It must cost less than their per-order limit (under $20 with the suggested limits) and fit in their Shop budget.
3. Call `find_offers`, show the offers, and call `create_cart` for the one they pick.
4. Put the approval link in your reply as a clickable link. The developer opens it, checks the item and total, and approves with their passkey. Never approve for them.
5. Call `get_approval_status` until it says `ordered`, `failed` or `mismatch`, and tell them the result. If Shop could not pay in one tap, the status says so and offers Shop's checkout page, where they pay by hand.

## Step 9: read the log together

1. Run `intent log` and go through it with the developer, in your reply: for each action, say in your own words what was sent, what came back and what was blocked. Each action shows the values the gateway sent, what came back and what was blocked. A call to Shop shows its status, with no receipt because Shop signs none.
2. Run `intent verify`. It re-checks the local hash chain, every receipt Intent Cloud returns and every approval, and ends with `verify: ok`. Put its last line in your reply.
3. Tell them what these prove: what the gateway sent, what Intent Cloud acknowledged receiving and what Shop returned. They make no claim about what happens to that data afterwards.

Setup is done. To change the limits later, run the policy-advisor skill again.
