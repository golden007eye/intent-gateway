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
import { SUPPORTED_NODE, nodeSupported } from "../src/runtime/index.ts";

const repo = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string; files: string[]; engines: { node: string } };

const PROMPT = "onboarding/claude-code.md";
const SKILL = "onboarding/skills/policy-advisor/SKILL.md";
const FILES = [PROMPT, SKILL];

/** Options the prompt names before they ship, as `<command> <option>`: `wallet link shop --start`/`--finish` and
 * `wallet status --wait-budget` come from the Shop link start/finish change, which merges first. Once the CLI has one,
 * a test below fails until it is removed here. Any other unknown command or option fails the test. */
const PLANNED_OPTIONS: ReadonlySet<string> = new Set(["wallet link --start", "wallet link --finish", "wallet status --wait-budget"]);

/** What to change when PLANNED_OPTIONS empties at rebase onto the Shop link start/finish change. */
const AT_REBASE = [
  "remove the shipped options from PLANNED_OPTIONS",
  'replace the placeholder "Budget seen" line and the too-high warning in the prompt (step 5.4) and in the test "puts what the developer must see…" with the lines `wallet status --wait-budget` prints',
  'check that `wallet link shop --finish` prints the two agent-payments lines (Shop page, then "Tap …") or the already-on line, as step 5.3 and the test "agent payments: …" assume',
];

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

