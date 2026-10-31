// The onboarding prompt (onboarding/claude-code.md) and the policy-advisor skill it installs from the package
// (onboarding/skills/policy-advisor/): the skill parses as a Claude Code skill, every `intent …` command either file
// names exists in the CLI (or is on the short list of planned ones), no amount either suggests exceeds the preview
// ceiling, the version they name is package.json's, and the cases files the skill runs pass for every choice.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { COMMANDS, COMMON } from "../src/cli/index.ts";
import { loadPolicy, meet, type Policy, runCases } from "../src/policy/index.ts";
import { FindOffersInput } from "../src/gateway/index.ts";
import { SUPPORTED_NODE, nodeSupported } from "../src/runtime/index.ts";
import { SHOP_PUBLIC_CLIENT_ID } from "../src/disclosure/index.ts";

const repo = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string; files: string[]; engines: { node: string } };

const PROMPT = "onboarding/claude-code.md";
const SKILL = "onboarding/skills/policy-advisor/SKILL.md";
const FILES = [PROMPT, SKILL];

/** The Intent Cloud preview ceiling, in US dollars: per order and per rolling 7 days. Shop agent payments are ≤ 4 weeks. */
const CEILING = { perOrder: 50, perWeek: 100, budget: 400 };

/** Inline code spans and fenced code blocks: the only places a command is written. */
export function codeOf(markdown: string): string[] {
  const fences = [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "");
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
  return [...fences, ...spans];
}

