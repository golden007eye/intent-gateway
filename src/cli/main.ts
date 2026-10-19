// The `intent` / `intent-gateway` command line: parse, dispatch, and turn every failure into one line with its fix.
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { BUILD, type Config, INTENT } from "../config/index.ts";
import { startPanel } from "../panel/index.ts";
import { answerStdioWithError } from "../mcp/index.ts";
import { formatReport, type Install, runVerify } from "../verify/index.ts";
import { approverAccept, approverList } from "./approver.ts";
import { doctor } from "./doctor.ts";
import { evidence, verifyEvidenceFile } from "./evidence.ts";
import { describeError, errorContext, type ErrorContext } from "./errors.ts";
import { help } from "./help.ts";
import { CliError, type Io, line, type Outcome } from "./io.ts";
import { logCommand } from "./log.ts";
import { logFlags } from "./log-flags.ts";
import { policyAdd, policyShow, policyTest } from "./policy.ts";
import { serve } from "./serve.ts";
import { pauseCommand, pauseDeps, resumeCommand, statusCommand } from "./pause.ts";
import { pausedIn, pauseLocally, sendPause } from "../pause/index.ts";
import { openStore } from "../store/index.ts";
import { init } from "./init.ts";
import { walletCheck, walletLink, walletStatus, walletUnlink, walletWaitBudget } from "./wallet.ts";
import type { Demo } from "../demo/index.ts";
import { activePolicy, cliConfig, PACKAGE_ROOT, startDemoFor, trustedKeys } from "./setup.ts";
import { printable, printableLines } from "../ui/index.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

/** The options every command takes. Exported so tests can check the commands docs and onboarding files name. */
export const COMMON: Options = {
  demo: { type: "boolean" },
  "trust-keys": { type: "string" },
  help: { type: "boolean", short: "h" },
};

/** The options each command takes, beyond COMMON. The key is the command words joined by a space. */
export const COMMANDS: Readonly<Record<string, Options>> = {
  serve: { http: { type: "boolean" } },
  demo: { http: { type: "boolean" } },
  log: {
    verbose: { type: "boolean", short: "v" },
    json: { type: "boolean" },
    since: { type: "string" },
    action: { type: "string" },
    last: { type: "string" },
    follow: { type: "boolean", short: "f" },
    utc: { type: "boolean" },
    "no-color": { type: "boolean" },
  },
  verify: {
    install: { type: "string" },
    "pkg-dir": { type: "string" },
    image: { type: "string" },
    version: { type: "string" },
    "skip-install-check": { type: "boolean" },
    evidence: { type: "string" },
  },
  evidence: { out: { type: "string" } },
  panel: { port: { type: "string" } },
  doctor: {},
  pause: {},
  resume: {},
  status: {},
  init: { yes: { type: "boolean", short: "y" } },
  "policy test": { policy: { type: "string" } },
  "policy add": { commit: { type: "string" }, yes: { type: "boolean", short: "y" } },
  "policy show": {},
  "approver list": {},
  "approver accept": {},
  "wallet status": { "wait-budget": { type: "boolean" }, timeout: { type: "string" } },
  "wallet link": { start: { type: "boolean" }, finish: { type: "boolean" } },
  "wallet unlink": {},
  "wallet check": { since: { type: "string" } },
};

/** How many positional arguments follow the command words. */
const ARGUMENTS: Readonly<Record<string, readonly string[]>> = { evidence: ["<approval handle>"], "policy test": ["<cases.yaml>"], "policy add": ["<name>"], "wallet link": ["<rail>"], "wallet unlink": ["<rail>"], "wallet check": ["<rail>"] };

/** The commands that take a subcommand word: `policy show`, `approver list`, `wallet status`. */
const GROUPS: ReadonlySet<string> = new Set(["policy", "approver", "wallet"]);

type Values = Record<string, string | boolean | undefined>;

