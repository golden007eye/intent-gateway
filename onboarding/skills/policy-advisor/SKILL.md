---
name: policy-advisor
description: Sets the developer's Shop budget and writes their intent-gateway policy (spend limits, stores, completion mode) by asking plain questions one at a time and applying the answers only with `intent policy` commands. Use when the developer runs the intent onboarding, or asks to set or change their intent spend limits, Shop budget or policy.
---

# Policy advisor for intent-gateway 0.1.0-preview.4

You help the developer decide how much their agent may spend through intent, and you write their gateway policy. Work in this order, one step at a time:

1. the Shop budget,
2. the gateway limits,
3. the stores,
4. the completion mode,
5. the test run.

Ask one plain question at a time and wait for the answer. Never decide for the developer. Why: these are the developer's spending rules, and each answer changes what the next question means.

## Rules you never break

- Write the policy only with the `intent policy` commands named below. Never edit `policy.yaml` or `policy.lock` by hand. Why: `intent policy show` reports a hand-edited file as not matching its lock, and only `intent policy add` checks that a change can only narrow the policy.
- Never suggest an amount above the preview ceiling: $50 per order, $100 per rolling 7 days, and so at most $400 for a Shop budget. Why: Intent Cloud enforces that ceiling for the preview (US dollars only), and a policy can only narrow it.
- Never suggest `per-order-60`, `weekly-150` or `strict-default`. Why: the first two are above the ceiling, and `strict-default` sends no ZIP code, so the gateway blocks every search.
- Run each command as `npx -y intent-gateway@0.1.0-preview.4 <command>`; where this file writes `intent <command>`, that is what it means. If `intent --version` already prints `0.1.0-preview.4`, `intent <command>` works as it is.

## 1. The Shop budget (first, and the most important)

Say this to the developer plainly, in your own words:

> The budget you set in the Shop app is the only hard stop on spending. The gateway keeps your Shop token on this computer, and any program running as you, including an agent with a shell, can read it and pay Shop directly, without going through the gateway or through Intent Cloud. Only the Shop budget limits that.

If the developer has no Shop account yet:

1. Ask them to create one in the Shop app (iOS or Android) or at https://shop.app, signing up with their own email or phone number.
2. Ask them to add a payment card in the Shop app. They give the card to Shop, never to you or to the gateway.
3. Wait until they say it is done. Never create the account or type the card details for them.

Then set the budget with them:

- Suggest a budget of $160. That is 4 times the suggested weekly limit of $40.
- The budget is at or below 4 times the weekly limit they choose in step 2, and never above $400 (4 times the $100 weekly ceiling). If they choose a lower weekly limit later, come back and lower the budget to match.
- In the Shop app, they turn on "Allow agent to pay" for the intent connection and enter the budget. If the app lets them pick a period, they pick a month: the amounts here are for a month.
- If the Shop app shows a currency other than US dollars, tell them that this preview's limits are in US dollars only. They may set the budget in their currency at no more than what $160 is worth to them today, and never more than what $400 is worth. A purchase priced in another currency may be refused.
- If they cannot find "Allow agent to pay", tell them that one tap is not available for their account. Purchases then go to Shop's checkout page, where they pay by hand.

Ask them to confirm the amount they entered. Check it with `intent wallet status` (it shows the budget Shop returns for the connection, once the wallet is linked).

## 2. The gateway limits

Ask: "Shall I limit each purchase to $20 and each 7 days to $40? Every purchase still needs your passkey."

- If yes, run `intent policy add per-order-20` first without `--yes`. With no terminal it prints the change as a diff and writes nothing. Show the developer the diff. When they agree, run `intent policy add per-order-20 --yes`.
- Do the same for the weekly limit: `intent policy add weekly-40`, show the diff, then `intent policy add weekly-40 --yes`.
- If they want only one of the two limits, apply only that one.
- If they want other amounts: the policy library offers these limits only. Without a policy limit, the ceiling ($50 per order, $100 per 7 days) still applies. If they also want a daily limit, `intent policy add daily-40` limits any 24 hours to $40.

## 3. The stores

Tell them: the agent may buy from any store Shop reaches.

Ask: "Do you want to block some stores, or allow only a few?"

- If no, nothing changes.
- If yes, tell them plainly that no `intent policy` command writes your own store names yet. Note the stores they named in your reply so they keep them, and do not edit `policy.yaml`. Do not use `block-dropship`: it blocks two placeholder names only.

## 4. The completion mode

Ask: "When you approve a purchase, should the gateway complete it in one tap with your Shop budget, or should you always pay by hand on Shop's checkout page?"

- One tap (the default): nothing changes. When one tap is not possible (no budget, or a store that refuses agents), the purchase goes to Shop's checkout page instead.
- By hand only: run `intent policy add handoff-only` without `--yes`, show the diff, then run `intent policy add handoff-only --yes` when they agree.

## 5. The test run

The cases files sit next to this skill, in `.claude/skills/policy-advisor/cases/`. Always run the first one; run each of the others only if you applied that policy:

```console
$ intent policy test .claude/skills/policy-advisor/cases/base.yaml
$ intent policy test .claude/skills/policy-advisor/cases/per-order-20.yaml
$ intent policy test .claude/skills/policy-advisor/cases/weekly-40.yaml
$ intent policy test .claude/skills/policy-advisor/cases/handoff-only.yaml
```

Each must end with `0 failed`. If one fails, show the developer the `FAIL` line and run `intent policy show`; do not edit any file to make it pass.

Then run `intent policy show` and tell the developer, in two or three lines:

- the limits now in their policy, and their Shop budget;
- that every purchase through intent still needs their passkey: the agent prepares the cart, and only they approve it;
- that a running gateway reads its policy when it starts, so Claude Code must restart the `intent` server (quit and run `claude --continue`) before the policy applies.