/** Whether `reason` is an option on PLANNED_OPTIONS. */
const planned = (reason: string): boolean => PLANNED_OPTIONS.has(reason.replace(/^unknown option (\S+) for (.+)$/, "$2 $1"));

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

  it("reports every unknown option, and a wallet link without its rail (attack: a typo behind a planned option)", () => {
    expect(problems(["wallet", "link", "shop", "--start", "--yse"])).toEqual(["unknown option --start for wallet link", "unknown option --yse for wallet link"]);
    expect(problems(["wallet", "link", "shop", "--start", "--yse"]).filter((r) => !planned(r))).toEqual(["unknown option --yse for wallet link"]);
    expect(problems(["wallet", "link", "--finish"])).toEqual(["wallet link needs its rail, shop", "unknown option --finish for wallet link"]);
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
    const bad = named.flatMap(({ file, words }) => problems(words).filter((reason) => !planned(reason)).map((reason) => `${file}: intent ${words.join(" ")}: ${reason}`));
    expect(bad).toEqual([]);
    // Every `wallet link` keeps its rail.
    expect(named.filter(({ words }) => words[0] === "wallet" && words[1] === "link" && words[2] !== "shop")).toEqual([]);
  });

  it("lists as planned only options the CLI does not have yet", () => {
    const shipped = [...PLANNED_OPTIONS].filter((p) => {
      const [group = "", command = "", option = ""] = p.split(" ");
      return Object.hasOwn(COMMANDS[`${group} ${command}`] ?? {}, option.replace(/^--/, ""));
    });
    expect(shipped, `the option has shipped; at rebase:\n- ${AT_REBASE.join("\n- ")}`).toEqual([]);
    expect(problem(["wallet", "link", "shop", "--start"])).toBe("unknown option --start for wallet link");
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
    // The one restart is in step 3, after `claude mcp add`, and says how to get `claude` back on the new Node.
    const step3 = prompt.slice(prompt.indexOf("## Step 3"), prompt.indexOf("## Step 4"));
    expect(prompt.indexOf("claude mcp add intent")).toBeLessThan(prompt.indexOf("## Step 3"));
    expect(step3).toContain("> `claude --continue`");
    expect(step3).toContain("If `claude` is not found there, reinstall Claude Code with `npm i -g @anthropic-ai/claude-code`, or with its native installer.");
    expect(fix).not.toContain("claude --continue");
  });

  it("the default policy is applied only when there is no policy file, before the one restart, so it is in force at the first purchase", () => {
    const prompt = read(PROMPT);
    const step3 = prompt.slice(prompt.indexOf("## Step 3"), prompt.indexOf("## Step 4"));
    expect(step3).toContain("Run `intent policy show`. Only if it says `no policy file at`, apply the default policy");
    expect(codeOf(step3)).toContain("$ intent policy add per-order-20 --yes\n$ intent policy add weekly-40 --yes\n");
    expect(step3).toContain("If a policy file exists, leave it as it is: it is the developer's.");
    // Applied before the restart block, and the restart is the last developer action before any purchase.
    expect(step3.indexOf("policy add weekly-40 --yes")).toBeLessThan(step3.indexOf("> **Your turn**"));
    // The CLI says this exact line when there is no file (src/cli/policy.ts).
    expect(read("src/cli/policy.ts")).toContain("`no policy file at ${policyPath}: the gateway uses the bundled ${active.bundled} policy`");
    // No restart in the purchase step: the policy is already in force.
    const step8 = prompt.slice(prompt.indexOf("## Step 8"), prompt.indexOf("## Step 9"));
    expect(step8).not.toContain("claude --continue");
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
    expect(prompt).not.toMatch(/marker|opt.?out/i);
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
    expect(step4).toContain("create your passkey. If you already have an account, check on its account page that it has a passkey, and create one if it has none.");
    expect(step4).toContain('Wait for "done": no command can see this step.');
    expect(step4).toContain("The first purchase's approval (step 8) is where the passkey is really checked.");
    expect(prompt).toMatch(/^## Step 8: the first purchase/m);
    // The agent checks nothing itself: no command in this step, and the developer opens the page.
    expect(codeOf(step4).filter((c) => /\s/.test(c))).toEqual([]);
    expect(step4).toContain("Never open the page or fill it in for them.");
  });

  it("puts what the developer must see, click or type in the reply, not only in command output", () => {
    const prompt = read(PROMPT);
    expect(prompt).toContain(
      "Anything the developer must see, click or type (a link, a code, a choice) goes in your own reply, written out in full, never only in a command's output.",
    );
    expect(prompt).toContain("The code is already filled in if you use this link.");
    expect(prompt).toContain("If it expired, go back to 1 and start again.");
    expect(prompt).toContain("go through it with the developer, in your reply");
    expect(prompt).toContain("Put its last line in your reply.");
    expect(prompt).toContain('Show its "Budget seen" line in your reply, and any warning it prints that the amount is too high.');
    expect(prompt).toContain("send only the gateway's normal requests to Shop and Intent Cloud and read what each returns; every request is in the log before it leaves.");
    const shop = prompt.slice(prompt.indexOf("## Step 5"), prompt.indexOf("## Step 6"));
    expect(codeOf(shop).filter((c) => /wallet link shop$/.test(c))).toEqual([]);
    expect(shop).not.toContain("INTENT_SHOP_CLIENT_ID");
  });

  /** Each **Your turn** block in `markdown`: its lines, and the text after it up to the next block or step. */
  function turns(markdown: string): { block: string[]; after: string }[] {
    const lines = markdown.split("\n");
    const out: { block: string[]; after: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== "> **Your turn**") continue;
      let j = i;
      while (j < lines.length && (lines[j] ?? "").startsWith(">")) j++;
      let k = j;
      while (k < lines.length && lines[k] !== "> **Your turn**" && !/^#{2,3} /.test(lines[k] ?? "")) k++;
      out.push({ block: lines.slice(i, j), after: lines.slice(j, k).join("\n") });
    }
    return out;
  }

  /** The commands that see a developer action by themselves. */
  const DETECTS = /--finish|--wait-budget|get_approval_status/;

  it("every developer action is a **Your turn** block with one numbered action, and asks for done only when nothing can see it", () => {
    for (const file of FILES) {
      const blocks = turns(read(file));
      expect(blocks.length, file).toBeGreaterThan(0);
      for (const { block, after } of blocks) {
        const text = block.join("\n");
        expect(block.filter((l) => /^> *\d+\. /.test(l)), `${file}: one action in\n${text}`).toHaveLength(1);
        expect(block.filter((l) => /^> *[-*] /.test(l)), `${file}: no list beside the action in\n${text}`).toEqual([]);
        const asksDone = block.at(-1) === "> Reply done";
        expect(text.replace(/\n> Reply done$/, ""), `${file}: "Reply done" only as the last line`).not.toMatch(/Reply done/);
        // Attack: a block that asks for "done" while a command right after it would see the action.
        if (asksDone) expect(after, `${file}: asks for done though a command detects it\n${text}`).not.toMatch(DETECTS);
      }
    }
    // The developer's actions, in order: the one restart (after `claude mcp add` and the default policy), sign-up,
    // the Shop link, agent payments, what to buy, which offer, the approval.
    const prompt = turns(read(PROMPT));
    expect(prompt.map(({ block }) => block.find((l) => /^> 1\. /.test(l))?.slice(5).split(/[.:,]/)[0])).toEqual([
      "Quit Claude Code",
      "Open this page in your own browser",
      "Open this link and approve intent in Shop",
      "<the second line `--finish` printed>",
      "Tell me one small thing you would like to buy",
      "Pick one",
      "Open the approval page",
    ]);
    // Each detectable action is followed by the command that detects it, and asks for no done.
    const [, , link, payments, , pick, approval] = prompt;
    expect(link?.after).toContain("intent wallet link shop --finish");
    expect(payments?.after).toContain("intent wallet status --wait-budget");
    expect(approval?.after).toContain("get_approval_status");
    for (const t of [link, payments, approval]) expect(t?.block.at(-1)).not.toBe("> Reply done");
    // The developer picks the offer; create_cart is for that one (src/mcp/tools.ts: "the offer the user picked").
    expect(pick?.after).toContain("Call `create_cart` for the offer they picked, with its `offer_handle`.");
    expect(read(PROMPT)).not.toMatch(/cheapest/);
    expect(read("src/mcp/tools.ts")).toContain("Prepare a cart for the offer the user picked");
    // Only the sign-up asks for done in the whole prompt.
    expect([...read(PROMPT).matchAll(/^> Reply done$/gm)]).toHaveLength(1);
  });

  it("agent payments: Shop's permission to pay at all, the lines from --finish word for word, Shop says it enforces it", () => {
    const prompt = read(PROMPT);
    const step5 = prompt.slice(prompt.indexOf("## Step 5"), prompt.indexOf("## Step 6"));
    expect(step5).toContain("This is Shop's permission for the agent to pay at all: without it no purchase completes in one tap, and every order goes to Shop's checkout page");
    expect(step5).toContain("`--finish` prints either a line that says agent payments are already on (then skip this block) or two lines");
    expect(step5).toContain("Show those two lines, word for word, and nothing else:");
    expect(step5).toContain("> 1. <the second line `--finish` printed>");
    expect(step5).toContain("> <the first line `--finish` printed, as a clickable link>");
    // Invariant 5: what Shop says, not what it does; the page, the label, the amount and its period come from the CLI.
    expect(step5).toContain("Shop says it enforces this amount itself, as a safety net, while intent's policy does the day-to-day limiting.");
    expect(step5).not.toMatch(/Shop enforces/);
    expect(step5).not.toMatch(/https?:\/\/|\$\d|month|Allow agent to pay/);
    expect(step5).toContain("it is the only stop an agent with shell access cannot get around");
    // No amount to choose; "budget" appears only in the flag and the line the gateway prints (--wait-budget, "Budget seen").
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
    expect(skill).toContain("Run `intent policy add <name>` without `--yes`: with no terminal it prints the change as a diff and writes nothing.");
    // Loosening: the file and lock go, then only the wanted limits come back. No claim that a limit "stays".
    expect(changes).toContain("### Loosen a limit");
    expect(changes).toContain("Remove the policy file and its lock");
    expect(changes).toContain("ask before you remove anything");
    expect(skill).not.toMatch(/a limit already applied stays|can only narrow, so/);
    // The panel shows the rules; changes go through the agent (the panel's one write is Pause).
    expect(skill).toContain("Start `intent panel` in the background");
    expect(skill).toContain("> 1. Here are your rules. Keep them, or tell me what to change. Looking is optional.");
    expect(skill).toContain("> http://127.0.0.1:<port>/#/policy");
    expect(skill).toContain("The panel shows your rules; changes go through you");
    expect(skill).not.toMatch(/read-only|only shows the policy/);
    // A restart only if the policy changed.
    expect(skill).toContain("If you applied, changed or removed anything in this skill, show:");
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
      "intent pause stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off the budget in the Shop app.",
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