/** Runs one command. Never throws: failures are printed as one line on stderr and returned as the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<Outcome> {
  if (argv.length === 1 && argv[0] === "--version") {
    line(io.stdout, BUILD.version);
    return { code: 0 };
  }
  const ctx: ErrorContext = {};
  let config: Config | undefined;
  let mcpOverStdio = false;
  try {
    const parsed = parse(argv);
    if (parsed === "help") {
      io.stdout.write(help());
      return { code: 0 };
    }
    const { command, args, values } = parsed;
    const demoFlag = values.demo === true || command === "demo";
    // An MCP client started this process (serve, or demo, over stdio): a startup failure must reach the agent too.
    mcpOverStdio = (command === "serve" || command === "demo") && values.http !== true && !io.isTTY.stdin;
    // Only serve refuses an unpinned host up front; doctor reports it, and the offline commands never reach Cloud.
    config = cliConfig(io, argv, demoFlag, command === "serve");
    Object.assign(ctx, errorContext(config, io.env));
    return await run(io, config, command, args, values);
  } catch (error) {
    const described = describeError(error, ctx);
    line(io.stderr, `intent: ${printable(described)}`);
    if (mcpOverStdio) await answerStdioWithError(`intent-gateway could not start: ${described}`, io);
    if (error instanceof CliError && error.code === 2 && error.message.startsWith("unknown command")) io.stderr.write(`\n${help()}`);
    const debug = config?.debug ?? io.env.INTENT_DEBUG === "1";
    if (debug && error instanceof Error && error.stack !== undefined) line(io.stderr, error.stack);
    return { code: error instanceof CliError ? error.code : 1 };
  }
}

function parse(argv: readonly string[]): "help" | { command: string; args: string[]; values: Values } {
  // First pass, lenient: find the command words, so an unknown option can be named with its command.
  const all: Options = { ...COMMON };
  for (const options of Object.values(COMMANDS)) Object.assign(all, options);
  const loose = parseArgs({ args: [...argv], options: all, allowPositionals: true, strict: false });
  if (loose.values.help === true || loose.positionals[0] === "help") return "help";
  const [first, second] = loose.positionals;
  // No command means serve: `npx -y intent-gateway` and `intent-gateway --demo` are what an MCP client runs.
  const group = first !== undefined && GROUPS.has(first) ? first : null;
  const command = first === undefined ? "serve" : group !== null ? `${group} ${second ?? ""}`.trim() : first;
  if (!Object.hasOwn(COMMANDS, command)) {
    const what = group !== null ? `${command} needs one of: ${subcommands(group).join(", ")}` : `unknown command "${command}"`;
    throw new CliError(group !== null ? `${what}; run ${INTENT} --help` : what, 2);
  }
  // Second pass, strict: only the options this command takes.
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { ...COMMON, ...COMMANDS[command] }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError(`${optionError(error, command)}; run ${INTENT} --help`, 2);
  }
  const values = parsed.values as Values;
  const words = command.split(" ").length;
  const args = parsed.positionals.slice(first === undefined ? 0 : words);
  const expected = ARGUMENTS[command] ?? [];
  if (args.length !== expected.length) {
    const usage = [`${INTENT} ${command}`, ...expected].join(" ");
    throw new CliError(`usage: ${usage}${args.length > expected.length ? ` (unexpected "${args[expected.length] ?? ""}")` : ""}; run ${INTENT} --help`, 2);
  }
  return { command, args, values };
}

/** A util.parseArgs failure in our words: the option and the command, never its `--` advice. */
function optionError(error: unknown, command: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const option = /'(-[^' ]*)/.exec(message)?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `unknown option ${option} for ${command}`;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return `option ${option} for ${command} ${/argument missing/.test(message) ? "needs a value" : "takes no value"}`;
  }
  return `${command}: ${message.split(". ")[0] ?? message}`;
}

function subcommands(group: string): string[] {
  return Object.keys(COMMANDS)
    .filter((c) => c.startsWith(`${group} `))
    .map((c) => c.slice(group.length + 1));
}

