// What every command gets from the outside world. main.ts passes the real process streams; tests pass their own,
// which is how `approver accept` is tested without a pseudo-terminal (R3-6).
import type { AddOptions } from "../library/index.ts";
import type { DisclosedCloud, DisclosureOptions, HttpCloudOptions } from "../disclosure/index.ts";
import type { Store } from "../store/index.ts";

export interface Writer {
  write(text: string): unknown;
}

export interface Io {
  env: Readonly<Record<string, string | undefined>>;
  stdin: NodeJS.ReadableStream;
  stdout: Writer;
  stderr: Writer;
  /** Whether stdin and stdout are terminals. `approver accept` refuses unless both are. */
  isTTY: { stdin: boolean; stdout: boolean };
  cwd?: string;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
  /** The Node version doctor checks (process.versions.node by default). */
  nodeVersion?: string;
  /** Test seams: the library's commit and fetch, and the disclosed cloud doctor and serve connect through. */
  library?: Pick<AddOptions, "buildCommit" | "dirty" | "fetch" | "bundledRoot">;
  connect?: (http: HttpCloudOptions, store: Store, options: DisclosureOptions) => DisclosedCloud;
}

/** What a command returns: its exit code, and for a long-running one (serve, panel) how to stop it. */
export interface Outcome {
  code: number;
  stop?: () => Promise<void>;
}

/**
 * A failure the CLI has already worded for the user: what failed and the command or setting that fixes it. The
 * top level prints the message as one line and exits with `code`.
 */
export class CliError extends Error {
  override name = "CliError";
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

export function line(out: Writer, text = ""): void {
  out.write(`${text}\n`);
}
