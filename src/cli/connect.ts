// The one connect line in the Docker image, printed by the gateway once it is serving, so a container that cannot
// start never prints a line to paste. The entrypoint makes the token in <data>/http-token and, when it is new and
// may be printed, leaves <data>/http-token.unshown beside it. The first start that serves prints the token in the
// line and removes the marker; later starts print a line that reads the token from the container when pasted.
import { readFileSync, rmSync } from "node:fs";

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
      "intent-gateway: Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787):",
      line(token),
      "intent-gateway: The connect line above holds the token, so it is also kept in this container's log (docker logs). Later starts reuse the token and do not print it again; set INTENT_QUIET_TOKEN=1 to never print it.",
    ];
  }
  if (fromFile) {
    return [
      "intent-gateway: Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787; the line reads the token from the container):",
      line(`$(${dockerExec} cat ${tokenFile})`),
    ];
  }
  return [
    "intent-gateway: Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787; the line reads your INTENT_HTTP_TOKEN from the container):",
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