async function run(io: Io, config: Config, command: string, args: readonly string[], values: Values): Promise<Outcome> {
  const arg = (i: number): string => args[i] ?? "";
  const str = (name: string): string | undefined => (typeof values[name] === "string" ? values[name] : undefined);
  switch (command) {
    case "serve":
    case "demo":
      return withDemo(io, config, async (demo) => {
        // `intent demo` typed at a terminal serves over HTTP, so it has something to show; an MCP client runs it over stdio.
        const http = values.http === true || (command === "demo" && io.isTTY.stdin);
        return serve(io, config, { http, demo });
      });
    case "log":
      return logCommand(io, config.dataDir, logFlags(io, values));
    case "evidence":
      return { code: await evidence(io, config.dataDir, arg(0), await trustedKeys(config), str("out")) };
    case "verify": {
      const pack = str("evidence");
      if (pack !== undefined) {
        const other = ["install", "pkg-dir", "image", "version", "skip-install-check"].find((name) => values[name] !== undefined);
        if (other !== undefined) throw new CliError(`--evidence checks a pack file only; it takes no --${other}`, 2);
        return { code: await verifyEvidenceFile(io, pack, await trustedKeys(config)) };
      }
      const chosen = install(values, str);
      const report = await runVerify({
        dataDir: config.dataDir,
        pinnedRootKeys: await trustedKeys(config),
        now: new Date((io.now ?? Date.now)()),
        ...chosen,
        // Demo mode checks the demo chain; the install's self-check runs only when asked for with --install/--image.
        ...(config.demo && values.install === undefined && values.image === undefined ? { skipSupplyChain: true, skipReason: "demo mode" } : {}),
        ...(values["skip-install-check"] === true ? { skipSupplyChain: true, skipReason: "--skip-install-check" } : {}),
      });
      io.stdout.write(printableLines(formatReport(report)));
      return { code: report.exitCode };
    }
    case "panel": {
      const port = portOption(str("port"));
      const keys = await trustedKeys(config);
      const panel = await startPanel(config.dataDir, {
        port,
        intent: INTENT,
        mode: config.demo ? "demo" : "real",
        policy: async () => {
          const active = await activePolicy(config.policyPath);
          return { policy: active.policy, source: active.bundled !== null ? `the bundled ${active.bundled} policy (no file at ${config.policyPath})` : config.policyPath };
        },
        // The chain checks of `intent verify`, offline and read-only; the install self-check stays with the command.
        verify: () =>
          runVerify({ dataDir: config.dataDir, pinnedRootKeys: keys, now: new Date((io.now ?? Date.now)()), skipSupplyChain: true, skipReason: "the panel checks the chain only" }),
        // The Pause button (ADR-0023): the local pause at once; the send to Intent Cloud goes on after the answer. In
        // demo mode the demo Intent Cloud runs with `intent demo`, whose retry sends it.
        pause: async () => {
          const store = await openStore(config.dataDir);
          try {
            if (!pausedIn(store.entries())) await pauseLocally(store, "panel");
          } catch (error) {
            await store.close();
            throw error;
          }
          if (config.demo) {
            await store.close();
            return;
          }
          const deps = pauseDeps(io, config, store, null);
          void sendPause(deps)
            .catch(() => undefined)
            .finally(() => void store.close());
        },
      });
      line(io.stdout, `panel: ${panel.url} (read-only but for the Pause button; Ctrl-C stops it)`);
      return { code: 0, stop: () => panel.close() };
    }
    case "doctor":
      return { code: await doctor(io, config) };
    case "pause":
      return { code: await pauseCommand(io, config) };
    case "resume":
      return { code: await resumeCommand(io, config) };
    case "status":
      return { code: await statusCommand(io, config) };
    case "init":
      return { code: await init(io, config, { yes: values.yes === true }) };
    case "policy test":
      return { code: await policyTest(io, config, arg(0), str("policy")) };
    case "policy add":
      return { code: await policyAdd(io, config, arg(0), { commit: str("commit"), yes: values.yes === true }) };
    case "policy show":
      return { code: await policyShow(io, config) };
    case "approver list":
      return { code: approverList(io, config.dataDir) };
    case "approver accept":
      return { code: await approverAccept(io, config.dataDir) };
    case "wallet status":
      if (values["wait-budget"] === true) return { code: await walletWaitBudget(io, config, str("timeout")) };
      if (values.timeout !== undefined) throw new CliError(`--timeout goes with --wait-budget; run ${INTENT} --help`, 2);
      return { code: await walletStatus(io, config) };
    case "wallet link":
      if (values.start === true && values.finish === true) throw new CliError(`wallet link takes --start or --finish, not both; run ${INTENT} --help`, 2);
      return { code: await walletLink(io, config, arg(0), values.start === true ? "start" : values.finish === true ? "finish" : "full") };
    case "wallet unlink":
      return { code: await walletUnlink(io, config, arg(0)) };
    case "wallet check":
      return { code: await walletCheck(io, config, arg(0), str("since")) };
    default:
      throw new CliError(`unknown command "${command}"`, 2);
  }
}

/** Runs a long-running `body` with the demo Intent Cloud in demo mode (null otherwise); its stop closes the demo. */
async function withDemo(io: Io, config: Config, body: (demo: Demo | null) => Promise<Outcome>): Promise<Outcome> {
  const demo = config.demo ? await startDemoFor(config, io) : null;
  try {
    return await body(demo);
  } catch (error) {
    await demo?.close();
    throw error;
  }
}

/** `--install npm [--pkg-dir <dir>]` or `--image <ref> --version <v>`; by default this package, unless run from source. */
function install(values: Values, str: (name: string) => string | undefined): { install?: Install } {
  const image = str("image");
  const kind = str("install");
  if (image !== undefined) {
    const version = str("version");
    if (version === undefined) throw new CliError(`--image needs --version <v>, the version the image should be; run ${INTENT} --help`, 2);
    if (kind !== undefined || values["pkg-dir"] !== undefined) throw new CliError("give --image or --install npm, not both", 2);
    return { install: { kind: "image", ref: image, version } };
  }
  if (kind !== undefined && kind !== "npm") throw new CliError(`--install takes npm, got "${kind}"; for an image use --image <ref> --version <v>`, 2);
  const pkgDir = str("pkg-dir");
  if (kind === undefined && pkgDir === undefined && BUILD.buildCommit === null && BUILD.dirty === false) return {}; // from source
  return { install: { kind: "npm", pkgDir: pkgDir ?? fileURLToPath(PACKAGE_ROOT) } };
}

function portOption(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = /^[0-9]{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 0 && port <= 65535)) throw new CliError(`--port takes a port number 0-65535, got "${value}"`, 2);
  return port;
}
