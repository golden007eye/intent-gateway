// `pnpm release`: takes a release from an up-to-date main to the one human gate (docs/release.md, ADR-0010). It
// checks main, picks the version, bumps it by pull request when needed, pushes the signed tag v<version> and watches
// the release workflow. The maintainer's Approve on the GitHub `release` environment is the only human step; the
// workflow publishes nothing before it.
//
// Run: pnpm release [--dry-run] [--yes] [--version <v> [--stable]]. --dry-run runs only the read-only checks and
// prints every command a real run would run. Every command goes through an injected runner (Io), so the tests can
// prove a dry run never runs a mutating one.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DEFAULT_CLOUD_URL, PINNED_HOSTS } from "../src/config/index.ts";

export const REPO = "golden007eye/intent-gateway";
export const PACKAGE = "intent-gateway";
export const IMAGE = "ghcr.io/golden007eye/intent-gateway";
const POLL_MS = 5_000;
const LOG_TAIL_LINES = 40;
const RULE =
  "A failed release is fixed with a new version, never by moving or re-pushing its tag: npm versions cannot be " +
  "republished and the signatures name the tag (docs/release.md).";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Everything the release touches outside this file, so tests can fake it. */
export interface Io {
  /** Runs a command; `stream` shows its output live instead of capturing it. */
  run(cmd: string, args: readonly string[], opts?: { stream?: boolean }): RunResult;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  ask(question: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  isTTY: boolean;
  nodeVersion: string;
  /** Root keys pinned for the default Intent Cloud host in src/config. */
  rootKeyCount: number;
}

export interface Flags {
  dryRun: boolean;
  yes: boolean;
  stable: boolean;
  version?: string;
}

/** A stop: the message names what is wrong and how to fix it. */
export class Stop extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Versions

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PREVIEW = /^(\d+\.\d+\.\d+)-preview\.(0|[1-9]\d*)$/;

export function isVersion(v: string): boolean {
  return SEMVER.test(v);
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null) throw new Error(`not a version: ${pa === null ? a : b}`);
  for (const i of [1, 2, 3]) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const [ra, rb] = [pa[4], pb[4]];
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra === undefined ? 1 : -1;
  const ia = ra.split(".");
  const ib = rb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const [x, y] = [ia[i], ib[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface VersionInput {
  /** The version in package.json on main. */
  current: string;
  /** Versions that have a `v<version>` tag on origin. */
  tags: readonly string[];
  override?: string;
  stable: boolean;
}

export type VersionChoice = { ok: true; version: string; bump: boolean; reason: string } | { ok: false; message: string };

/** The version to release, and whether package.json must be bumped to it first. */
export function selectVersion(input: VersionInput): VersionChoice {
  const tags = input.tags.filter(isVersion);
  const last = tags.reduce<string | undefined>((max, t) => (max === undefined || compareVersions(t, max) > 0 ? t : max), undefined);
  const notAfterLast = (v: string): VersionChoice | null =>
    last !== undefined && compareVersions(v, last) <= 0
      ? { ok: false, message: `${v} is not greater than the last tag v${last}: pass --version <v> with a later version` }
      : null;

  if (input.override === undefined) {
    if (input.stable) return { ok: false, message: "--stable needs --version <v>: a stable release is never the default" };
    const m = PREVIEW.exec(input.current);
    if (m === null) {
      return { ok: false, message: `package.json is ${input.current}, not X.Y.Z-preview.N, so there is no default next preview: pass --version <v>` };
    }
    const choice: VersionChoice = tags.includes(input.current)
      ? { ok: true, version: `${m[1] ?? ""}-preview.${String(Number(m[2]) + 1)}`, bump: true, reason: `tag v${input.current} exists on origin, so the next preview` }
      : { ok: true, version: input.current, bump: false, reason: `package.json is ${input.current} and tag v${input.current} is not on origin yet` };
    return notAfterLast(choice.version) ?? choice;
  }

  const v = input.override;
  if (!isVersion(v)) return { ok: false, message: `--version ${v} is not a version like 0.1.0-preview.2` };
  const prerelease = v.includes("-");
  if (!prerelease && !input.stable) return { ok: false, message: `${v} is a stable version (npm dist-tag latest): pass --stable as well to release it` };
  if (prerelease && input.stable) return { ok: false, message: `--stable is for a plain version, and ${v} is a prerelease: drop --stable` };
  const late = notAfterLast(v);
  if (late !== null) return late;
  if (compareVersions(v, input.current) < 0) return { ok: false, message: `${v} is lower than package.json's ${input.current}: pass a version of at least ${input.current}` };
  return v === input.current
    ? { ok: true, version: v, bump: false, reason: `--version ${v}, already in package.json` }
    : { ok: true, version: v, bump: true, reason: `--version ${v}` };
}

/** The preview after `v` (0.1.0-preview.1 → 0.1.0-preview.2), or null when `v` is not a preview. */
export function nextPreview(v: string): string | null {
  const m = PREVIEW.exec(v);
  return m === null ? null : `${m[1] ?? ""}-preview.${String(Number(m[2]) + 1)}`;
}

export function distTag(v: string): "next" | "latest" {
  return v.includes("-") ? "next" : "latest";
}

// ---------------------------------------------------------------------------------------------------------------
// Preflight

export interface Check {
  ok: boolean;
  line: string;
}

const ENV_SETUP =
  `https://github.com/${REPO}/settings/environments/new, name it \`release\`, tick "Required reviewers" and add the ` +
  'maintainer, and under "Deployment branches and tags" choose "Selected branches and tags" with the tag rule `v*` (docs/release.md, K3)';

function out(io: Io, cmd: string, args: readonly string[]): RunResult {
  const r = io.run(cmd, args);
  return { ...r, stdout: r.stdout.trim() };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

interface CiRun {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string;
  url: string;
}

function ciRuns(io: Io, limit: number): CiRun[] | string {
  const r = out(io, "gh", ["run", "list", "-R", REPO, "--branch", "main", "--workflow", "ci", "--limit", String(limit), "--json", "databaseId,headSha,status,conclusion,url"]);
  if (r.status !== 0) return `cannot list CI runs on main: ${firstLine(r.stderr)}`;
  return JSON.parse(r.stdout) as CiRun[];
}

/** Every read-only check before a release; each failed line says how to fix it. */
export function preflight(io: Io): Check[] {
  const checks: Check[] = [];
  const add = (ok: boolean, good: string, bad: string): void => {
    checks.push({ ok, line: ok ? good : bad });
  };

  const branch = out(io, "git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  add(branch === "main", "on main", `on branch ${branch}, not main: run \`git switch main\``);

  const status = out(io, "git", ["status", "--porcelain", "--untracked-files=all"]).stdout;
  const changed = status === "" ? 0 : status.split("\n").length;
  add(changed === 0, "the working tree is clean", `the working tree has ${String(changed)} changed or untracked file(s): commit them on a branch or remove them`);

  const fetch = out(io, "git", ["fetch", "--quiet", "origin", "main"]);
  const head = out(io, "git", ["rev-parse", "HEAD"]).stdout;
  if (fetch.status !== 0) {
    add(false, "", `\`git fetch origin main\` failed (${firstLine(fetch.stderr)}): check the network and your GitHub access`);
  } else {
    const remote = out(io, "git", ["rev-parse", "origin/main"]).stdout;
    add(
      head === remote,
      `main is origin/main (${head.slice(0, 7)})`,
      `local main (${head.slice(0, 7)}) is not origin/main (${remote.slice(0, 7)}): run \`git pull --ff-only origin main\`; move any local commits to a branch first`,
    );
  }

  const runs = ciRuns(io, 1);
  if (typeof runs === "string") add(false, "", `${runs}: run \`gh auth status\``);
  else {
    const latest = runs[0];
    if (latest === undefined) add(false, "", "main has no CI run yet: wait for the ci workflow on main");
    else if (latest.headSha !== head) {
      add(false, "", `the latest CI run on main is for ${latest.headSha.slice(0, 7)}, not ${head.slice(0, 7)}: wait for CI on ${head.slice(0, 7)} (${latest.url})`);
    } else if (latest.status !== "completed") add(false, "", `CI on main is still running: wait for ${latest.url} and re-run`);
    else add(latest.conclusion === "success", `CI on main is green (${latest.url})`, `CI on main is ${latest.conclusion} (${latest.url}): fix main first`);
  }

  add(io.run("gh", ["auth", "status"]).status === 0, "gh is logged in", "gh is not logged in: run `gh auth login`");

  const [major = 0, minor = 0] = io.nodeVersion.replace(/^v/, "").split(".").map(Number);
  add(
    (major === 24 && minor >= 15) || major >= 26,
    `node ${io.nodeVersion}`,
    `node ${io.nodeVersion} is not 24.15+ or 26+: use Node 24 (.node-version)`,
  );

  const env = io.run("gh", ["api", `repos/${REPO}/environments/release`]);
  if (env.status !== 0) {
    add(
      false,
      "",
      /404|Not Found/.test(env.stderr + env.stdout)
        ? `the GitHub environment \`release\` does not exist, so nothing would wait for your approval. Create it: ${ENV_SETUP}`
        : `cannot read the \`release\` environment (${firstLine(env.stderr)}): run \`gh auth status\``,
    );
  } else {
    const rules = (JSON.parse(env.stdout) as { protection_rules?: { type: string; reviewers?: unknown[] }[] }).protection_rules ?? [];
    const reviewers = rules.find((r) => r.type === "required_reviewers")?.reviewers?.length ?? 0;
    add(
      reviewers > 0,
      `the \`release\` environment has ${String(reviewers)} required reviewer(s)`,
      `the \`release\` environment has no required reviewer, so a tag would publish without approval: at https://github.com/${REPO}/settings/environments open \`release\`, tick "Required reviewers" and add the maintainer`,
    );
  }

  const host = new URL(DEFAULT_CLOUD_URL).host;
  add(
    io.rootKeyCount > 0,
    `a root key is pinned for ${host}`,
    `no root key is pinned for ${host} in src/config/index.ts: pin cloud-root-1 by pull request first (docs/release.md)`,
  );
  return checks;
}

// ---------------------------------------------------------------------------------------------------------------
// The release

function display(cmd: string, args: readonly string[]): string {
  const shown = args.map((a) => (a.includes("\n") ? "<text>" : /^[\w@%+=:,./-]+$|^<[\w ]+>$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`));
  return [cmd, ...shown].join(" ");
}

/** Runs a command that changes something; a dry run only prints it. A failure stops the release with `fix`. */
function act(io: Io, flags: Flags, fix: string, cmd: string, args: readonly string[], opts?: { stream?: boolean }): RunResult {
  if (flags.dryRun) {
    io.log(`  would run: ${display(cmd, args)}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  io.log(`  $ ${display(cmd, args)}`);
  const r = io.run(cmd, args, opts);
  if (r.status !== 0) throw new Stop(`\`${display(cmd, args)}\` failed${r.stderr.trim() === "" ? "" : ` (${firstLine(r.stderr)})`}: ${fix}`);
  return r;
}

export function readPackageVersion(io: Io): string {
  return (JSON.parse(io.readFile("package.json")) as { version: string }).version;
}

/** package.json with only its version changed, keeping its formatting. */
export function withVersion(text: string, from: string, to: string): string {
  const field = `"version": ${JSON.stringify(from)}`;
  if (!text.includes(field)) throw new Stop(`package.json has no ${field} line to change`);
  return text.replace(field, `"version": ${JSON.stringify(to)}`);
}

export function prBody(version: string, from: string): string {
  return [
    "## What changed",
    `Sets the package version to \`${version}\` (from \`${from}\`); nothing else.`,
    "",
    "## Why",
    `The release \`v${version}\` (docs/release.md, ADR-0010). \`pnpm release\` opened this pull request and tags the merged commit.`,
    "",
    "## Evidence",
    "`pnpm release` checked main (clean, up to date, CI green). CI on this pull request runs `pnpm check`.",
    "",
    "## Checks",
    "- [x] Public-safe: no internal names, hosts or people (`pnpm public-safety` agrees)",
    "- [x] Invariants in CLAUDE.md untouched, or each touched one has a failing-if-broken test",
    "- [x] New terms added to GLOSSARY.md",
    "",
  ].join("\n");
}

function remoteTags(io: Io): string[] {
  const r = out(io, "git", ["ls-remote", "--tags", "--refs", "origin"]);
  if (r.status !== 0) throw new Stop(`cannot list the tags on origin (${firstLine(r.stderr)}): check the network and your GitHub access`);
  return [...r.stdout.matchAll(/refs\/tags\/v(\S+)/g)].map((m) => m[1] ?? "");
}

/** Whether the npm registry already has `version` (a published version can never be published again). */
function npmHas(io: Io, version: string): boolean {
  const r = out(io, "npm", ["view", `${PACKAGE}@${version}`, "version"]);
  if (r.status === 0) return r.stdout !== "";
  if (/E404/.test(r.stderr + r.stdout)) return false;
  throw new Stop(`cannot ask the npm registry about ${PACKAGE}@${version} (${firstLine(r.stderr)}): check the network`);
}

async function poll<T>(io: Io, tries: number, find: () => T | undefined): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const found = find();
    if (found !== undefined) return found;
    await io.sleep(POLL_MS);
  }
  return undefined;
}

/** Waits for main's CI run on `sha` and follows it to the end. */
async function waitForMainCi(io: Io, sha: string, version: string): Promise<void> {
  const run = await poll(io, 60, () => {
    const runs = ciRuns(io, 10);
    return typeof runs === "string" ? undefined : runs.find((r) => r.headSha === sha);
  });
  if (run === undefined) throw new Stop(`no CI run on main for ${sha.slice(0, 7)} after 5 minutes: once it is green, re-run \`pnpm release\` (it tags ${version} without a new bump)`);
  io.log(`  CI on main: ${run.url}`);
  const r = io.run("gh", ["run", "watch", String(run.databaseId), "-R", REPO, "--exit-status", "--interval", "15"], { stream: true });
  if (r.status !== 0) throw new Stop(`CI on main failed for the release commit (${run.url}): fix main by pull request, then re-run \`pnpm release\` (it tags ${version} without a new bump)`);
}

async function bump(io: Io, flags: Flags, version: string, from: string): Promise<string> {
  const branch = `release/${version}`;
  const retry = `fix it, then re-run \`pnpm release --version ${version}\``;
  act(io, flags, `delete or rename the branch ${branch}, then re-run`, "git", ["switch", "-c", branch]);
  if (flags.dryRun) io.log(`  would set package.json "version" from ${from} to ${version}`);
  else {
    io.writeFile("package.json", withVersion(io.readFile("package.json"), from, version));
    io.log(`  package.json "version": ${from} → ${version}`);
  }
  act(io, flags, retry, "git", ["commit", "--all", "--message", `release: ${version}`]);
  act(io, flags, retry, "git", ["push", "--set-upstream", "origin", branch]);
  const pr = act(io, flags, retry, "gh", ["pr", "create", "-R", REPO, "--base", "main", "--head", branch, "--title", `release: ${version}`, "--body", prBody(version, from)]);
  if (flags.dryRun) {
    act(io, flags, retry, "gh", ["pr", "checks", "<number>", "-R", REPO, "--watch", "--interval", "15"]);
    act(io, flags, retry, "gh", ["pr", "merge", "<number>", "--squash", "-R", REPO]);
    io.log("  would fast-forward main to the merged commit and wait for CI on main to pass");
    return "<merged commit>";
  }
  const number = /\/pull\/(\d+)/.exec(pr.stdout)?.[1];
  if (number === undefined) throw new Stop(`gh pr create printed no pull request URL (${pr.stdout.trim()}): finish the pull request by hand, then re-run \`pnpm release\``);
  io.log(`  pull request: ${pr.stdout.trim()}`);
  // Checks appear a few seconds after the pull request; `gh pr checks --watch` fails while there are none.
  const listed = await poll(io, 24, () => {
    const r = io.run("gh", ["pr", "checks", number, "-R", REPO, "--json", "name"]);
    return r.stdout.trim().startsWith("[{") ? true : undefined;
  });
  if (listed === undefined) throw new Stop(`no CI checks started on pull request #${number} after 2 minutes: ${retry}`);
  act(io, flags, `CI failed on pull request #${number}: fix it on ${branch}, push, merge it once green, then re-run \`pnpm release\``, "gh", ["pr", "checks", number, "-R", REPO, "--watch", "--interval", "15"], { stream: true });
  act(io, flags, `merge pull request #${number} by hand, then re-run \`pnpm release\``, "gh", ["pr", "merge", number, "--squash", "-R", REPO]);
  const ffFix = "run `git switch main && git pull --ff-only origin main`, then re-run `pnpm release`";
  act(io, flags, ffFix, "git", ["switch", "main"]);
  act(io, flags, ffFix, "git", ["fetch", "--quiet", "origin", "main"]);
  act(io, flags, ffFix, "git", ["merge", "--ff-only", "origin/main"]);
  const merged = out(io, "git", ["rev-parse", "HEAD"]).stdout;
  if (readPackageVersion(io) !== version) throw new Stop(`main at ${merged.slice(0, 7)} does not have version ${version} in package.json: check pull request #${number}`);
  await waitForMainCi(io, merged, version);
  return merged;
}

interface RunJob {
  name: string;
  conclusion: string;
  databaseId: number;
}

async function watch(io: Io, version: string, sha: string): Promise<void> {
  const tag = `v${version}`;
  const run = await poll(io, 24, () => {
    const r = out(io, "gh", ["run", "list", "-R", REPO, "--workflow", "release.yml", "--limit", "20", "--json", "databaseId,headBranch,headSha,url"]);
    if (r.status !== 0) return undefined;
    return (JSON.parse(r.stdout) as { databaseId: number; headBranch: string; headSha: string; url: string }[]).find((x) => x.headBranch === tag && x.headSha === sha);
  });
  if (run === undefined) {
    throw new Stop(`no release run for ${tag} after 2 minutes: look at https://github.com/${REPO}/actions/workflows/release.yml. Do not move or re-push the tag.`);
  }
  io.log(`  release run: ${run.url}`);
  io.log(`  Approve the \`release\` deployment in GitHub: ${run.url}`);
  io.run("gh", ["run", "watch", String(run.databaseId), "-R", REPO, "--interval", "30"], { stream: true });

  const view = out(io, "gh", ["run", "view", String(run.databaseId), "-R", REPO, "--json", "conclusion,jobs,url"]);
  if (view.status !== 0) throw new Stop(`cannot read the release run (${firstLine(view.stderr)}): look at ${run.url}`);
  const { conclusion, jobs } = JSON.parse(view.stdout) as { conclusion: string; jobs: RunJob[] };
  if (conclusion !== "success") {
    io.log(`release run ${tag}: ${conclusion === "" ? "not finished" : conclusion} (${run.url})`);
    for (const job of jobs.filter((j) => j.conclusion !== "success" && j.conclusion !== "skipped")) io.log(`  job ${job.name}: ${job.conclusion}`);
    const logs = io.run("gh", ["run", "view", String(run.databaseId), "-R", REPO, "--log-failed"]).stdout.trimEnd().split("\n").slice(-LOG_TAIL_LINES);
    if (logs.join("") !== "") io.log(["  log tail:", ...logs.map((l) => `    ${l}`)].join("\n"));
    const next = nextPreview(version);
    throw new Stop(
      `${RULE} Run \`pnpm release\` again for ${next ?? "the next version"}. If only post-publish failed on the anonymous image checks, ` +
        "the GHCR package may still be private: make it public and re-run the failed jobs (docs/release.md, K3).",
    );
  }

  const tags = out(io, "npm", ["view", `${PACKAGE}@${version}`, "dist-tags", "--json"]);
  const imageJob = jobs.find((j) => j.name.startsWith("image"));
  const log = imageJob === undefined ? "" : io.run("gh", ["run", "view", "-R", REPO, "--log", "--job", String(imageJob.databaseId)]).stdout;
  const digest = /built (sha256:[0-9a-f]{64}), pushed/.exec(log)?.[1];
  const ghRelease = out(io, "gh", ["release", "view", tag, "-R", REPO, "--json", "url,isPrerelease"]);
  const page = ghRelease.status === 0 ? (JSON.parse(ghRelease.stdout) as { url: string; isPrerelease: boolean }) : undefined;
  io.log(
    [
      `released ${PACKAGE} ${version}: the release run concluded ${conclusion} (${run.url})`,
      `  run it:    npx -y ${PACKAGE}@${distTag(version)}`,
      `  dist-tags: ${tags.status === 0 ? JSON.stringify(JSON.parse(tags.stdout)) : `npm view failed: ${firstLine(tags.stderr)}`}`,
      `  image:     ${digest === undefined ? `${IMAGE}:${version} (digest: see the image job of ${run.url})` : `${IMAGE}@${digest} (tag ${version})`}`,
      `  github:    ${page === undefined ? `no GitHub Release for ${tag} (${firstLine(ghRelease.stderr)}): see the github-release job of ${run.url}` : `${page.url}${page.isPrerelease ? " (prerelease)" : ""}`}`,
    ].join("\n"),
  );
}

export async function release(flags: Flags, io: Io): Promise<void> {
  if (!flags.dryRun && !flags.yes && !io.isTTY) {
    throw new Stop("not a terminal, so no one can confirm the tag push: run it in a terminal, or pass --yes");
  }
  io.log(flags.dryRun ? "pnpm release --dry-run: read-only checks; nothing is changed" : "pnpm release");

  io.log("1/5 preflight");
  const checks = preflight(io);
  for (const c of checks) io.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.line}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed > 0 && !flags.dryRun) throw new Stop(`${String(failed)} preflight check(s) failed: fix the FAIL lines above and re-run`);

  io.log("2/5 version");
  const current = readPackageVersion(io);
  const choice = selectVersion({ current, tags: remoteTags(io), stable: flags.stable, ...(flags.version === undefined ? {} : { override: flags.version }) });
  if (!choice.ok) throw new Stop(choice.message);
  const { version } = choice;
  if (npmHas(io, version)) throw new Stop(`npm already has ${PACKAGE}@${version}, and a version is never published twice: pass --version <v> with a new version`);
  io.log(`  release ${version} (${choice.reason}; npm dist-tag ${distTag(version)}; not on npm yet)`);

  io.log("3/5 version bump");
  let sha = out(io, "git", ["rev-parse", "HEAD"]).stdout;
  if (choice.bump) sha = await bump(io, flags, version, current);
  else io.log(`  none: package.json is already ${version}`);

  io.log("4/5 tag");
  const tag = `v${version}`;
  const signed = out(io, "git", ["config", "--get", "tag.gpgSign"]).stdout === "true";
  if (!flags.yes) {
    if (flags.dryRun) io.log(`  would ask: push tag ${tag}? [y/N]`);
    else if (!/^y(es)?$/i.test((await io.ask(`push tag ${tag}? [y/N] `)).trim())) {
      throw new Stop(`tag ${tag} not pushed: you answered no. Re-run \`pnpm release\` to tag ${version}.`);
    }
  }
  act(io, flags, `delete the local tag (\`git tag -d ${tag}\`) only if it was never pushed, then re-run`, "git", ["tag", signed ? "--sign" : "--annotate", tag, sha, "--message", `${PACKAGE} ${version}`]);
  act(io, flags, `the tag ${tag} exists locally only; re-run \`git push origin refs/tags/${tag}\` once the cause is fixed`, "git", ["push", "origin", `refs/tags/${tag}`]);

  io.log("5/5 watch");
  if (flags.dryRun) {
    io.log(`  would find the release.yml run for ${tag}, print its URL with "Approve the \`release\` deployment in GitHub: <url>", and follow it to the end`);
    if (failed > 0) throw new Stop(`dry run: ${String(failed)} preflight check(s) failed, so a real run would stop at preflight; fix the FAIL lines above`);
    io.log(`dry run done: a real run would release ${version} as above`);
    return;
  }
  await watch(io, version, sha);
}

// ---------------------------------------------------------------------------------------------------------------

export function parseFlags(argv: readonly string[]): Flags {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { "dry-run": { type: "boolean" }, yes: { type: "boolean" }, stable: { type: "boolean" }, version: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    return {
      dryRun: values["dry-run"] === true,
      yes: values.yes === true,
      stable: values.stable === true,
      ...(values.version === undefined ? {} : { version: values.version }),
    };
  } catch (err) {
    throw new Stop(`${err instanceof Error ? err.message : String(err)}. Usage: pnpm release [--dry-run] [--yes] [--version <v> [--stable]]`);
  }
}

function realIo(): Io {
  const host = new URL(DEFAULT_CLOUD_URL).host;
  return {
    run(cmd, args, opts) {
      const r = spawnSync(cmd, args, { encoding: "utf8", stdio: opts?.stream === true ? "inherit" : "pipe", maxBuffer: 64 * 1024 * 1024 });
      // With stdio "inherit" there is no captured output: spawnSync then returns null for both.
      const stdout = r.stdout as string | null;
      const stderr = r.stderr as string | null;
      return { status: r.status ?? 1, stdout: stdout ?? "", stderr: stderr ?? r.error?.message ?? "" };
    },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => {
      writeFileSync(path, text);
    },
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => {
      console.log(line);
    },
    isTTY: process.stdin.isTTY,
    nodeVersion: process.version,
    rootKeyCount: Object.hasOwn(PINNED_HOSTS, host) ? (PINNED_HOSTS[host]?.rootKeys.length ?? 0) : 0,
  };
}

async function main(): Promise<void> {
  try {
    await release(parseFlags(process.argv.slice(2)), realIo());
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    console.error(`stop: ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) await main();
