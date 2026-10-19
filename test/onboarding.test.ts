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
import { SUPPORTED_NODE } from "../src/runtime/index.ts";

const repo = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string; files: string[]; engines: { node: string } };

const PROMPT = "onboarding/claude-code.md";
const SKILL = "onboarding/skills/policy-advisor/SKILL.md";
const FILES = [PROMPT, SKILL];

/** Commands the prompt names before they ship (G8: Pause). Any other unknown command fails the test. */
const PLANNED: ReadonlySet<string> = new Set(["pause", "resume"]);

/** Options the prompt names before they ship: `wallet link shop --start` and `--finish` come from the Shop link
 * start/finish change, which merges first. Once the CLI has one, the test below fails until it is removed here. */
const PLANNED_OPTIONS: ReadonlySet<string> = new Set(["wallet link --start", "wallet link --finish"]);

/** The Intent Cloud preview ceiling, in US dollars: per order and per rolling 7 days. A Shop budget is ≤ 4 weeks. */
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

/** Why `words` is not a command the CLI takes, or null when it is. */
export function problem(words: readonly string[]): string | null {
  const positionals = words.filter((w) => !w.startsWith("-"));
  const [first, second] = positionals;
  if (first === undefined) return words.every((w) => w === "--version" || w === "--help") ? null : checkFlags("serve", words);
  if (GROUPS.has(first)) {
    // "the `intent policy` commands" names the group, which exists.
    if (second === undefined) return null;
    const command = `${first} ${second}`;
    return Object.hasOwn(COMMANDS, command) ? checkFlags(command, words) : `unknown command "${command}"`;
  }
  return Object.hasOwn(COMMANDS, first) ? checkFlags(first, words) : `unknown command "${first}"`;
}

