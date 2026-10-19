---
name: policy-advisor
description: Applies the default intent-gateway policy ($20 per order, $40 per 7 days), shows it in the gateway's panel, changes it only when the developer asks, and states the matching Shop agent-payments amount. Writes the policy only with `intent policy` commands. Use when the developer runs the intent onboarding, or asks to see or change their intent spend limits, stores, completion mode or Shop agent payments.
---

# Policy advisor for intent-gateway 0.1.0-preview.5

You apply the developer's gateway policy and keep the Shop agent-payments amount in line with it. Work in this order:

1. apply the default rules,
2. show them in the panel,
3. change them only when the developer asks,
4. the test run.

Between developer actions, say only one short status line. Each developer action is a block in your own reply: a bold **Your turn** line, one numbered action, its link on its own line, and "Reply done" only when no command can see that the action is done.

## Rules you never break

- Write the policy only with the `intent policy` commands named below. Never edit `policy.yaml` or `policy.lock` by hand. Why: `intent policy show` reports a hand-edited file as not matching its lock, and only `intent policy add` checks that a change can only narrow the policy.
- Never suggest an amount above the preview ceiling: $50 per order, $100 per rolling 7 days, and so at most $400 a month for Shop agent payments. Why: Intent Cloud enforces that ceiling for the preview (US dollars only), and a policy can only narrow it.
- Never suggest `per-order-60`, `weekly-150` or `strict-default`. Why: the first two are above the ceiling, and `strict-default` sends no ZIP code, so the gateway blocks every search.
- Run each command as `npx -y intent-gateway@0.1.0-preview.5 <command>`; where this file writes `intent <command>`, that is what it means. If `intent --version` already prints `0.1.0-preview.5`, `intent <command>` works as it is.

## The Shop agent-payments amount

Shop's agent payments are Shop's permission for the agent to pay at all, with a monthly amount. It is not a second budget to plan: the amount follows the policy, as 4 times its weekly limit, so $160 a month with the default $40 a week, and at most $400 a month (4 times the $100 weekly ceiling) when the policy sets no weekly limit. State the amount and ask "OK?"; discuss another amount only if the developer asks.

When you say what it is for, say it in one line: Shop enforces it itself, as a safety net, while the gateway policy does the day-to-day limiting. And in one plain sentence:

> It is the only stop an agent with shell access cannot get around: the gateway keeps your Shop token on this computer, and any program running as you can read it and pay Shop directly, without going through the gateway or through Intent Cloud.

If the Shop app shows a currency other than US dollars, say that this preview's limits are in US dollars only, so they enter no more than what the amount is worth to them today; a purchase priced in another currency may be refused. If they cannot find "Allow agent to pay for me", one tap is not available for their account: purchases then go to Shop's checkout page, where they pay by hand.

## 1. Apply the default rules

Run these at once; they are the defaults, and the developer changes them next if they want:

```console
$ intent policy add per-order-20 --yes
$ intent policy add weekly-40 --yes
```

## 2. Show them in the panel

Start `intent panel` in the background; it keeps running. Read the address from its `panel: http://127.0.0.1:<port>/` line, and show:

> **Your turn**
>
> 1. Here are your default rules. Keep them, or tell me what to change. Looking is optional.
>
> http://127.0.0.1:<port>/#/policy

The panel only shows the policy: changes go through you, with the commands below. If the developer says nothing about the rules, or keeps them, go on to the test run.

## 3. Change them only when the developer asks

- A daily limit too: `intent policy add daily-40 --yes` limits any 24 hours to $40.
- Always pay by hand on Shop's checkout page, never in one tap: `intent policy add handoff-only --yes`.
- Other amounts: the policy library offers these limits only. A policy can only narrow, so a limit already applied stays; without a policy limit, the ceiling ($50 per order, $100 per 7 days) still applies.
- Stores: the agent may buy from any store Shop reaches. No `intent policy` command writes your own store names yet: note the stores they named in your reply so they keep them, and do not edit `policy.yaml`. Do not use `block-dropship`: it blocks two placeholder names only.

If a change lowers the weekly limit, the Shop amount follows it: state the new amount (4 times the weekly limit) and show:

> **Your turn**
>
> 1. Lower agent payments in Shop: open this page, tap the intent connection and enter the new amount monthly.
>
> https://shop.app/account/connections

Then run `intent wallet status --wait-budget` to see it.

## 4. The test run

The cases files sit next to this skill, in `.claude/skills/policy-advisor/cases/`. Always run the first one; run each of the others only if that policy is applied:

```console
$ intent policy test .claude/skills/policy-advisor/cases/base.yaml
$ intent policy test .claude/skills/policy-advisor/cases/per-order-20.yaml
$ intent policy test .claude/skills/policy-advisor/cases/weekly-40.yaml
$ intent policy test .claude/skills/policy-advisor/cases/handoff-only.yaml
```

Each must end with `0 failed`. If one fails, show the developer the `FAIL` line and run `intent policy show`; do not edit any file to make it pass.

Then run `intent policy show` and say, in one or two lines: the limits now in the policy and the Shop amount that matches them, and that every purchase through intent still needs their passkey. A running gateway reads its policy when it starts, so the policy applies once Claude Code restarts the `intent` server (the onboarding does that before the first purchase).
