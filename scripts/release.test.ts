import { describe, expect, it } from "vitest";
import {
  compareVersions,
  nextPreview,
  parseFlags,
  preflight,
  release,
  selectVersion,
  Stop,
  withImageTag,
  withVersion,
  type Flags,
  type Io,
  type RunResult,
} from "./release.ts";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const CI_URL = "https://github.com/golden007eye/intent-gateway/actions/runs/1";
const RELEASE_URL = "https://github.com/golden007eye/intent-gateway/actions/runs/2";
const GH_RELEASES = "https://github.com/golden007eye/intent-gateway/releases";
const DOC = (v: string): string => `$ docker pull ghcr.io/golden007eye/intent-gateway:${v}\nor ghcr.io/golden007eye/intent-gateway:latest\n`;
const PKG = (v: string): string => `{\n  "name": "intent-gateway",\n  "version": "${v}",\n  "license": "Apache-2.0"\n}\n`;

// Commands that change the repository, GitHub or npm, or follow a run that only a real release starts. A dry run
// must never run one. This list is written independently of release.ts, which never names these as such.
const MUTATING = [
  /^git (push|tag|commit|switch|checkout|merge|branch|reset|pull|rebase|stash|add|rm)\b/,
  /^gh pr (create|merge|edit|close|checks .*--watch)\b/,
  /^gh run (watch|rerun|cancel)\b/,
  /^gh release (?!(view|list)\b)/,
  /^gh workflow run\b/,
  /^gh api .*(-X|--method|-f |-F |--field|--input)/,
  /^npm (publish|version|dist-tag (add|rm))\b/,
];
const isMutating = (line: string): boolean => MUTATING.some((re) => re.test(line));

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): RunResult => ({ status: 1, stdout, stderr });

type Responder = (line: string) => RunResult | undefined;

/** A repository on an up-to-date, green main with no tag yet, as the fake world every test starts from. */
function world(overrides: Responder[] = [], opts: { version?: string; tty?: boolean; answer?: string; node?: string; keys?: number } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const writes: { path: string; text: string }[] = [];
  const asked: string[] = [];
  let pkg = PKG(opts.version ?? "0.1.0-preview.1");
  const docs: Record<string, string> = { "README.md": DOC("0.1.0-preview.1"), "docs/quickstart.md": DOC("0.0.9-preview.7") };
  const base: Responder = (line) => {
    if (line === "git rev-parse --abbrev-ref HEAD") return ok("main\n");
    if (line.startsWith("git status")) return ok("");
    if (line.startsWith("git fetch")) return ok();
    if (line === "git rev-parse HEAD" || line === "git rev-parse origin/main") return ok(`${SHA}\n`);
    if (line.startsWith("gh run list") && line.includes("--workflow ci")) {
      return ok(JSON.stringify([{ databaseId: 1, headSha: SHA, status: "completed", conclusion: "success", url: CI_URL }]));
    }
    if (line === "gh auth status") return ok();
    if (line.startsWith("gh api repos/golden007eye/intent-gateway/environments/release")) {
      return ok(JSON.stringify({ name: "release", protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }] }));
    }
    if (line.startsWith("git ls-remote")) return ok("");
    if (/^npm view intent-gateway@\S+ version$/.test(line)) return fail("npm error code E404\nnpm error 404 Not Found");
    if (line === "git config --get tag.gpgSign") return ok("true\n");
    if (line.startsWith("git ")) return ok();
    if (line.startsWith("gh pr create")) return ok("https://github.com/golden007eye/intent-gateway/pull/70\n");
    if (line.startsWith("gh pr checks") && line.includes("--json")) return ok('[{"name":"check"}]');
    if (line.startsWith("gh pr")) return ok();
    if (line.startsWith("gh run list") && line.includes("release.yml")) {
      const tag = `v${(JSON.parse(pkg) as { version: string }).version}`;
      return ok(JSON.stringify([{ databaseId: 2, headBranch: tag, headSha: SHA, url: RELEASE_URL }]));
    }
    if (line.startsWith("gh run watch")) return ok();
    if (line.startsWith("gh run view 2") && line.includes("--json")) {
      return ok(JSON.stringify({ conclusion: "success", url: RELEASE_URL, jobs: [{ name: "image (reproducible build)", conclusion: "success", databaseId: 7 }] }));
    }
    if (line.includes("--log --job 7")) return ok(`push\tbuilt ${DIGEST}, pushed ${DIGEST}, tag x is ${DIGEST}\n`);
    if (line.includes("dist-tags --json")) return ok('{"next":"0.1.0-preview.1"}');
    if (line.startsWith("gh release view v")) return ok(JSON.stringify({ url: `${GH_RELEASES}/tag/${line.split(" ")[3] ?? ""}`, isPrerelease: true }));
    return undefined;
  };
  const io: Io = {
    run(cmd, args) {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      for (const r of [...overrides, base]) {
        const res = r(line);
        if (res !== undefined) return res;
      }
      throw new Error(`unexpected command: ${line}`);
    },
    readFile: (path) => (path === "package.json" ? pkg : (docs[path] ?? "")),
    writeFile(path, text) {
      writes.push({ path, text });
      if (path === "package.json") pkg = text;
      else docs[path] = text;
    },
    ask(question) {
      asked.push(question);
      return Promise.resolve(opts.answer ?? "y");
    },
    sleep: () => Promise.resolve(),
    log(line) {
      logs.push(line);
    },
    isTTY: opts.tty ?? true,
    nodeVersion: opts.node ?? "v24.22.0",
    rootKeyCount: opts.keys ?? 1,
  };
  return { io, calls, logs, writes, asked, text: () => logs.join("\n") };
}

