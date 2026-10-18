// The `intent` command line (plan §3.2 `cli`): serve, log, verify, panel, policy, approver, doctor and demo. main()
// takes its streams and environment as an Io, so every command is testable without a terminal or a child process.
export { COMMANDS, COMMON, main } from "./main.ts";
export { CliError, type Io, type Outcome, type Writer } from "./io.ts";
export { describeError, type ErrorContext } from "./errors.ts";
export { formatLog } from "./log.ts";
export { help } from "./help.ts";
