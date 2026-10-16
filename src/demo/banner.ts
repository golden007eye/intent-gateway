// What demo mode tells the developer: a banner on stderr and on every tool result, and the exact next steps.
import { npxPackage } from "../config/index.ts";

export const DEMO_BANNER = "DEMO: test keys, sample catalog, nothing can be bought.";

export interface NextStepsOptions {
  /** The MCP Streamable HTTP endpoint when the demo serves HTTP (`--http`); stdio otherwise. */
  http?: { url: string; token: string | null };
  /** The gateway version the npx line names a release line for; defaults to this build's. */
  version?: string;
}

/** The lines printed on stderr when the demo starts, ready to paste. */
export function nextSteps(options: NextStepsOptions = {}): string[] {
  const add =
    options.http === undefined
      ? `claude mcp add intent -- npx -y ${npxPackage(options.version)} demo`
      : `claude mcp add --transport http intent ${options.http.url}` +
        (options.http.token === null ? "" : ` --header "Authorization: Bearer ${options.http.token}"`);
  return [
    DEMO_BANNER,
    "Add the demo gateway to Claude Code:",
    `  ${add}`,
    "Then ask your agent to find something to buy (for example running shoes to ZIP 94103, under $200).",
    "When it prepares a cart, open the approval link, click Approve, and ask the agent to check the approval status.",
    "Re-check what was sent afterwards with: intent verify --demo",
  ];
}