/** Each `intent …` or `npx -y intent-gateway@<v> …` invocation in `code`, as its argument words. */
export function invocations(code: string): string[][] {
  const out: string[][] = [];
  // `claude mcp add intent …` names the server, not the CLI.
  for (const m of code.matchAll(/(?<![\w-]|mcp add )intent((?: +[^\s&|;#)"]+)*)/g)) {
    const words = (m[1] ?? "").trim().split(/ +/).filter((w) => w !== "");
    if (words.length > 0) out.push(words);
  }
  for (const m of code.matchAll(/npx -y intent-gateway@\S+((?: +[^\s&|;#)"]+)*)/g)) {
    out.push((m[1] ?? "").trim().split(/ +/).filter((w) => w !== ""));
  }
  return out.filter((words) => !(words[0] ?? "").startsWith("<"));
}

const GROUPS = new Set(Object.keys(COMMANDS).filter((c) => c.includes(" ")).map((c) => c.split(" ")[0] ?? ""));

/** Every reason `words` is not a command the CLI takes: an unknown command, a missing argument, each unknown option. */
export function problems(words: readonly string[]): string[] {
  const positionals = words.filter((w) => !w.startsWith("-"));
  const [first, second] = positionals;
  if (first === undefined) return words.every((w) => w === "--version" || w === "--help") ? [] : checkFlags("serve", words);
  if (GROUPS.has(first)) {
    // "the `intent policy` commands" names the group, which exists.
    if (second === undefined) return [];
    const command = `${first} ${second}`;
    if (!Object.hasOwn(COMMANDS, command)) return [`unknown command "${command}"`];
    // `wallet link` and `wallet unlink` take the rail: `shop` is the only one.
    const rail = command === "wallet link" || command === "wallet unlink" ? positionals[2] : "shop";
    return [...(rail === "shop" ? [] : [`${command} needs its rail, shop`]), ...checkFlags(command, words)];
  }
  return Object.hasOwn(COMMANDS, first) ? checkFlags(first, words) : [`unknown command "${first}"`];
}

/** problems(), as one line, or null when there are none. */
export function problem(words: readonly string[]): string | null {
  const found = problems(words);
  return found.length === 0 ? null : found.join("; ");
}

function checkFlags(command: string, words: readonly string[]): string[] {
  const options = { ...COMMON, ...COMMANDS[command] };
  const unknown: string[] = [];
  for (const word of words.filter((w) => w.startsWith("-"))) {
    if (word === "--version" || word === "--help") continue;
    const known = word.startsWith("--")
      ? Object.hasOwn(options, word.slice(2).split("=")[0] ?? "")
      : Object.values(options).some((o) => o.short === word.slice(1));
    if (!known) unknown.push(`unknown option ${word} for ${command}`);
  }
  return unknown;
}

const named = FILES.flatMap((file) => codeOf(read(file)).flatMap(invocations).map((words) => ({ file, words })));

describe("onboarding command check (the checker itself)", () => {
  it("finds the invocations and skips the MCP server name and placeholders", () => {
    expect(invocations("claude mcp add intent -e X=1 -- npx -y intent-gateway@1.2.3")).toEqual([[]]);
    expect(invocations("intent policy add per-order-20 --yes && echo ok")).toEqual([["policy", "add", "per-order-20", "--yes"]]);
    expect(invocations("npx -y intent-gateway@1.2.3 <command>")).toEqual([]);
  });

  it("flags an unknown command and an unknown option (attack: a made-up command must not pass)", () => {
    expect(problem(["frobnicate"])).toBe('unknown command "frobnicate"');
    expect(problem(["policy", "set", "--per-order", "20"])).toBe('unknown command "policy set"');
    expect(problem(["policy", "add", "per-order-20", "--force"])).toBe("unknown option --force for policy add");
    expect(problem(["init", "--invite", "abc"])).toBe("unknown option --invite for init");
    expect(problem(["policy", "add", "per-order-20", "-y"])).toBeNull();
    expect(problem(["wallet", "link", "shop"])).toBeNull();
  });

  it("reports every unknown option, and a wallet link without its rail (attack: a typo behind a known option)", () => {
    expect(problems(["wallet", "link", "shop", "--strat", "--yse"])).toEqual(["unknown option --strat for wallet link", "unknown option --yse for wallet link"]);
    expect(problems(["wallet", "link", "shop", "--start", "--yse"])).toEqual(["unknown option --yse for wallet link"]);
    expect(problems(["wallet", "link", "--finish"])).toEqual(["wallet link needs its rail, shop"]);
    expect(problems(["wallet", "link", "--finsh"])).toEqual(["wallet link needs its rail, shop", "unknown option --finsh for wallet link"]);
    expect(problems(["wallet", "link", "shpo"])).toEqual(["wallet link needs its rail, shop"]);
  });
});

describe("onboarding prompt and policy-advisor skill", () => {
  it("the skill has valid frontmatter: name policy-advisor and a description", () => {
    const text = read(SKILL);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    expect(front, "SKILL.md starts with a --- frontmatter block").toBeDefined();
    const meta = parseYaml(front ?? "") as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["description", "name"]);
    expect(meta.name).toBe("policy-advisor");
    expect(typeof meta.description).toBe("string");
    expect((meta.description as string).length).toBeGreaterThan(20);
    expect((meta.description as string).length).toBeLessThanOrEqual(1024);
  });

  it("names only commands the CLI has, or the planned ones", () => {
    expect(named.length).toBeGreaterThan(10);
    const bad = named.flatMap(({ file, words }) => problems(words).map((reason) => `${file}: intent ${words.join(" ")}: ${reason}`));
    expect(bad).toEqual([]);
    // Every `wallet link` keeps its rail.
    expect(named.filter(({ words }) => words[0] === "wallet" && words[1] === "link" && words[2] !== "shop")).toEqual([]);
  });

  it("names the Shop link and agent-payments options the CLI has", () => {
    expect(Object.keys(COMMANDS["wallet link"] ?? {}).sort()).toEqual(["finish", "start"]);
    expect(Object.keys(COMMANDS["wallet status"] ?? {}).sort()).toEqual(["timeout", "wait-budget"]);
  });

  it("the intent line signs in to Shop as Shop's public client: the gateway's own client is refused (a served prompt failed at the link)", () => {
    const prompt = read(PROMPT);
    const line = codeOf(prompt).find((c) => c.includes("npx -y intent-gateway@") && c.includes("<command>"));
    expect(line).toContain(`INTENT_SHOP_CLIENT_ID=${SHOP_PUBLIC_CLIENT_ID} npx`);
    // The vault keeps the linked client, so the server line needs none.
    expect(codeOf(prompt).find((c) => c.includes("claude mcp add intent"))).not.toContain("INTENT_SHOP_CLIENT_ID");
  });

  it("uses the commands the onboarding needs", () => {
    const lines = named.map(({ words }) => words.join(" "));
    for (const command of ["--version", "init", "wallet link shop --start", "wallet link shop --finish", "wallet status --wait-budget", "panel", "policy add per-order-20 --yes", "policy add weekly-40 --yes", "policy add handoff-only --yes", "policy show", "log", "verify"]) {
      expect(lines, command).toContain(command);
    }
    expect(lines.some((l) => l.startsWith("policy test "))).toBe(true);
    expect(lines.some((l) => l.includes("--invite"))).toBe(false);
    // The invite token belongs to the try link: no command line carries it.
    expect(codeOf(read(PROMPT)).filter((c) => c.includes("{{INTENT_INVITE}}") && /\s/.test(c))).toEqual([]);
  });

  it("every library policy the skill adds stays within the ceiling", () => {
    const added = named.filter(({ words }) => words[0] === "policy" && words[1] === "add").map(({ words }) => words[2] ?? "")
      .filter((name) => name !== "" && !name.startsWith("<"));
    expect(new Set(added)).toEqual(new Set(["per-order-20", "weekly-40", "daily-40", "handoff-only"]));
    for (const name of added) {
      const { spend } = loadPolicy(read(`policies/${name}/policy.yaml`));
      expect(spend.per_order_usd ?? 0, name).toBeLessThanOrEqual(CEILING.perOrder);
      expect(spend.per_day_usd ?? 0, name).toBeLessThanOrEqual(CEILING.perWeek);
      expect(spend.per_week_usd ?? 0, name).toBeLessThanOrEqual(CEILING.perWeek);
    }
  });

  it("suggests $20 per order and $40 a week, and no amount above the ceiling", () => {
    const skill = read(SKILL);
    expect(skill).toContain("$20");
    expect(skill).toContain("$40");
    for (const file of FILES) {
      for (const line of read(file).split("\n")) {
        for (const m of line.matchAll(/\$(\d+(?:\.\d+)?)/g)) {
          const amount = Number(m[1]);
          expect(amount, `${file}: ${line}`).toBeLessThanOrEqual(CEILING.budget);
          // Only the Shop agent-payments amount (four weeks) may go above the weekly ceiling.
          if (amount > CEILING.perWeek) expect(line, `${file}: $${String(amount)} outside an agent-payments line`).toMatch(/agent.payments/i);
        }
      }
    }
  });

  it("names exactly the package.json version", () => {
    for (const file of FILES) {
      // The Node range is checked on its own below, and the panel's loopback address is no version; any other is the package's.
      const versions = [...read(file).split(SUPPORTED_NODE).join("").split("127.0.0.1").join("").matchAll(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.\d+)*)?/g)].map((m) => m[0]);
      expect(versions.length, file).toBeGreaterThan(0);
      expect(new Set(versions), file).toEqual(new Set([pkg.version]));
    }
  });

  it("states the Node range src/runtime checks, which is package.json engines (a tester on 22.17.1 was told 24.15+ or 26+)", () => {
    expect(pkg.engines.node).toBe("^22.22.2 || ^24.15.0 || >=26.0.0");
    expect(SUPPORTED_NODE).toBe("Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+");
    const prompt = read(PROMPT);
    expect(prompt).toContain(SUPPORTED_NODE);
    // Attack: the old wording, which left out Node 22, must not come back beside the right one.
    expect(prompt).not.toMatch(/Node 24 at 24\.15|must be Node 2[46]/);
    // Every Node release the prompt names is a line SUPPORTED_NODE names, or one nodeSupported refuses (23, 25); it
    // claims no refusal the code does not make (Node 27 is accepted).
    const majors = new Set([...prompt.matchAll(/\bNode (\d+)/g)].map((m) => m[1]));
    expect([...majors].filter((m) => !["22", "23", "24", "25", "26"].includes(m ?? ""))).toEqual([]);
    expect(prompt).toContain("Node 23 and 25 are not supported.");
    expect(nodeSupported("23.11.0") || nodeSupported("25.9.0")).toBe(false);
    expect(prompt).not.toMatch(/[Oo]dd-numbered/);
  });

  it("gives a fix path for an unsupported Node, not a stop: nvm, fnm, Homebrew or nodejs.org, asked first, one restart", () => {
    const prompt = read(PROMPT);
    const fix = prompt.slice(prompt.indexOf("### Get a supported Node"), prompt.indexOf("## Step 2"));
    const code = codeOf(fix);
    // nvm is a shell function: found by its script, not by `command -v nvm`.
    expect(code).toContain('test -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh"');
    expect(code).toContain("command -v fnm");
    expect(code).toContain("command -v brew");
    expect(code).toContain('. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install 24 && nvm alias default 24');
    expect(code).toContain("fnm install 24 && fnm default 24");
    expect(code).toContain("brew install node@24");
    // node@24 is keg-only; brew --prefix gives /opt/homebrew on Apple Silicon and /usr/local on Intel. Appended once.
    expect(code).toContain(`grep -qs 'node@24/bin' ~/.zshrc || echo "export PATH=\\"$(brew --prefix node@24)/bin:\\$PATH\\"" >> ~/.zshrc`);
    expect(fix).toContain("use `~/.bash_profile` on macOS (Terminal starts a login shell) or `~/.bashrc` on Linux");
    expect(fix).not.toMatch(/\/opt\/homebrew|\/usr\/local/);
    expect(fix).toContain("https://nodejs.org");
    expect(fix).toMatch(/ask before you install anything/);
    // Each command may be a fresh shell: until the one restart, every Node command carries the switch.
    expect(code).toContain('. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 24 >/dev/null && ');
    expect(code).toContain('eval "$(fnm env)" && fnm use 24 >/dev/null && ');
    expect(code).toContain('PATH="$(brew --prefix node@24)/bin:$PATH" ');
    expect(fix).toMatch(/continue at step 1/);
    expect(fix).toContain("so the developer restarts only once");
    // `claude mcp add` runs without the switch: an npm-installed claude can drop off the PATH under nvm or fnm.
    expect(fix).toContain("Run `claude mcp add` without it: with nvm or fnm, a `claude` installed with npm can drop off the PATH.");
    // The one restart is in step 8, and says how to get `claude` back on the new Node.
    const step8 = prompt.slice(prompt.indexOf("## Step 8"), prompt.indexOf("## Step 9"));
    expect(step8).toContain("> `claude --continue`");
    expect(step8).toContain('If you switched Node, first say in one line: "If `claude` is not found in the new terminal, reinstall Claude Code with `npm i -g @anthropic-ai/claude-code`, or with its native installer."');
    expect(fix).toContain("until the developer restarts Claude Code (start of step 8)");
    expect(fix).not.toContain("claude --continue");
  });

  it("the default policy is applied only when there is no policy file, and the one restart comes after the Shop link and the policy", () => {
    const prompt = read(PROMPT);
    const step3 = prompt.slice(prompt.indexOf("## Step 3"), prompt.indexOf("## Step 4"));
    expect(step3).toContain("Run `intent policy show`. Only if it says `no policy file at`, apply the default policy");
    expect(codeOf(step3)).toContain("$ intent policy add per-order-20 --yes\n$ intent policy add weekly-40 --yes\n");
    expect(step3).toContain("If a policy file exists, leave it as it is: it is the developer's.");
    // The CLI says this exact line when there is no file (src/cli/policy.ts).
    expect(read("src/cli/policy.ts")).toContain("`no policy file at ${policyPath}: the gateway uses the bundled ${active.bundled} policy`");
    // `intent serve` looks for the Shop wallet once, at start: the one restart comes after the Shop link (step 5) and
    // the advisor (step 6), and before the first find_offers (attack: a restart before the link leaves the gateway without Shop).
    const restart = prompt.indexOf("> **Your turn:** restart Claude Code");
    expect([...prompt.matchAll(/^> \*\*Your turn:\*\* restart Claude Code$/gm)]).toHaveLength(1);
    expect(restart).toBeGreaterThan(prompt.indexOf("intent wallet link shop --finish"));
    expect(restart).toBeGreaterThan(prompt.indexOf("intent wallet status --wait-budget"));
    expect(restart).toBeGreaterThan(prompt.indexOf("## Step 6"));
    expect(restart).toBeGreaterThan(prompt.indexOf("## Step 8"));
    expect(restart).toBeLessThan(prompt.indexOf("Call `find_offers`"));
    expect(prompt).toContain("the gateway reads its policy and looks for the Shop wallet then. One restart now picks up the gateway, the policy, the Shop link");
    // The advisor asks for no restart of its own during the onboarding.
    expect(read(SKILL)).toContain("When the onboarding runs you, say nothing either: its restart before the first purchase picks up any change.");
  });

  it("sends nothing itself: no curl, wget or fetch, and no placeholder as a send target (attack: step markers must not come back)", () => {
    const prompt = read(PROMPT);
    const code = codeOf(prompt);
    // The prompt's only network calls are the package (npx, claude mcp add, npm pack), the Node installers the developer
    // agrees to in step 1, and the gateway's own commands. No command the agent runs posts to a URL.
    expect(code.filter((c) => /\b(curl|wget|fetch|Invoke-WebRequest|nc)\b/.test(c))).toEqual([]);
    expect(code.filter((c) => /https?:\/\//.test(c))).toEqual([]);
    // INTENT_CLOUD_URL appears in code only as the gateway's own setting; the sign-up page is opened by the developer;
    // the invite is named on its own, never inside a command (checked above).
    const placeholdersInCode = code.filter((c) => c !== "{{INTENT_INVITE}}").flatMap((c) => [...c.replaceAll("INTENT_CLOUD_URL={{INTENT_CLOUD_URL}}", "").matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]));
    expect(placeholdersInCode).toEqual([]);
    expect(code.filter((c) => c.includes("INTENT_CLOUD_URL={{INTENT_CLOUD_URL}}")).length).toBeGreaterThan(0);
    expect(prompt).not.toMatch(/step.?marker|opt.?out|MARKER_URL/i);
    // Not in prose either: an agent may run a curl it reads anywhere.
    expect(prompt).not.toMatch(/\b(curl|wget)\b/);
    // What to do when stuck stays, in How to work, before any step.
    const howToWork = prompt.slice(prompt.indexOf("How to work:"), prompt.indexOf("## Step 1"));
    expect(howToWork).toContain(
      "If you get stuck, you can send this conversation to the intent team. It contains your invite link, so don't post it publicly.",
    );
  });

  it("sign-up and passkey is a required step, also for a developer who already has an account, checked by no call", () => {
    const prompt = read(PROMPT);
    const step4 = prompt.slice(prompt.indexOf("## Step 4"), prompt.indexOf("## Step 5"));
    expect(step4).toMatch(/^## Step 4: sign up and create the passkey/);
    expect(step4).toContain("This step is required: never skip it, also when the developer says they already have an account.");
    // The branch is two short lines, never one long sentence.
    expect(step4).toContain("> Sign up with your invited email and create a passkey.\n>\n> Already have an account? Check its account page shows a passkey.\n");
    expect(step4).toContain('No command can see this step, so show this block and wait for "done".');
    expect(step4).toContain("the first purchase's approval (step 8) is where it is really checked.");
    expect(prompt).toMatch(/^## Step 8: the first purchase/m);
    // The agent checks nothing itself: no command in this step, and the developer opens the page.
    expect(codeOf(step4).filter((c) => /\s/.test(c))).toEqual([]);
    expect(step4).toContain("Never open the page or fill it in for them.");
  });

  it("puts what the developer must see, click or type in the reply, and narrates nothing else", () => {
    const prompt = read(PROMPT);
    expect(prompt).toContain(
      "Anything the developer must see, click or type (a link, a code, a choice) goes in your own reply, written out in full, never only in a command's output.",
    );
    expect(prompt).toContain("Do not narrate commands, recap a step or paste command output. Between developer actions, say only the status line:");
    expect(prompt).toContain("The only other thing you may say is a command's error line and the fix it names, and what a step tells you to say.");
    // One status line per finished step: a dogfood run said "✓ 8/9 (part 1)" in the middle of step 8.
    expect(prompt).toContain("once per finished step, and never for a step that is not finished yet.");
    // Every step 1 to 8 its own line: a dogfood agent merged steps 1 and 2 into "3/9" and skipped step 7's line.
    expect(prompt).toContain(
      "Every step from 1 to 8 gets its own line, in order: when several steps finish without the developer in between (steps 1, 2 and 3 usually do), say one line for each, never one line for all.",
    );
    const step7 = prompt.slice(prompt.indexOf("## Step 7"), prompt.indexOf("## Step 8"));
    expect(step7).toMatch(/Shop app\.\n\nRight after them, say step 7's status line, then go on to step 8\.\n\n$/);
    // Nothing the developer was not shown: a dogfood agent invented an account URL and a QR code after a failed passkey.
    expect(prompt).toContain(
      "Never give the developer a step, link, page or button that neither this prompt nor a tool result showed them, and never build a URL yourself.",
    );
    // A new link only while nothing was approved: after approved, handed off or ordered it would invite a second purchase.
    expect(prompt).toContain(
      "If the developer says approving failed (the passkey did not work, the page showed an error), call `get_approval_status` once and say its one line. Only if it says `Waiting for`, rejected or expired, also offer to make a new approval link (`create_cart` again for the same offer). If it answers 404 or does not know the approval, do not call it again, and do not create another cart unless the developer asks for one;",
    );
    // The prompt and the gateway's own next step after a 4xx agree: no duplicate cart without asking.
    expect(read("src/gateway/gateway.ts")).toContain("do not create a new cart for this purchase unless the buyer asks for one");
    expect(read("src/gateway/gateway.ts")).not.toContain("offer a new cart only if they did not approve this one");
    // Identity never goes in the free text, in the prompt and in find_offers' description alike.
    expect(prompt.split("Never put a name, street or full postcode in product or must_haves.").length - 1).toBe(2);
    expect(prompt).not.toMatch(/say its one line, and offer to make a new approval link/);
    const gateway = read("src/gateway/gateway.ts");
    for (const words of ['"The buyer rejected this purchase."', '"This approval expired. Create a new cart to try again."']) expect(gateway).toContain(words);
    // A failed create_cart names its next step, and the total is said before the approval link, for a Cloud cart and
    // for a Shop checkout (the normal path once Shop is linked) alike.
    expect(prompt).toContain(
      "If it fails, say its line, which names what to do next. Otherwise say the total from its `Cart:` or `Shop checkout:` line (`… from <store>, total <total> …`) in one line",
    );
    const tools = read("src/mcp/tools.ts");
    expect(tools).toContain('const TELL = "Tell the buyer this total before the approval link.";');
    expect([...tools.matchAll(/\$\{TELL\}`/g)]).toHaveLength(2);
    // A block ends the reply, and the command that sees the action runs once the developer replies: in five dogfood
    // runs an agent told to show the block and then run --finish (10 minutes) or get_approval_status in the same reply
    // showed nothing before the wait, so the developer never saw the link (attack: no waiting command in the block's reply).
    expect(prompt).toContain('It ends your reply: run nothing after it. It ends with "Reply done", unless the developer answers it with a choice or with "continue".');
    expect(prompt).toContain("2. When the developer replies, run `intent wallet link shop --finish`");
    expect(prompt).toContain("4. When the developer replies to that block (or right away, if you showed none), run `intent wallet status --wait-budget --timeout 540`");
    expect(prompt).toContain("5. When the developer replies, call `get_approval_status`.");
    expect(prompt).not.toMatch(/(Right away|In the same reply)[^.]*(--finish|get_approval_status)/);
    // The opening does not end the turn: the developer would have to nudge the agent to start.
    expect(prompt).not.toContain("this opening, and nothing else");
    // The developer matches the check code the agent shows with the one on the confirm page; create_cart returns it.
    expect(prompt).toContain("> Open the page, check the item, total and check code, then approve with your passkey.\n>\n> <the approval link, as a clickable link>\n>\n> Check code: <the check code>\n");
    expect(read("src/mcp/tools.ts")).toContain("Check code: ${result.check_code}");
    expect(prompt).toContain("> Open this link and approve Personal Agent in Shop; the code is filled in.\n>\n> <the link, as a clickable link>\n>\n> Code: <the code>\n");
    expect(prompt).toContain("When it prints `Agent payments on: …`, say that line, any line it prints that starts `intent: warning: this limit is above` or `Note:` (why it names no amount), and this note");
    expect(prompt).toContain("send only the gateway's normal requests to Shop and Intent Cloud and read what each returns; every request is in the log before it leaves.");
    const shop = prompt.slice(prompt.indexOf("## Step 5"), prompt.indexOf("## Step 6"));
    expect(codeOf(shop).filter((c) => /wallet link shop$/.test(c))).toEqual([]);
    expect(shop).not.toContain("INTENT_SHOP_CLIENT_ID");
  });

  const MARKER = "> **Your turn:** ";

  /** Each **Your turn** block in `markdown`: its label, its lines, and the lines after it up to the next block or heading. */
  function turns(markdown: string): { label: string; block: string[]; after: string[] }[] {
    const lines = markdown.split("\n");
    const out: { label: string; block: string[]; after: string[] }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!(lines[i] ?? "").startsWith("> **Your turn")) continue;
      let j = i;
      while (j < lines.length && (lines[j] ?? "").startsWith(">")) j++;
      let k = j;
      while (k < lines.length && !(lines[k] ?? "").startsWith("> **Your turn") && !/^#{2,3} /.test(lines[k] ?? "")) k++;
      out.push({ label: (lines[i] ?? "").startsWith(MARKER) ? (lines[i] ?? "").slice(MARKER.length) : "", block: lines.slice(i, j), after: lines.slice(j, k) });
    }
    return out;
  }

  /** A line of a block that carries a link, a code or a command, not words: a placeholder, a URL or a code span. */
  const carrier = (line: string): boolean => /^> ((?:[A-Z][a-z ]+: )?<.*>|\{\{[A-Z_]+\}\}|https?:\/\/\S+|`[^`]+`)$/.test(line);

  /** A step that runs a command which sees a developer action by itself. */
  const DETECTS = /(run|call) `(intent wallet link shop --finish|intent wallet status --wait-budget|get_approval_status)/;

  it("every developer action is a labelled **Your turn** block: one action in short lines, no numbering, done only when nothing can see it", () => {
    for (const file of FILES) {
      const blocks = turns(read(file));
      expect(blocks.length, file).toBeGreaterThan(0);
      for (const { label, block, after } of blocks) {
        const text = block.join("\n");
        expect(label, `${file}: marker and label in\n${text}`).toMatch(/^[a-z][A-Za-z ()]+$/);
        // No numbering and no list: a block holds one action (attack: "1. … 2. …" in one block).
        expect(block.filter((l) => /^> *(\d+\.|[-*]) /.test(l)), `${file}: one action, unnumbered, in\n${text}`).toEqual([]);
        // Words come first, then the links or codes; every words line is short.
        const body = block.slice(1).filter((l) => l !== ">" && l !== "> Reply done");
        const words = body.filter((l) => !carrier(l));
        // The action is in words, or (agent payments) is a line the CLI printed, copied word for word.
        expect(words.length > 0 || /^> <.*printed>$/.test(body[0] ?? ""), `${file}: an action in\n${text}`).toBe(true);
        expect(words.length, `${file}: at most two short lines in\n${text}`).toBeLessThanOrEqual(2);
        for (const l of words) expect(l.length, `${file}: short line: ${l}`).toBeLessThanOrEqual(90);
        expect(body.findIndex((l) => carrier(l)) === -1 || body.slice(body.findIndex((l) => carrier(l))).every(carrier), `${file}: links after the words in\n${text}`).toBe(true);
        // Lines are separated, so each shows on its own.
        expect(block.every((l, n) => n === 0 || l === ">" || block[n - 1] === ">"), `${file}: a blank > between lines in\n${text}`).toBe(true);
        const asksDone = block.at(-1) === "> Reply done";
        expect(text.replace(/\n> Reply done$/, ""), `${file}: "Reply done" only as the last line`).not.toMatch(/Reply done/);
        // Nothing after a block while the developer acts: the next line is an instruction or a heading, never prose.
        const next = after.find((l) => l.trim() !== "");
        if (next !== undefined) expect(next, `${file}: prose after\n${text}`).toMatch(/^(\d+\. |#{2,3} )/);
        // Attack: a command that sees the action runs in the block's own reply, before the developer could read the link.
        if (DETECTS.test(after.join("\n"))) {
          expect(asksDone, `${file}: a detected action still ends the reply with done\n${text}`).toBe(true);
          expect(after.find((l) => /^\d+\. /.test(l)), `${file}: the detecting command waits for the reply\n${text}`).toMatch(/^\d+\. When the developer replies/);
        }
      }
    }
    // The developer's actions, in order.
    const prompt = turns(read(PROMPT));
    expect(prompt.map((b) => b.label)).toEqual([
      "sign up and create a passkey",
      "approve the Shop link",
      "turn on agent payments",
      "restart Claude Code",
      "say what to buy",
      "pick an offer",
      "approve with your passkey",
    ]);
    // Each detectable action is followed by the command that detects it, run once the developer replies done.
    const [, link, payments, , , pick, approval] = prompt;
    expect(link?.after.join("\n")).toContain("intent wallet link shop --finish");
    expect(payments?.after.join("\n")).toContain("intent wallet status --wait-budget");
    expect(approval?.after.join("\n")).toContain("get_approval_status");
    for (const b of [link, payments, approval]) expect(b?.block.at(-1)).toBe("> Reply done");
    // The developer picks the offer; create_cart is for that one (src/mcp/tools.ts: "the offer the user picked").
    expect(pick?.after.join("\n")).toContain("Call `create_cart` for the offer they picked, with its `offer_handle`.");
    expect(read(PROMPT)).not.toMatch(/cheapest/);
    expect(read("src/mcp/tools.ts")).toContain("Prepare a cart for the offer the user picked");
    // The sign-up and the three detected actions ask for done; the choices are answered by the reply itself.
    expect([...read(PROMPT).matchAll(/^> Reply done$/gm)]).toHaveLength(4);
  });

  it("the opening names the developer's actions: their number and labels match the **Your turn** blocks", () => {
    const prompt = read(PROMPT);
    const opening = /^> (Setting up intent: .*)$/m.exec(prompt)?.[1] ?? "";
    expect(opening).toMatch(/^Setting up intent: about 10 minutes\. You'll do (\d+) things: (.+)\.$/);
    const [, count = "", list = ""] = /You'll do (\d+) things: (.+)\.$/.exec(opening) ?? [];
    // The prompt's blocks, with the advisor's one look at the rules (step 6) in its place; its restart only follows a change.
    const own = turns(prompt).map((b) => b.label);
    const advisor = turns(read(SKILL)).map((b) => b.label);
    expect(advisor).toEqual(["look at your rules (optional)", "restart Claude Code"]);
    const actions = [...own.slice(0, 3), advisor[0] ?? "", ...own.slice(3)];
    expect(list.split(", ")).toEqual(actions);
    expect(Number(count)).toBe(actions.length);
    // At most three lines, before step 1, and the agent's first reply.
    expect(prompt.indexOf("Your first reply starts with this opening, word for word, and goes straight on with step 1:")).toBeLessThan(prompt.indexOf("## Step 1"));
    expect(opening.length).toBeLessThanOrEqual(3 * 100);
  });

  it("every status line has one form and one mark, and its total is the number of steps", () => {
    const prompt = read(PROMPT);
    const steps = [...prompt.matchAll(/^## Step (\d+):/gm)].length;
    expect(prompt).toContain(`say only the status line: \`✓ <n>/${String(steps)}  <what happened>. Next: <what>.\` Here \`<n>\` is the step just finished and ${String(steps)} is the number of steps.`);
    expect(read(SKILL)).toContain(`(\`✓ <n>/${String(steps)}  <what happened>. Next: <what>.\`)`);
    // One mark: no other check mark or status form anywhere.
    for (const file of FILES) expect([...read(file).matchAll(/[✓✔☑✅]/g)].length, file).toBe(1);
  });

  it("the purchase asks for what find_offers takes: a country, a postcode and a budget, in the gateway's own words", () => {
    const prompt = read(PROMPT);
    const step8 = prompt.slice(prompt.indexOf("## Step 8"), prompt.indexOf("## Step 9"));
    expect(step8).toContain("> Where should it ship? Country and postcode.");
    expect(step8).toContain("with `country` (its two-letter code), `postcode` and `budget` as they gave them");
    expect(step8).not.toMatch(/US addresses only|ZIP/);
    // The country inference lives in one home, find_offers' description; the prompt points there and asks otherwise.
    expect(step8).toContain("If they named no country, `find_offers`' description gives the one case where the postcode and the budget settle it; otherwise ask for it.");
    expect(read("src/mcp/tools.ts")).toContain("Never guess a country, with one exception");
    // What the gateway takes today: the find_offers fields, and the same ask when the ship-to is missing.
    expect(Object.keys(FindOffersInput.shape).sort()).toEqual(["budget", "category", "country", "must_haves", "postcode", "product"]);
    const gateway = read("src/gateway/gateway.ts");
    expect(gateway).toContain('missing.push({ field: "ship_to", ask: "Where should it ship? Country and postcode." });');
  });

  it("polls get_approval_status only while the result says to, and relays any final result as it is", () => {
    const prompt = read(PROMPT);
    const step8 = prompt.slice(prompt.indexOf("## Step 8"), prompt.indexOf("## Step 9"));
    expect(step8).toContain("Call it again, about 5 s later each time, only while its result says `Waiting for` (the approval is pending) or tells you to call `get_approval_status` again.");
    expect(step8).toContain("Any other result is final: relay what it says, in one line, and no more.");
    // The poll is capped: an indeterminate one-tap keeps saying "call again", so after about 3 minutes the agent stops
    // and relays the result's own advice, which the gateway writes.
    expect(step8).toContain(
      'If it still tells you to call again after about 3 minutes (a one-tap purchase whose result Shop has not confirmed), stop calling and relay the result\'s own advice, such as "Check the order in the Shop app", in one line.',
    );
    expect(read("src/gateway/gateway.ts")).toContain("Check the order in the Shop app if it does not resolve.");
    expect(step8).toContain("Never offer a link or a next step the result does not give; if it says to create a new cart, offer that.");
    // Attack: one-tap states are not the only final ones (a hand-off is `approved`; rejected, expired, flagged end too).
    expect(step8).not.toMatch(/until the purchase is settled|`ordered`, `failed` or `mismatch`/);
    // The wording the gateway uses for "call again".
    const gateway = read("src/gateway/gateway.ts");
    expect(gateway).toContain('"Waiting for the buyer to approve with their passkey."');
    expect(gateway).toContain("`Waiting for the user to click");
    expect(gateway).toContain('"Call get_approval_status again until it says ordered, failed or mismatch."');
    expect(gateway).toContain('"The buyer pays at the merchant checkout."');
    expect(gateway).toContain("Create a new cart to hand the purchase off to the merchant's checkout.");
  });

  it("ends with one card from the text the tools return: ordered only when the result says so, then intent log and intent pause", () => {
    const prompt = read(PROMPT);
    const end = prompt.slice(prompt.indexOf("Setup is done."));
    // The developer runs no intent command themselves (it is an npx line); the agent does, when asked.
    expect(end).toMatch(/> \*\*Done:\*\* <outcome>, from <store>, total <total>\n>\n> Ask me any time to run `intent log` \(what the gateway sent\) or `intent pause`\.\n>\n> `intent pause` stops every purchase that goes through intent and isn't paid yet\. For a hard stop, also turn off agent payments in the Shop app\.\n$/);
    // The Pause line is ADR-0023's honest line, as `intent pause` prints it (its first sentence), word for word.
    const honest = /export const HONEST_LINE = "([^"]*)"/.exec(read("src/cli/pause.ts"))?.[1] ?? "";
    expect(honest.startsWith("`intent pause` stops every purchase that goes through intent and isn't paid yet. ")).toBe(true);
    expect(end).toContain(`> ${honest}\n`);
    expect(end).not.toContain("not yet approved");
    // Invariant 5: ordered (and an order number) only from the result; a hand-off is a hand-off; anything else is not completed.
    expect(end).toContain("`ordered`, with `order <number>` only when the `get_approval_status` result names one (`One-tap: ordered …, order <number>`, or \"placed the order (order <number>)\")");
    expect(end).toContain("\"handed off to Shop's checkout\" when the result says the buyer pays at the checkout or was handed off");
    expect(end).toContain("otherwise \"not completed\" and the reason the result gives. Never say paid or ordered unless the result says ordered.");
    expect(end).toContain("the store and total: from the `create_cart` result's line `… from <store>, total <total> …`.");
    // The text the tools render (src/mcp/tools.ts, src/gateway/gateway.ts), which is what the agent reads.
    const tools = read("src/mcp/tools.ts");
    expect(tools).toContain("[`One-tap: ${c.state}");
    expect(tools).toContain('${c.order_ref === undefined ? "" : `, order ${c.order_ref}`}');
    expect(tools).toContain("`Shop checkout: ${String(checkout.quantity)} × ${checkout.title} from ${checkout.store}, total ${minorText(checkout.totals.total, checkout.currency)} `");
    expect(tools).toContain("from ${cart.merchant.name}, total ${totalText(cart.total, cart.total_kind)}`");
    expect(read("src/gateway/gateway.ts")).toContain('placed the order${order === undefined ? "" : ` (order ${order})`}');
    // A Shop offer shows a price and no total, so the offer list shows the price.
    expect(tools).toContain("shipping shown at checkout, in stock.");
    expect(prompt).toContain("item, store and price, as the result writes them (a Shop offer shows no total: shipping is shown at checkout)");
  });

  it("covers the three outcomes of --finish and --wait-budget with the CLI's own lines", () => {
    const prompt = read(PROMPT);
    const step5 = prompt.slice(prompt.indexOf("## Step 5"), prompt.indexOf("## Step 6"));
    const wallet = read("src/cli/wallet.ts");
    // --start: one line; the agent shows its link and code, ends its reply, and runs --finish once the developer replies.
    expect(step5).toContain("`Open <link> and approve the code <CODE> in Shop before <time>, then run <the --finish command>`, and exits; the command it names is the one you ran, with `--finish`.");
    expect(wallet).toContain("`Open ${page} and approve the code ${prompt.userCode} in ${name} before ${isoSeconds(started.expiresAt)}, then run ${INTENT} wallet link ${rail} --finish`");
    expect(step5).toContain("If it stops early, run `intent wallet link shop --finish` again. If the code expired, go back to 1 once; if it expires again, ask the developer whether to try again.");
    // 1. Already on: the block is skipped.
    expect(step5).toContain("- `Agent payments on: …` (they are already on): skip the block below");
    expect(wallet).toContain("`Agent payments on: ${moneyText(limit.amount)}${per}, ${moneyText(account.budgetRemaining)} left`");
    // 2. Off: the Shop page, then what to tap.
    expect(step5).toContain("- Agent payments are off: a Shop page, then `Tap …, turn on Allow agent to pay for me, enter <amount>.`, with the amount it prints");
    expect(wallet).toContain("`Tap ${connection}, turn on Allow agent to pay for me, enter ${capText(advice.maxMinor, advice.currency)}.`");
    // 3. On but low: the Shop page, then raise it; --wait-budget may print the same lines when it starts.
    expect(step5).toContain("- Agent payments are on but too little is left for one purchase: a Shop page, then `Agent payments are on, but only <left> is left; raise it to <amount>.`");
    expect(wallet).toContain("`Agent payments are on, but only ${leftText(account.budgetRemaining)} is left; raise it to ${max}.`");
    expect(step5).toContain("`intent wallet status --wait-budget` can print the same low lines when it starts; show them the same way");
    // 4. On, limit already high enough, budget spent this period: nothing to raise, so a status line, not a Your turn block.
    expect(step5).toContain(
      "- Agent payments are on and the limit is high enough, but this period's amount is spent: one line that starts `Agent payments are on, but only <left> is left until Shop renews it` and ends `so wait for that renewal rather than raising it.`",
    );
    expect(step5).toContain("say that line as a one-line status, not a **Your turn** block, and add in one line that until Shop renews it, purchases are handed off to Shop's checkout page. Then skip 4 and go to step 6.");
    expect(wallet).toContain("`Agent payments are on, but only ${leftText(account.budgetRemaining)} is left ${until}; the limit is already at least the suggested ${max}, so wait for that renewal rather than raising it.`");
    expect(wallet).toContain("return `until Shop renews it at ${limit.renewsAt}`;");
    expect(step5).toContain("For the last two, show the last two lines `--finish` printed, word for word, and nothing else");
    // --wait-budget: success, too high, timeout.
    expect(step5).toContain("When it prints `Agent payments on: …`, say that line");
    expect(step5).toContain("any line it prints that starts `intent: warning: this limit is above`");
    expect(wallet).toContain("`intent: warning: this limit is above ${moneyText({ amountMinor: advice.maxMinor, currency })}");
    expect(step5).toContain("If it prints a line that starts `intent: no Shop agent payments seen after` or `intent: Shop agent payments are still low after`, say that line");
    expect(wallet).toContain("`intent: no ${name} agent payments seen after ${String(timeoutS)} s");
    expect(wallet).toContain("`intent: ${name} agent payments are still low after ${String(timeoutS)} s");
    // No amount to suggest (a currency the table lacks, or no ceilings read): the success line plus a Note line.
    expect(step5).toContain("or `Note:` (why it names no amount)");
    expect(wallet).toContain("line(io.stdout, printable(`Note: ${advice}`));");
    // The ceilings not read: --finish and --wait-budget both exit 1 with the one try-again line.
    expect(step5).toContain("prints a line that starts `intent: the ceilings Intent Cloud returns could not be read`, it exits 1");
    expect(wallet).toContain("`the ceilings Intent Cloud returns could not be read from ${host} (${why}), so the amount left was not checked; try again`");
    expect(step5).not.toContain("INTENT_SHOP_CLIENT_ID");
  });

  it("agent payments: Shop's permission to pay at all, the lines from --finish word for word, the note only after it is seen", () => {
    const prompt = read(PROMPT);
    const step5 = prompt.slice(prompt.indexOf("## Step 5"), prompt.indexOf("## Step 6"));
    expect(step5).toContain("Agent payments are Shop's permission for the agent to pay at all: without them no purchase completes in one tap, and every order goes to Shop's checkout page");
    expect(step5).toContain("For the last two, show the last two lines `--finish` printed, word for word, and nothing else");
    expect(step5).toContain("> <the last line `--finish` printed>");
    expect(step5).toContain("> <the line before it, the Shop page, as a clickable link>");
    // The Bash tool stops a command at 10 minutes: --wait-budget gets 540 s, so its own timeout line is printed.
    const runs = [...step5.matchAll(/run `([^`]*--wait-budget[^`]*)`/g)].map((m) => m[1]);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.filter((c) => c !== "intent wallet status --wait-budget --timeout 540")).toEqual([]);
    expect(step5).toContain("with a 10-minute timeout for the command");
    // The safety-net note comes once the budget is seen, not while the developer acts.
    const note = step5.indexOf("Shop says it enforces this amount itself, as a safety net; intent's policy does the day-to-day limiting.");
    expect(note).toBeGreaterThan(step5.indexOf("intent wallet status --wait-budget"));
    expect(step5).toContain("It is the only stop an agent with shell access can't get around");
    // Invariant 5: what Shop says, not what it does; the page, the label, the amount and its period come from the CLI.
    expect(step5).not.toMatch(/Shop enforces/);
    // No page, amount or period of the prompt's own: those come from the CLI, quoted only as its output patterns.
    expect(step5).not.toMatch(/https?:\/\/|\$\d|month/);
    expect(step5.split("\n").filter((l) => l.includes("Allow agent to pay")).every((l) => l.includes("`Tap …, turn on Allow agent to pay for me, enter <amount>.`"))).toBe(true);
    // No amount to choose; "budget" appears only in the flag (--wait-budget).
    expect(step5).not.toMatch(/[Ss]uggest|(?<!-)\bbudget\b/);
    const skill = read(SKILL);
    expect(skill).toContain("When the onboarding has already set it, do not ask about it again; discuss another amount only if the developer asks.");
    expect(skill).toContain("Shop says it enforces it itself");
    expect(skill).not.toMatch(/Shop enforces|"OK\?"|[Ss]uggest a budget|set the budget with/);
  });

  it("the advisor never re-applies the defaults to the developer's file, shows each change as a diff first, and loosens honestly", () => {
    const skill = read(SKILL);
    const code = codeOf(skill);
    const read1 = skill.slice(skill.indexOf("## 1. Read the policy"), skill.indexOf("## 2."));
    // The defaults only when there is no file.
    expect(read1).toContain("If it says `no policy file at`, there is no policy yet");
    expect(code).toContain("$ intent policy add per-order-20 --yes\n$ intent policy add weekly-40 --yes\n");
    expect(read1).toContain("Otherwise the policy file is the developer's: never apply the defaults again, with or without `--yes`.");
    // Attack: no `--yes` outside that no-file case, unless the same command without `--yes` (the diff) comes first.
    const changes = skill.slice(skill.indexOf("## 3."), skill.indexOf("## 4."));
    for (const m of changes.matchAll(/`intent policy add (\S+) --yes`/g)) {
      expect(changes.indexOf(`\`intent policy add ${m[1] ?? ""}\``), m[0]).toBeGreaterThanOrEqual(0);
      expect(changes.indexOf(`\`intent policy add ${m[1] ?? ""}\``), m[0]).toBeLessThan(m.index);
    }
    // Without --yes and with no terminal, policy add exits 2 with this line: the expected preview, not an error.
    expect(skill).toContain("exits 2 with `not applied: stdin is not a terminal, so no one can confirm the change; re-run with --yes to apply it`. That exit and that line are the expected preview, not an error.");
    expect(read("src/cli/policy.ts")).toContain('"not applied: stdin is not a terminal, so no one can confirm the change; re-run with --yes to apply it", 2');
    // Loosening: the file and lock go, then only the wanted limits come back. No claim that a limit "stays".
    expect(changes).toContain("### Loosen a limit");
    expect(changes).toContain("Remove the policy file and its lock");
    expect(changes).toContain("ask before you remove anything");
    expect(skill).not.toMatch(/a limit already applied stays|can only narrow, so/);
    // The panel shows the rules; changes go through the agent (the panel's one write is Pause).
    expect(skill).toContain("Start `intent panel` in the background");
    // Started as the agent's own background task and stopped by it: a dogfood agent ran it with `&` into /tmp/panel.log
    // and left it running, unsaid.
    expect(skill).toContain("with your shell tool's own background option (`run_in_background` in Claude Code), not with `&`, `nohup` or a log file");
    expect(skill).toContain("When the developer answers the block below, stop that background task, and say in your next status line that the panel is stopped.");
    expect(skill).not.toMatch(/> ?\/tmp\/|\/tmp\/panel/);
    expect(skill).toContain("> **Your turn:** look at your rules (optional)\n>\n> Here are your rules. Keep them, or tell me what to change.\n");
    expect(skill).toContain("> http://127.0.0.1:<port>/#/policy");
    expect(skill).toContain("The panel shows your rules; changes go through you");
    expect(skill).not.toMatch(/read-only|only shows the policy/);
    // A restart only if the policy changed.
    expect(skill).toContain("Otherwise, if you applied, changed or removed anything in this skill, show:");
    expect(skill).toContain("If nothing changed, say nothing about a restart.");
  });

  it("the steps are numbered 1 to 9 in order, and every step it points to exists", () => {
    const prompt = read(PROMPT);
    const numbers = [...prompt.matchAll(/^## Step (\d+):/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const m of prompt.matchAll(/\bstep (\d+)\b/g)) expect(numbers, m[0]).toContain(Number(m[1]));
  });

  it("the prompt says the Pause lines exactly, and fills hosts only through the three placeholders", () => {
    const prompt = read(PROMPT);
    expect(prompt).toContain(
      "intent pause stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off agent payments in the Shop app.",
    );
    // Exactly the three the platform fills in per invite, and no other {{…}}.
    const placeholders = new Set([...prompt.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]));
    expect(placeholders).toEqual(new Set(["{{INTENT_INVITE}}", "{{INTENT_CLOUD_URL}}", "{{INTENT_SIGNUP_URL}}"]));
    // pause and resume ship (COMMANDS): no hedge that they might not.
    expect(Object.hasOwn(COMMANDS, "pause") && Object.hasOwn(COMMANDS, "resume")).toBe(true);
    expect(prompt).not.toMatch(/does not list `pause` yet|planned commands/);
    expect(read(SKILL)).not.toMatch(/\{\{/);
    // The only URLs written out are public pages; every Intent Cloud address is a placeholder.
    const urls = [...prompt.matchAll(/https?:\/\/[^\s)`",]+/g)].map((m) => m[0]);
    expect(new Set(urls)).toEqual(new Set(["https://nodejs.org"]));
  });

  it("the skill says Shop agent payments are the only stop an agent with a shell cannot get around, and why", () => {
    const skill = read(SKILL);
    expect(skill).toMatch(/the only stop an agent with shell access cannot get around/);
    expect(skill).toMatch(/can read it and pay Shop directly/);
  });

  it("is shipped in the package", () => {
    expect(pkg.files).toContain("onboarding");
  });

  // Every combination of the advisor's choices: the cases it runs must pass against the policy it wrote.
  const CHOICES = ["per-order-20", "weekly-40", "handoff-only"] as const;
  const subsets = Array.from({ length: 2 ** CHOICES.length }, (_, mask) => CHOICES.filter((_, i) => (mask >> i) & 1));
  it.each(subsets.map((s) => [s.join(" + ") || "no policy added", s] as const))("the skill's cases pass with %s", (_label, chosen) => {
    const policy = chosen.reduce<Policy>((p, name) => meet(p, loadPolicy(read(`policies/${name}/policy.yaml`))), loadPolicy(read("policies/zip-only/policy.yaml")));
    for (const cases of ["base", ...chosen]) {
      const results = runCases(policy, read(`onboarding/skills/policy-advisor/cases/${cases}.yaml`));
      expect(results.length, cases).toBeGreaterThan(0);
      expect(results.filter((r) => !r.pass).map((r) => r.name), cases).toEqual([]);
    }
  });
});
