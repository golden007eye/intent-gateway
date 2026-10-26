// What demo mode tells the developer: a banner on stderr and on every tool result, and the exact next steps.
import { INTENT } from "../config/index.ts";

export const DEMO_BANNER = "DEMO: test keys, sample catalog, nothing can be bought.";

export interface NextStepsOptions {
  /**
   * The MCP Streamable HTTP endpoint when the demo serves HTTP (`--http`); stdio otherwise. `"above"` in the Docker
   * image: the entrypoint already printed the one connect line, with the real token, so none is repeated here.
   */
  http?: { url: string; token: string | null } | "above";
  /** The command that runs this gateway (config INTENT): `npx -y <spec>`, `node /abs/dist/main.js`, `intent`. */
  intent?: string;
  /** The demo code the confirm page's Approve needs, and the file that keeps it (Demo.code, Demo.codeFile). */
  code?: { code: string; file: string };
  /**
   * The confirm page's origin, `http://127.0.0.1:<port>`, and the port asked for when it was taken and a free one
   * was used instead (Demo.confirmPortBusy).
   */
  confirm?: { origin: string; busy: number | null };
}

/** The lines printed on stderr when the demo starts, ready to paste. Never put in a tool result: they hold the code. */
export function nextSteps(options: NextStepsOptions = {}): string[] {
  const intent = options.intent ?? INTENT;
  const { http, confirm } = options;
  const add =
    http === undefined
      ? `claude mcp add intent -- ${intent} demo`
      : http === "above"
        ? null
        : `claude mcp add --transport http intent ${http.url}` + (http.token === null ? "" : ` --header "Authorization: Bearer ${http.token}"`);
  return [
    DEMO_BANNER,
    ...(add === null ? ["Add the demo gateway to Claude Code with the claude mcp add line above."] : ["Add the demo gateway to Claude Code:", `  ${add}`]),
    "Then ask your agent to find something to buy (for example stickers to ZIP 94107 in the US, under $20).",
    "When it prepares a cart, open the approval link, enter the demo code and click \"Approve $… with demo passkey\",",
    "then ask the agent to check the approval status.",
    ...(confirm === undefined ? [] : confirmLines(confirm)),
    ...(options.code === undefined
      ? []
      : [`Demo code for the confirm page: ${options.code.code} (new on every start; also in ${options.code.file}; never sent to the agent)`]),
    `Re-check what was sent afterwards with: ${intent} verify --demo`,
  ];
}

/** Where the approval links point, with the SSH forward for a developer whose browser is on another machine. */
function confirmLines(confirm: { origin: string; busy: number | null }): string[] {
  const port = new URL(confirm.origin).port;
  const busy =
    confirm.busy === null
      ? []
      : [`Port ${String(confirm.busy)} is taken (another demo running?), so the confirm page uses ${port}; set INTENT_DEMO_CONFIRM_PORT to choose one.`];
  return [...busy, `Approval links open the demo confirm page at ${confirm.origin} (over SSH, forward it: ssh -L ${port}:127.0.0.1:${port} <host>)`];
}