function checkFlags(command: string, words: readonly string[]): string | null {
  const options = { ...COMMON, ...COMMANDS[command] };
  for (const word of words.filter((w) => w.startsWith("-"))) {
    if (word === "--version" || word === "--help") continue;
    const known = word.startsWith("--")
      ? Object.hasOwn(options, word.slice(2).split("=")[0] ?? "")
      : Object.values(options).some((o) => o.short === word.slice(1));
    if (!known) return `unknown option ${word} for ${command}`;
  }
  return null;
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
    const unknown = named.map(({ file, words }) => ({ file, words, why: problem(words) })).filter((n) => n.why !== null);
    const notPlanned = unknown.filter(
      (n) => !(n.words.length === 1 && PLANNED.has(n.words[0] ?? "")) && !PLANNED_OPTIONS.has((n.why ?? "").replace(/^unknown option (\S+) for (.+)$/, "$2 $1")),
    );
    expect(notPlanned.map((n) => `${n.file}: intent ${n.words.join(" ")}: ${n.why ?? ""}`)).toEqual([]);
  });

  it("lists as planned only options the CLI does not have yet", () => {
    const shipped = [...PLANNED_OPTIONS].filter((p) => {
      const [group = "", command = "", option = ""] = p.split(" ");
      return Object.hasOwn(COMMANDS[`${group} ${command}`] ?? {}, option.replace(/^--/, ""));
    });
    expect(shipped, "the option has shipped: remove it from PLANNED_OPTIONS").toEqual([]);
    expect(problem(["wallet", "link", "shop", "--start"])).toBe("unknown option --start for wallet link");
  });

  it("uses the commands the onboarding needs", () => {
    const lines = named.map(({ words }) => words.join(" "));
    for (const command of ["--version", "init", "wallet link shop --start", "wallet link shop --finish", "wallet status", "policy add per-order-20 --yes", "policy add weekly-40 --yes", "policy add handoff-only --yes", "policy show", "log", "verify"]) {
      expect(lines, command).toContain(command);
    }
    expect(lines.some((l) => l.startsWith("policy test "))).toBe(true);
    expect(lines.some((l) => l.includes("--invite"))).toBe(false);
    // The invite token belongs to the try link: no command line carries it.
    expect(codeOf(read(PROMPT)).filter((c) => c.includes("{{INTENT_INVITE}}") && /\s/.test(c))).toEqual([]);
  });

  it("every library policy the skill adds stays within the ceiling", () => {
    const added = named.filter(({ words }) => words[0] === "policy" && words[1] === "add").map(({ words }) => words[2] ?? "")
      .filter((name) => name !== "");
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
          // Only a Shop budget (four weeks) may go above the weekly ceiling.
          if (amount > CEILING.perWeek) expect(line, `${file}: $${String(amount)} outside a budget line`).toMatch(/budget/i);
        }
      }
    }
  });

  it("names exactly the package.json version", () => {
    for (const file of FILES) {
      // The Node range is checked on its own below; any other version is the package's.
      const versions = [...read(file).split(SUPPORTED_NODE).join("").matchAll(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.\d+)*)?/g)].map((m) => m[0]);
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
    // Every Node release the prompt names is a line SUPPORTED_NODE names, or the odd one it refuses (25).
    const majors = new Set([...prompt.matchAll(/\bNode (\d+)/g)].map((m) => m[1]));
    expect([...majors].filter((m) => !["22", "24", "25", "26"].includes(m ?? ""))).toEqual([]);
  });

  it("gives a fix path for an unsupported Node, not a stop: nvm, fnm, Homebrew or nodejs.org, asked first, then a restart", () => {
    const prompt = read(PROMPT);
    const fix = prompt.slice(prompt.indexOf("### Get a supported Node"), prompt.indexOf("## Step 2"));
    // nvm is a shell function: found by its script, not by `command -v nvm`.
    expect(codeOf(fix)).toContain('test -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh"');
    expect(codeOf(fix)).toContain("command -v fnm");
    expect(codeOf(fix)).toContain("command -v brew");
    expect(codeOf(fix)).toContain('. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install 24 && nvm alias default 24');
    expect(codeOf(fix)).toContain("fnm install 24 && fnm default 24");
    expect(codeOf(fix)).toContain("brew install node@24");
    // node@24 is keg-only; brew --prefix gives /opt/homebrew on Apple Silicon and /usr/local on Intel.
    expect(fix).toContain("$(brew --prefix node@24)/bin");
    expect(fix).not.toMatch(/\/opt\/homebrew|\/usr\/local/);
    expect(fix).toContain("https://nodejs.org");
    expect(fix).toMatch(/ask before you install anything/);
    expect(fix).toContain("claude --continue");
    expect(fix).toMatch(/continue at step 1/);
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
    expect(step4).toContain("create their passkey (this step is required)");
    expect(step4).toContain("If the developer says they already have an account, do not skip this step");
    expect(step4).toMatch(/check there that their account has a passkey, create one if it has none, and say "done"\. Wait for "done" either way\./);
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
    expect(prompt).toContain("Put {{INTENT_SIGNUP_URL}} in your reply as a clickable link");
    expect(prompt).toContain("In your reply, put the link as a clickable link and the code on its own line");
    expect(prompt).toContain('"the code is already filled in if you use this link"');
    expect(prompt).toContain("If it expired, go back to 2 and start again.");
    expect(prompt).toContain("Put the approval link in your reply as a clickable link.");
    expect(prompt).toContain("go through it with the developer, in your reply");
    // The Shop link is started and finished in two commands, with "done" between them, never one long wait.
    const shop = prompt.slice(prompt.indexOf("## Step 5"), prompt.indexOf("## Step 6"));
    expect(shop.indexOf("wallet link shop --start")).toBeLessThan(shop.indexOf('Wait for "done"'));
    expect(shop.indexOf('Wait for "done"')).toBeLessThan(shop.indexOf("wallet link shop --finish"));
    expect(codeOf(shop).filter((c) => /wallet link shop$/.test(c))).toEqual([]);
    expect(shop).not.toContain("INTENT_SHOP_CLIENT_ID");
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
    expect(read(SKILL)).not.toMatch(/\{\{/);
    // The only URLs written out are public pages; every Intent Cloud address is a placeholder.
    const urls = [...prompt.matchAll(/https?:\/\/[^\s)`",]+/g)].map((m) => m[0]);
    expect(new Set(urls)).toEqual(new Set(["https://nodejs.org", "https://shop.app"]));
  });

  it("the skill says the Shop budget is the only hard stop, and why", () => {
    const skill = read(SKILL);
    expect(skill).toMatch(/only hard stop/);
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
