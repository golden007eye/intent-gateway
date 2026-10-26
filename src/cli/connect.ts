// The one connect line in the Docker image, printed by the gateway once it is serving, so a container that cannot
// start never prints a line to paste. The entrypoint makes the token in <data>/http-token and, when it is new and
// may be printed, leaves <data>/http-token.unshown beside it. The first start that serves prints the token in the
// line and removes the marker; later starts print a line that reads the token from the container when pasted.
// On a host, `intent init` prints hostConnect's line instead: the gateway over stdio, with the settings it was run
// with, so the agent's gateway uses the same data dir, policy, Intent Cloud and Shop client.
import { readFileSync, rmSync } from "node:fs";

/** Settings the agent's gateway must share with the one `init` ran as; INTENT_WALLET_KEY is left out, as a secret. */
const SHARED_SETTINGS = ["INTENT_DATA_DIR", "INTENT_POLICY", "INTENT_CLOUD_URL", "INTENT_WALLET_KEY_FILE", "INTENT_SHOP_CLIENT_ID", "INTENT_SHOP_MCP_URL", "INTENT_SHOP_AUTH_URL"];

/** The `claude mcp add` line for a gateway on this host, over stdio. `args` follow the invocation (`--trust-keys <file>`). */
export function hostConnect(intent: string, env: Readonly<Record<string, string | undefined>>, args: readonly string[] = []): string {
  const settings = SHARED_SETTINGS.flatMap((name) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [`-e ${name}=${shellWord(value)}`];
  });
  return ["claude mcp add intent", ...settings, "--", intent, ...args.map(shellWord)].join(" ");
}

/** `value` as one shell word: as it is when it is plain, else in single quotes. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ConnectInput {
  /** The token the server checks (INTENT_HTTP_TOKEN, which the entrypoint sets from the token file). */
  token: string;
  /** The entrypoint's token file, <data>/http-token. */
  tokenFile: string;
  /** INTENT_QUIET_TOKEN=1: never print the token. */
  quiet: boolean;
  /** `docker exec <this container>` (DOCKER_EXEC). */
  dockerExec: string;
  /** Reads a file as text, or null. Defaults to readFileSync. */
  readText?: (path: string) => string | null;
  /** Removes a file. Defaults to rmSync. */
  remove?: (path: string) => void;
}

/** The marker the entrypoint leaves beside a new token that has not been printed yet. */
export const unshownMarker = (tokenFile: string): string => `${tokenFile}.unshown`;

/** The lines to print on stderr, prefixed by the caller. Removes the marker once the token is in them. */
export function containerConnect(input: ConnectInput): string[] {
  const readText = input.readText ?? readOrNull;
  const { token, tokenFile, dockerExec } = input;
  const line = (bearer: string): string =>
    `  claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer ${bearer}"`;
  const fromFile = readText(tokenFile)?.trim() === token;
  if (fromFile && !input.quiet && readText(unshownMarker(tokenFile)) !== null) {
    (input.remove ?? removeFile)(unshownMarker(tokenFile));
    return [
      "intent: Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787):",
      line(token),
      "intent: The connect line above holds the token, so it is also kept in this container's log (docker logs). Later starts reuse the token and do not print it again; set INTENT_QUIET_TOKEN=1 to never print it.",
    ];
  }
  if (fromFile) {
    return [
      "intent: Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787; the line reads the token from the container):",
      line(`$(${dockerExec} cat ${tokenFile})`),
    ];
  }
  return [
    "intent: Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787; the line reads your INTENT_HTTP_TOKEN from the container):",
    line(`$(${dockerExec} printenv INTENT_HTTP_TOKEN)`),
  ];
}

function removeFile(path: string): void {
  rmSync(path, { force: true });
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
