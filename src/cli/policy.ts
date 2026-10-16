// `intent policy test | add | show`. A policy can only narrow (invariant 1): `add` writes meet(current, library),
// shows the change as a diff first, and asks before writing (or needs --yes when no one is at the terminal).
import { readFile } from "node:fs/promises";
import type { Config } from "../config/index.ts";
import { LibraryError, type Lock, planPolicy, readLock } from "../library/index.ts";
import { loadPolicy, PolicyError, runCases } from "../policy/index.ts";
import { describeError } from "./errors.ts";
import { CliError, type Io, line } from "./io.ts";
import { ask, diffLines } from "./prompt.ts";
import { activePolicy } from "./setup.ts";

/** Exit 0 when every case passes, 1 when one fails, 2 when the policy or the cases file cannot be used. */
export async function policyTest(io: Io, config: Config, casesFile: string, policyFile: string | undefined): Promise<number> {
  const policyPath = policyFile ?? config.policyPath;
  let source: string;
  let policy;
  try {
    if (policyFile === undefined) {
      const active = await activePolicy(policyPath, config.demo);
      policy = active.policy;
      source = active.bundled !== null ? `the bundled ${active.bundled} policy (no file at ${policyPath})` : policyPath;
    } else {
      policy = loadPolicy(await readText(policyFile, "--policy"));
      source = policyFile;
    }
  } catch (error) {
    if (error instanceof PolicyError) throw new CliError(describeError(error, { policyPath }), 2);
    throw error;
  }
  let results;
  try {
    results = runCases(policy, await readText(casesFile, "the cases file"));
  } catch (error) {
    if (error instanceof PolicyError) {
      throw new CliError(`cases ${casesFile}: ${error.message}; see policies/strict-default/cases.yaml for the format`, 2);
    }
    throw error;
  }
  line(io.stdout, `testing ${casesFile} against ${source}`);
  for (const r of results) {
    if (r.pass) {
      line(io.stdout, `ok    ${r.name}`);
      continue;
    }
    const got = r.decision.blocked.map((b) => b.rule);
    line(
      io.stdout,
      `FAIL  ${r.name}: expected ${verdict(r.expected.send, r.expected.blocked)}, got ${verdict(r.decision.send, got)}`,
    );
  }
  const failed = results.filter((r) => !r.pass).length;
  line(io.stdout, `${String(results.length - failed)} passed, ${String(failed)} failed`);
  return failed === 0 ? 0 : 1;
}

function verdict(send: boolean, blocked: readonly string[]): string {
  return send ? "send" : `blocked by ${blocked.length === 0 ? "nothing" : [...blocked].sort().join(", ")}`;
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new CliError(`${what} ${path} cannot be read (${code}); check the path`, 2);
  }
}

export interface AddFlags {
  commit: string | undefined;
  yes: boolean;
}

export async function policyAdd(io: Io, config: Config, name: string, flags: AddFlags): Promise<number> {
  const { policyPath } = config;
  const plan = await planPolicy(name, {
    policyPath,
    ...(flags.commit === undefined ? {} : { commit: flags.commit }),
    ...io.library,
  });
  line(io.stdout, `policy add ${name}, from ${origin(plan.lock)}, into ${policyPath}:`);
  if (plan.before === plan.after) {
    line(io.stdout, `no change: ${policyPath} is already at least as strict as ${name}; recording it in policy.lock`);
  } else {
    if (plan.before === undefined) line(io.stdout, "(new file)");
    for (const diff of diffLines(plan.before ?? "", plan.after)) line(io.stdout, diff);
    if (!flags.yes) {
      if (!io.isTTY.stdin) {
        throw new CliError("not applied: stdin is not a terminal, so no one can confirm the change; re-run with --yes to apply it", 2);
      }
      const answer = (await ask(io, "Apply this change? [y/N] "))?.trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        line(io.stdout, "not applied; nothing was written");
        return 1;
      }
    }
  }
  const lock = await plan.apply();
  line(io.stdout, `applied: ${policyPath} now includes ${name}; policy.lock records ${origin(lock)}`);
  line(io.stdout, "a running gateway reads its policy at start: restart intent serve to use it");
  return 0;
}

function origin(lock: Lock): string {
  return lock.source === "bundled" ? `the library bundled with this gateway (commit ${lock.commit})` : `GitHub commit ${lock.commit}`;
}

/** The active policy and its lock. Exit 1 when the lock does not describe the policy file. */
export async function policyShow(io: Io, config: Config): Promise<number> {
  const { policyPath } = config;
  const active = await activePolicy(policyPath, config.demo);
  let code = 0;
  if (active.bundled !== null) {
    line(io.stdout, `no policy file at ${policyPath}: the gateway uses the bundled ${active.bundled} policy`);
    line(io.stdout, "intent policy add <name> writes one, narrowed with a library policy");
  } else {
    line(io.stdout, `policy: ${policyPath}`);
    try {
      const lock = await readLock(policyPath);
      if (lock === undefined) {
        line(io.stdout, "lock: none (this policy.yaml was not written by intent policy add)");
      } else {
        line(io.stdout, `lock: ${lock.name} from ${origin(lock)}`);
        line(io.stdout, `  library policy sha256 ${lock.sha256}`);
        line(io.stdout, `  policy.yaml sha256 ${lock.policy_sha256} (matches the file)`);
      }
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      line(io.stdout, `lock: ${describeError(error)}`);
      code = 1;
    }
  }
  line(io.stdout, "---");
  io.stdout.write(active.text.endsWith("\n") ? active.text : `${active.text}\n`);
  return code;
}