const flags = (f: Partial<Flags> = {}): Flags => ({ dryRun: false, yes: false, stable: false, ...f });

async function stopOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Stop) return err.message;
    throw err;
  }
  throw new Error("expected a stop");
}

describe("compareVersions", () => {
  it.each([
    ["0.1.0", "0.1.0-preview.1", 1],
    ["0.1.0-preview.2", "0.1.0-preview.10", -1],
    ["0.1.0-preview.10", "0.1.0-preview.9", 1],
    ["0.2.0-preview.1", "0.1.9", 1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-beta", "1.0.0-alpha", 1],
    ["0.1.0-preview.1", "0.1.0-preview.1", 0],
  ])("%s vs %s → sign %d", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe("selectVersion", () => {
  it("releases package.json's preview without a bump while its tag is not on origin", () => {
    expect(selectVersion({ current: "0.1.0-preview.1", tags: [], stable: false })).toEqual({
      ok: true,
      version: "0.1.0-preview.1",
      bump: false,
      reason: "package.json is 0.1.0-preview.1 and tag v0.1.0-preview.1 is not on origin yet",
    });
  });

  it("bumps to preview.N+1 when package.json's tag exists", () => {
    expect(selectVersion({ current: "0.1.0-preview.1", tags: ["0.1.0-preview.1"], stable: false })).toMatchObject({ ok: true, version: "0.1.0-preview.2", bump: true });
  });

  it("refuses a default when package.json is not a preview", () => {
    expect(selectVersion({ current: "0.1.0", tags: [], stable: false })).toEqual({
      ok: false,
      message: "package.json is 0.1.0, not X.Y.Z-preview.N, so there is no default next preview: pass --version <v>",
    });
  });

  it("refuses a default that is not after the last tag", () => {
    expect(selectVersion({ current: "0.1.0-preview.1", tags: ["0.1.0-preview.1", "0.1.0-preview.5"], stable: false })).toEqual({
      ok: false,
      message: "0.1.0-preview.2 is not greater than the last tag v0.1.0-preview.5: pass --version <v> with a later version",
    });
    expect(selectVersion({ current: "0.1.0-preview.1", tags: ["0.2.0-preview.1"], stable: false }).ok).toBe(false);
  });

  it("refuses --stable without --version", () => {
    expect(selectVersion({ current: "0.1.0-preview.1", tags: [], stable: true })).toMatchObject({ ok: false, message: expect.stringMatching(/^--stable needs --version/) as unknown });
  });

  it("takes --version over the default, bumping when it differs from package.json", () => {
    expect(selectVersion({ current: "0.1.0-preview.1", tags: ["0.1.0-preview.1"], override: "0.1.0-preview.3", stable: false })).toMatchObject({ ok: true, version: "0.1.0-preview.3", bump: true });
    expect(selectVersion({ current: "0.1.0-preview.2", tags: ["0.1.0-preview.1"], override: "0.1.0-preview.2", stable: false })).toMatchObject({ ok: true, version: "0.1.0-preview.2", bump: false });
  });

  it.each([
    ["0.1", "--version 0.1 is not a version like 0.1.0-preview.2"],
    ["v0.1.0-preview.2", "--version v0.1.0-preview.2 is not a version like 0.1.0-preview.2"],
    ["0.1.0", "0.1.0 is a stable version (npm dist-tag latest): pass --stable as well to release it"],
    ["0.1.0-preview.1", "0.1.0-preview.1 is not greater than the last tag v0.1.0-preview.1: pass --version <v> with a later version"],
    ["0.0.9-preview.9", "0.0.9-preview.9 is not greater than the last tag v0.1.0-preview.1: pass --version <v> with a later version"],
  ])("refuses --version %s", (override, message) => {
    expect(selectVersion({ current: "0.1.0-preview.1", tags: ["0.1.0-preview.1"], override, stable: false })).toEqual({ ok: false, message });
  });

  it("refuses a --version below package.json", () => {
    expect(selectVersion({ current: "0.1.0-preview.4", tags: ["0.1.0-preview.1"], override: "0.1.0-preview.3", stable: false })).toEqual({
      ok: false,
      message: "0.1.0-preview.3 is lower than package.json's 0.1.0-preview.4: pass a version of at least 0.1.0-preview.4",
    });
  });

  it("releases a stable version only with --stable, and --stable only with a stable version", () => {
    expect(selectVersion({ current: "0.1.0-preview.4", tags: ["0.1.0-preview.4"], override: "0.1.0", stable: true })).toMatchObject({ ok: true, version: "0.1.0", bump: true });
    expect(selectVersion({ current: "0.1.0-preview.4", tags: [], override: "0.1.0-preview.5", stable: true })).toEqual({
      ok: false,
      message: "--stable is for a plain version, and 0.1.0-preview.5 is a prerelease: drop --stable",
    });
  });

  it("ignores tags that are not versions", () => {
    expect(selectVersion({ current: "0.1.0-preview.1", tags: ["latest", "0.1.0-preview.1"], stable: false })).toMatchObject({ version: "0.1.0-preview.2" });
  });

  it("nextPreview", () => {
    expect(nextPreview("0.1.0-preview.9")).toBe("0.1.0-preview.10");
    expect(nextPreview("0.1.0")).toBeNull();
  });
});

describe("preflight", () => {
  it("passes every check in a ready repository", () => {
    const checks = preflight(world().io);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.line)).toContain("the `release` environment has 1 required reviewer(s)");
  });

  const failing = (overrides: Responder[], opts: Parameters<typeof world>[1] = {}): string[] =>
    preflight(world(overrides, opts).io)
      .filter((c) => !c.ok)
      .map((c) => c.line);

  it("names the fix for each failed check", () => {
    expect(failing([(l) => (l === "git rev-parse --abbrev-ref HEAD" ? ok("feature\n") : undefined)])).toEqual(["on branch feature, not main: run `git switch main`"]);
    expect(failing([(l) => (l.startsWith("git status") ? ok(" M a.ts\n?? b.ts\n") : undefined)])).toEqual([
      "the working tree has 2 changed or untracked file(s): commit them on a branch or remove them",
    ]);
    expect(failing([(l) => (l === "git rev-parse origin/main" ? ok(`${"c".repeat(40)}\n`) : undefined)])).toEqual([
      "local main (aaaaaaa) is not origin/main (ccccccc): run `git pull --ff-only origin main`; move any local commits to a branch first",
    ]);
    expect(failing([(l) => (l.startsWith("git fetch") ? fail("fatal: unable to access") : undefined)])).toEqual([
      "`git fetch origin main` failed (fatal: unable to access): check the network and your GitHub access",
    ]);
    expect(failing([(l) => (l === "gh auth status" ? fail("not logged in") : undefined)])).toEqual(["gh is not logged in: run `gh auth login`"]);
    expect(failing([], { node: "v25.1.0" })).toEqual(["node v25.1.0: releasing needs Node 24.15+ or 26+, because releases build on Node 24 (.node-version); switch to Node 24, for example nvm use 24, and re-run"]);
    expect(failing([], { node: "v24.14.0" })).toHaveLength(1);
    expect(failing([], { node: "v26.0.0" })).toEqual([]);
    expect(failing([], { keys: 0 })).toEqual([
      "no root key is pinned for staging-api.intentai.shop in src/config/index.ts: pin cloud-root-1 by pull request first (docs/release.md)",
    ]);
  });

  const ci = (runs: unknown[]): Responder => (l) => (l.startsWith("gh run list") ? ok(JSON.stringify(runs)) : undefined);

  it("requires the latest CI run on main to be green for HEAD", () => {
    expect(failing([ci([])])).toEqual(["main has no CI run yet: wait for the ci workflow on main"]);
    expect(failing([ci([{ databaseId: 1, headSha: "d".repeat(40), status: "completed", conclusion: "success", url: CI_URL }])])).toEqual([
      `the latest CI run on main is for ddddddd, not aaaaaaa: wait for CI on aaaaaaa (${CI_URL})`,
    ]);
    expect(failing([ci([{ databaseId: 1, headSha: SHA, status: "in_progress", conclusion: "", url: CI_URL }])])).toEqual([`CI on main is still running: wait for ${CI_URL} and re-run`]);
    expect(failing([ci([{ databaseId: 1, headSha: SHA, status: "completed", conclusion: "failure", url: CI_URL }])])).toEqual([`CI on main is failure (${CI_URL}): fix main first`]);
    expect(failing([(l) => (l.startsWith("gh run list") ? fail("HTTP 401") : undefined)])).toEqual(["cannot list CI runs on main: HTTP 401: run `gh auth status`"]);
  });

  it("says exactly how to create a missing release environment", () => {
    const [line] = failing([(l) => (l.includes("environments/release") ? fail("gh: Not Found (HTTP 404)", '{"message":"Not Found","status":"404"}') : undefined)]);
    expect(line).toBe(
      "the GitHub environment `release` does not exist, so nothing would wait for your approval. Create it: " +
        'https://github.com/golden007eye/intent-gateway/settings/environments/new, name it `release`, tick "Required reviewers" and add the maintainer, ' +
        'and under "Deployment branches and tags" choose "Selected branches and tags" with the tag rule `v*` (docs/release.md, K3)',
    );
  });

  it("refuses an environment with no required reviewer", () => {
    const lines = failing([(l) => (l.includes("environments/release") ? ok('{"name":"release","protection_rules":[]}') : undefined)]);
    expect(lines).toEqual([expect.stringMatching(/^the `release` environment has no required reviewer, so a tag would publish without approval/) as unknown]);
  });

  it("reads the environment with a GET only", () => {
    const w = world();
    preflight(w.io);
    expect(w.calls.filter((c) => c.startsWith("gh api"))).toEqual(["gh api repos/golden007eye/intent-gateway/environments/release"]);
  });
});

describe("dry run", () => {
  it("never runs a mutating command or writes a file, and prints what it would do (no bump)", async () => {
    const w = world();
    await release(flags({ dryRun: true }), w.io);
    expect(w.calls.filter(isMutating)).toEqual([]);
    expect(w.writes).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(w.text()).toContain("release 0.1.0-preview.1 (package.json is 0.1.0-preview.1 and tag v0.1.0-preview.1 is not on origin yet");
    expect(w.text()).toContain("none: package.json is already 0.1.0-preview.1");
    expect(w.text()).toContain("would ask: push tag v0.1.0-preview.1? [y/N]");
    expect(w.text()).toContain(`would run: git tag --sign v0.1.0-preview.1 ${SHA} --message 'intent-gateway 0.1.0-preview.1'`);
    expect(w.text()).toContain("would run: git push origin refs/tags/v0.1.0-preview.1");
    expect(w.text()).toContain("dry run done: a real run would release 0.1.0-preview.1 as above");
  });

  it("never runs a mutating command when a bump is needed", async () => {
    const w = world([(l) => (l.startsWith("git ls-remote") ? ok(`${SHA}\trefs/tags/v0.1.0-preview.1\n`) : undefined)]);
    await release(flags({ dryRun: true, yes: true }), w.io);
    expect(w.calls.filter(isMutating)).toEqual([]);
    expect(w.writes).toEqual([]);
    expect(w.text()).toContain("would run: git switch -c release/0.1.0-preview.2");
    expect(w.text()).toContain('would set package.json "version" from 0.1.0-preview.1 to 0.1.0-preview.2');
    expect(w.text()).toContain("would run: gh pr create -R golden007eye/intent-gateway --base main --head release/0.1.0-preview.2");
    expect(w.text()).toContain("would run: gh pr merge <number> --squash -R golden007eye/intent-gateway");
    expect(w.text()).toContain("would run: git push origin refs/tags/v0.1.0-preview.2");
  });

  it("goes on after failed preflight checks to show the plan, then stops", async () => {
    const w = world([(l) => (l.includes("environments/release") ? fail("gh: Not Found (HTTP 404)") : undefined)]);
    const message = await stopOf(release(flags({ dryRun: true }), w.io));
    expect(message).toBe("dry run: 1 preflight check(s) failed, so a real run would stop at preflight; fix the FAIL lines above");
    expect(w.text()).toMatch(/FAIL the GitHub environment `release` does not exist/);
    expect(w.text()).toContain("would run: git push origin refs/tags/v0.1.0-preview.1");
    expect(w.calls.filter(isMutating)).toEqual([]);
  });
});

describe("release", () => {
  it("tags HEAD, pushes only the tag, and prints the summary", async () => {
    const w = world();
    await release(flags(), w.io);
    expect(w.asked).toEqual(["push tag v0.1.0-preview.1? [y/N] "]);
    expect(w.calls.filter(isMutating)).toEqual([
      `git tag --sign v0.1.0-preview.1 ${SHA} --message intent-gateway 0.1.0-preview.1`,
      "git push origin refs/tags/v0.1.0-preview.1",
      "gh run watch 2 -R golden007eye/intent-gateway --interval 30",
    ]);
    const text = w.text();
    expect(text).toContain(`Approve the \`release\` deployment in GitHub: ${RELEASE_URL}`);
    expect(text).toContain("npx -y intent-gateway@next");
    expect(text).toContain('dist-tags: {"next":"0.1.0-preview.1"}');
    expect(text).toContain(`image:     ghcr.io/golden007eye/intent-gateway@${DIGEST} (tag 0.1.0-preview.1)`);
    expect(text).toContain("the release run concluded success");
    expect(text).toContain(`github:    ${GH_RELEASES}/tag/v0.1.0-preview.1 (prerelease)`);
  });

  it("names the github-release job when the run left no GitHub Release", async () => {
    const w = world([(l) => (l.startsWith("gh release view") ? fail("release not found") : undefined)]);
    await release(flags({ yes: true }), w.io);
    expect(w.text()).toContain(`github:    no GitHub Release for v0.1.0-preview.1 (release not found): see the github-release job of ${RELEASE_URL}`);
  });

  it("counts gh release create, edit and upload as mutating, view and list not", () => {
    expect(isMutating("gh release create v1")).toBe(true);
    expect(isMutating("gh release upload v1 x")).toBe(true);
    expect(isMutating("gh release view v1 -R x")).toBe(false);
    expect(isMutating("gh release list")).toBe(false);
  });

  it("annotates without signing when the repo does not sign tags", async () => {
    const w = world([(l) => (l === "git config --get tag.gpgSign" ? fail("") : undefined)]);
    await release(flags({ yes: true }), w.io);
    expect(w.calls).toContain(`git tag --annotate v0.1.0-preview.1 ${SHA} --message intent-gateway 0.1.0-preview.1`);
  });

  it("refuses without a terminal and without --yes, before running anything", async () => {
    const w = world([], { tty: false });
    expect(await stopOf(release(flags(), w.io))).toBe("not a terminal, so no one can confirm the tag push: run it in a terminal, or pass --yes");
    expect(w.calls).toEqual([]);
  });

  it("pushes nothing when the answer is not yes", async () => {
    const w = world([], { answer: "" });
    expect(await stopOf(release(flags(), w.io))).toMatch(/^tag v0.1.0-preview.1 not pushed: you answered no/);
    expect(w.calls.filter(isMutating)).toEqual([]);
  });

  it("stops at preflight on a real run", async () => {
    const w = world([(l) => (l.startsWith("git status") ? ok("?? x\n") : undefined)]);
    expect(await stopOf(release(flags({ yes: true }), w.io))).toBe("1 preflight check(s) failed: fix the FAIL lines above and re-run");
    expect(w.calls.filter(isMutating)).toEqual([]);
  });

  it("refuses a version npm already has", async () => {
    const w = world([(l) => (/^npm view \S+ version$/.test(l) ? ok("0.1.0-preview.1\n") : undefined)]);
    expect(await stopOf(release(flags({ yes: true }), w.io))).toBe(
      "npm already has intent-gateway@0.1.0-preview.1, and a version is never published twice: pass --version <v> with a new version",
    );
    expect(w.calls.filter(isMutating)).toEqual([]);
  });

  it("stops when the registry cannot be asked", async () => {
    const w = world([(l) => (/^npm view \S+ version$/.test(l) ? fail("npm error code ETIMEDOUT") : undefined)]);
    expect(await stopOf(release(flags({ yes: true }), w.io))).toMatch(/^cannot ask the npm registry about intent-gateway@0.1.0-preview.1/);
  });

  it("bumps by pull request, waits for CI, then tags the merged commit", async () => {
    const merged = "e".repeat(40);
    let switched = false;
    const w = world([
      (l) => (l.startsWith("git ls-remote") ? ok(`${SHA}\trefs/tags/v0.1.0-preview.1\n`) : undefined),
      (l) => {
        if (l === "git switch main") switched = true;
        return l === "git rev-parse HEAD" && switched ? ok(`${merged}\n`) : undefined;
      },
      (l) =>
        l.startsWith("gh run list") && l.includes("--limit 10")
          ? ok(JSON.stringify([{ databaseId: 3, headSha: merged, status: "in_progress", conclusion: "", url: CI_URL }]))
          : undefined,
      (l) =>
        l.startsWith("gh run list") && l.includes("release.yml") ? ok(JSON.stringify([{ databaseId: 2, headBranch: "v0.1.0-preview.2", headSha: merged, url: RELEASE_URL }])) : undefined,
    ]);
    await release(flags({ yes: true }), w.io);
    // The docs' image pins follow the new version, a stale pin included; `latest` stays.
    expect(w.writes).toEqual([
      { path: "package.json", text: PKG("0.1.0-preview.2") },
      { path: "README.md", text: DOC("0.1.0-preview.2") },
      { path: "docs/quickstart.md", text: DOC("0.1.0-preview.2") },
    ]);
    expect(w.calls.filter(isMutating)).toEqual([
      "git switch -c release/0.1.0-preview.2",
      "git commit --all --message release: 0.1.0-preview.2",
      "git push --set-upstream origin release/0.1.0-preview.2",
      expect.stringMatching(/^gh pr create -R golden007eye\/intent-gateway --base main --head release\/0.1.0-preview.2 --title release: 0.1.0-preview.2 --body ## What changed/) as unknown,
      "gh pr checks 70 -R golden007eye/intent-gateway --watch --interval 15",
      "gh pr merge 70 --squash -R golden007eye/intent-gateway",
      "git switch main",
      "git merge --ff-only origin/main",
      "gh run watch 3 -R golden007eye/intent-gateway --exit-status --interval 15",
      `git tag --sign v0.1.0-preview.2 ${merged} --message intent-gateway 0.1.0-preview.2`,
      "git push origin refs/tags/v0.1.0-preview.2",
      "gh run watch 2 -R golden007eye/intent-gateway --interval 30",
    ]);
    const body = w.calls.find((c) => c.startsWith("gh pr create")) ?? "";
    expect(body).toContain("- [x] Public-safe");
  });

  it("stops with the fix when CI on the release pull request fails", async () => {
    const w = world([
      (l) => (l.startsWith("git ls-remote") ? ok(`${SHA}\trefs/tags/v0.1.0-preview.1\n`) : undefined),
      (l) => (l.startsWith("gh pr checks 70 -R golden007eye/intent-gateway --watch") ? fail("") : undefined),
    ]);
    expect(await stopOf(release(flags({ yes: true }), w.io))).toMatch(/CI failed on pull request #70: fix it on release\/0.1.0-preview.2/);
    expect(w.calls.some((c) => c.startsWith("git tag") || c.startsWith("gh pr merge"))).toBe(false);
  });

  it("on a failed release prints the failing job, the log tail and the rule", async () => {
    const w = world([
      (l) =>
        l.startsWith("gh run view 2") && l.includes("--json")
          ? ok(JSON.stringify({ conclusion: "failure", url: RELEASE_URL, jobs: [{ name: "gate", conclusion: "success", databaseId: 5 }, { name: "npm (trusted publishing)", conclusion: "failure", databaseId: 6 }] }))
          : undefined,
      (l) => (l.endsWith("--log-failed") ? ok("npm\tstep\tline 1\nnpm\tstep\tE403 forbidden\n") : undefined),
    ]);
    const message = await stopOf(release(flags({ yes: true }), w.io));
    expect(message).toMatch(/^A failed release is fixed with a new version, never by moving or re-pushing its tag/);
    expect(message).toContain("Run `pnpm release` again for 0.1.0-preview.2.");
    expect(w.text()).toContain(`release run v0.1.0-preview.1: failure (${RELEASE_URL})`);
    expect(w.text()).toContain("  job npm (trusted publishing): failure");
    expect(w.text()).not.toContain("job gate");
    expect(w.text()).toContain("E403 forbidden");
  });

  it("stops when no release run appears for the tag", async () => {
    const w = world([(l) => (l.startsWith("gh run list") && l.includes("release.yml") ? ok("[]") : undefined)]);
    expect(await stopOf(release(flags({ yes: true }), w.io))).toMatch(/^no release run for v0.1.0-preview.1 after 2 minutes: .* Do not move or re-push the tag\.$/);
  });
});

describe("helpers", () => {
  it("withVersion changes only the version field", () => {
    expect(withVersion(PKG("0.1.0-preview.1"), "0.1.0-preview.1", "0.1.0-preview.2")).toBe(PKG("0.1.0-preview.2"));
    expect(() => withVersion(PKG("0.1.0"), "0.2.0", "0.3.0")).toThrow(Stop);
  });

  it("withImageTag sets every pinned tag and leaves latest", () => {
    expect(withImageTag(DOC("0.1.0-preview.2") + DOC("0.1.0"), "0.1.0-preview.3")).toBe(DOC("0.1.0-preview.3") + DOC("0.1.0-preview.3"));
  });

  it("parseFlags", () => {
    expect(parseFlags(["--dry-run", "--version", "0.2.0", "--stable"])).toEqual({ dryRun: true, yes: false, stable: true, version: "0.2.0" });
    expect(() => parseFlags(["--force"])).toThrow(/Usage: pnpm release/);
  });
});
