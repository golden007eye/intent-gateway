---
name: policy-advisor
description: Shows the developer's intent-gateway policy in the gateway's panel, applies the default policy ($20 per order, $40 per 7 days) only when there is no policy file, and changes the policy only when the developer asks, showing each change as a diff first. Writes the policy only with `intent policy` commands. Use when the developer runs the intent onboarding, or asks to see or change their intent spend limits, stores, completion mode or Shop agent payments.
---

# Policy advisor for intent-gateway 0.1.0-preview.7

You show the developer their gateway policy and change it only when they ask. Work in this order:

1. read the policy,
2. show it in the panel,
3. change it only when the developer asks,
4. the test run,
5. a restart, only if the policy changed.

Do not narrate commands or paste their output: between developer actions, say only one short status line (`✓ <n>/9  <what happened>. Next: <what>.`). When the onboarding runs you, say none: its step 6 line, said after you finish, is your only status line. Each developer action is a block in your own reply, without the `>` marks: the bold **Your turn:** marker and a short label, one action in short lines, its link on its own line. It ends your reply, with "Reply done" unless the developer answers it with a choice or with "continue". Say nothing after a block while the developer acts.

## Rules you never break

- Write the policy only with the `intent policy` commands named below, and remove it only as "Loosen a limit" says. Never edit `policy.yaml` or `policy.lock` by hand. Why: `intent policy show` reports a hand-edited file as not matching its lock.
- The policy file is the developer's: change it only when they ask, and show the change first. Run `intent policy add <name>` without `--yes`: with no terminal it prints the change as a diff, writes nothing, and exits 2 with `not applied: stdin is not a terminal, so no one can confirm the change; re-run with --yes to apply it`. That exit and that line are the expected preview, not an error. Show the diff, ask, and run it again with `--yes` only when they agree. Why: `intent policy add` narrows the developer's current file, so a change they did not ask for takes away something they chose.
- Never suggest an amount above the preview ceiling: $50 per order, $100 per rolling 7 days, and so at most $400 for Shop agent payments. Why: Intent Cloud enforces that ceiling for the preview, and a policy cannot go above it. The policy is in US dollars; outside the US the gateway scales each limit by Intent Cloud's ceiling for that currency (CAD 28 for $20 in Canada), so name an amount in another currency only as `intent wallet status` prints it.
- Never suggest `per-order-60`, `weekly-150` or `strict-default`. Why: the first two are above the ceiling, and `strict-default` sends no ZIP code, so the gateway blocks every search.
- Run each command as `npx -y intent-gateway@0.1.0-preview.7 <command>`; where this file writes `intent <command>`, that is what it means. If `intent --version` already prints `0.1.0-preview.7`, `intent <command>` works as it is.

## Shop agent payments

Shop's agent payments are Shop's permission for the agent to pay at all, with an amount. It is not a second budget to plan: the gateway sets the amount from the policy, as 4 times its weekly limit, in the Shop account's currency: say only the amount `intent wallet status` prints. When the onboarding has already set it, do not ask about it again; discuss another amount only if the developer asks.

When you say what it is for, say it in one line: Shop says it enforces it itself, as a safety net, while the gateway policy does the day-to-day limiting. And in one plain sentence:

> It is the only stop an agent with shell access cannot get around: the gateway keeps your Shop token on this computer, and any program running as you can read it and pay Shop directly, without going through the gateway or through Intent Cloud.

## 1. Read the policy

Run `intent policy show`.

- If it says `no policy file at`, there is no policy yet (the skill runs outside the onboarding): apply the default policy, $20 per order and $40 per 7 days, and say so in one line:

```console
$ intent policy add per-order-20 --yes
$ intent policy add weekly-40 --yes
```

- Otherwise the policy file is the developer's: never apply the defaults again, with or without `--yes`.

## 2. Show it in the panel

Start `intent panel` in the background with your shell tool's own background option (`run_in_background` in Claude Code), not with `&`, `nohup` or a log file of your own, so you can stop it. It keeps running until you stop it. Read the address from its `panel: http://127.0.0.1:<port>/` line. When the developer answers the block below, stop that background task; your status line, or the onboarding's step 6 line, says the panel is stopped. The panel shows your rules; changes go through you, with the commands below. If the developer says nothing about the rules, or keeps them, go on to the test run. Show:

> **Your turn:** look at your rules (optional)
>
> Here are your rules. Keep them, or tell me what to change.
>
> http://127.0.0.1:<port>/#/policy

## 3. Change it only when the developer asks

Each change: run the command without `--yes`, show the diff, and run it with `--yes` only when they agree.

- A daily limit too: `intent policy add daily-40` limits any 24 hours to $40, then `intent policy add daily-40 --yes`.
- Always pay by hand on Shop's checkout page, never in one tap: `intent policy add handoff-only`, then `intent policy add handoff-only --yes`.
- A tighter per-order or weekly limit: `intent policy add per-order-20` or `intent policy add weekly-40` if not applied yet, then the same with `--yes`. The policy library offers these limits only; without a policy limit, the ceiling ($50 per order, $100 per 7 days) still applies.
- Stores: the agent may buy from any store Shop reaches. No `intent policy` command writes your own store names yet: note the stores they named in your reply so they keep them, and do not edit `policy.yaml`. Do not use `block-dropship`: it blocks two placeholder names only.

### Loosen a limit

`intent policy add` only narrows the current file, so a looser policy starts from no file. Only when the developer asks to loosen or drop a limit:

1. Tell them which limits they keep and which go, and ask before you remove anything.
2. Remove the policy file and its lock: the paths are the `policy:` line of `intent policy show` and `policy.lock` beside it. With no file, the gateway uses the bundled `zip-only` policy.
3. Add back only the limits they want, each as above: without `--yes`, the diff, then with `--yes`.

If the weekly limit changed, say in one line that they can change agent payments in Shop to 4 times the new weekly limit, where they turned it on.

## 4. The test run

The cases files sit next to this skill, in `.claude/skills/policy-advisor/cases/`. Always run the first one; run each of the others only if that policy is applied:

```console
$ intent policy test .claude/skills/policy-advisor/cases/base.yaml
$ intent policy test .claude/skills/policy-advisor/cases/per-order-20.yaml
$ intent policy test .claude/skills/policy-advisor/cases/weekly-40.yaml
$ intent policy test .claude/skills/policy-advisor/cases/handoff-only.yaml
```

Each must end with `0 failed`. If one fails, show the developer the `FAIL` line and run `intent policy show`; do not edit any file to make it pass.

Then run `intent policy show` and say, in one or two lines: the limits now in the policy, and that every purchase through intent still needs their passkey.

## 5. A restart, only if the policy changed

A running gateway reads its policy when it starts. If nothing changed, say nothing about a restart. When the onboarding runs you, say nothing either: its restart before the first purchase picks up any change. Otherwise, if you applied, changed or removed anything in this skill, show:

> **Your turn:** restart Claude Code
>
> Quit Claude Code. In a new terminal in this folder, run this and say "continue":
>
> `claude --continue`
