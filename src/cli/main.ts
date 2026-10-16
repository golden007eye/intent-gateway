// The `intent` / `intent-gateway` command line: parse, dispatch, and turn every failure into one line with its fix.
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { BUILD, type Config, INTENT } from "../config/index.ts";
import { startPanel } from "../panel/index.ts";
import { answerStdioWithError } from "../mcp/index.ts";
import { formatReport, type Install, runVerify } from "../verify/index.ts";
import { approverAccept, approverList } from "./approver.ts";
import { doctor } from "./doctor.ts";
import { describeError, type ErrorContext } from "./errors.ts";
import { help } from "./help.ts";
import { CliError, type Io, line, type Outcome } from "./io.ts";
import { formatLog, readLog } from "./log.ts";
import { policyAdd, policyShow, policyTest } from "./policy.ts";
import { serve } from "./serve.ts";
import type { Demo } from "../demo/index.ts";
import { cliConfig, PACKAGE_ROOT, startDemoFor, trustedKeys } from "./setup.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON: Options = {
  demo: { type: "boolean" },
  "trust-keys": { type: "string" },
  help: { type: "boolean", short: "h" },
};

/** The options each command takes, beyond COMMON. The key is the command words joined by a space. */
const COMMANDS: Readonly<Record<string, Options>> = {
  serve: { http: { type: "boolean" } },
  demo: { http: { type: "boolean" } },
  log: {},
  verify: {
    install: { type: "string" },
    "pkg-dir": { type: "string" },
    image: { type: "string" },
    version: { type: "string" },
    "skip-install-check": { type: "boolean" },
  },
  panel: { port: { type: "string" } },
  doctor: {},
  "policy test": { policy: { type: "string" } },
  "policy add": { commit: { type: "string" }, yes: { type: "boolean", short: "y" } },
  "policy show": {},
  "approver list": {},
  "approver accept": {},
};

/** How many positional arguments follow the command words. */
const ARGUMENTS: Readonly<Record<string, readonly string[]>> = { "policy test": ["<cases.yaml>"], "policy add": ["<name>"] };

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
    Object.assign(ctx, { dataDir: config.dataDir, policyPath: config.policyPath, cloudUrl: config.cloud.url });
    return await run(io, config, command, args, values);
  } catch (error) {
    const described = describeError(error, ctx);
    line(io.stderr, `intent: ${described}`);
    if (mcpOverStdio) await answerStdioWithError(`intent-gateway could not start: ${described}`, io);
    if (error instanceof CliError && error.code === 2 && error.message.startsWith("unknown command")) io.stderr.write(`\n${help()}`);
    const debug = config?.debug ?? io.env.INTENT_DEBUG === "1";
    if (debug && error instanceof Error && error.stack !== undefined) line(io.stderr, error.stack);
    return { code: error instanceof CliError ? error.code : 1 };
  }
}

function parse(argv: readonly string[]): "help" | { command: string; args: string[]; values: Values } {
  const all: Options = { ...COMMON };
  for (const options of Object.values(COMMANDS)) Object.assign(all, options);
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: all, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError(`${error instanceof Error ? error.message : String(error)}; run ${INTENT} --help`, 2);
  }
  const values = parsed.values as Values;
  if (values.help === true || parsed.positionals[0] === "help") return "help";
  const [first, second] = parsed.positionals;
  // No command means serve: `npx -y intent-gateway` and `intent-gateway --demo` are what an MCP client runs.
  const command = first === undefined ? "serve" : first === "policy" || first === "approver" ? `${first} ${second ?? ""}`.trim() : first;
  if (!Object.hasOwn(COMMANDS, command)) {
    const what = first === "policy" || first === "approver" ? `${command} needs one of: ${subcommands(first).join(", ")}` : `unknown command "${command}"`;
    throw new CliError(first === "policy" || first === "approver" ? `${what}; run ${INTENT} --help` : what, 2);
  }
  const words = command.split(" ").length;
  const args = parsed.positionals.slice(first === undefined ? 0 : words);
  const expected = ARGUMENTS[command] ?? [];
  if (args.length !== expected.length) {
    const usage = [`${INTENT} ${command}`, ...expected].join(" ");
    throw new CliError(`usage: ${usage}${args.length > expected.length ? ` (unexpected "${args[expected.length] ?? ""}")` : ""}; run ${INTENT} --help`, 2);
  }
  const allowed = { ...COMMON, ...COMMANDS[command] };
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(allowed, name)) throw new CliError(`${INTENT} ${command} does not take --${name}; run ${INTENT} --help`, 2);
  }
  return { command, args, values };
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
      io.stdout.write(formatLog(readLog(config.dataDir)));
      return { code: 0 };
    case "verify": {
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
      io.stdout.write(formatReport(report));
      return { code: report.exitCode };
    }
    case "panel": {
      const port = portOption(str("port"));
      const panel = await startPanel(config.dataDir, { port });
      line(io.stdout, `panel: ${panel.url} (read-only; Ctrl-C stops it)`);
      return { code: 0, stop: () => panel.close() };
    }
    case "doctor":
      return { code: await doctor(io, config) };
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
  if (kind === undefined && pkgDir === undefined && BUILD.buildCommit === null && !BUILD.dirty) return {}; // from source
  return { install: { kind: "npm", pkgDir: pkgDir ?? fileURLToPath(PACKAGE_ROOT) } };
}

function portOption(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = /^[0-9]{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 0 && port <= 65535)) throw new CliError(`--port takes a port number 0-65535, got "${value}"`, 2);
  return port;
}
