// `intent --help`: short and example-led. The test pins it as a snapshot. Every command in it starts with the
// invocation that works for this install (INTENT): `npx -y <spec>`, `node /abs/dist/main.js`, or `intent`. A long
// invocation (a tarball or source path) is named once above the command list instead of on every line.
import { INTENT } from "../config/index.ts";

/** The longest invocation still printed on every line of the command list. */
const INLINE_MAX = 30;

export function help(intent: string = INTENT): string {
  const inline = intent.length <= INLINE_MAX;
  const width = inline ? 36 + intent.length - "intent".length : 30;
  const pad = (command: string): string => `  ${inline ? `${intent} ` : ""}${command}`.padEnd(width);
  return `intent-gateway: the gateway between your agent and Intent Cloud.

Try it now, with no setup (demo Intent Cloud on this machine, test keys, nothing can be bought):
  ${intent} demo

Connect an agent:
  claude mcp add intent -- ${intent} demo     the demo
  claude mcp add intent -- ${intent} --trust-keys <file>

${inline ? "Commands:" : `Commands (run each as: ${intent} <command>):`}
${pad("serve [--http]")}MCP server over stdio (the default), or Streamable HTTP
${pad("log")}what was sent, blocked and approved, field by field
${pad("verify")}re-check the chain, receipts, approvals and this install
${"".padEnd(width)}(--skip-install-check: chain only, for offline use)
${pad("panel [--port <n>]")}read-only local page: pending approvals, approver pin
${pad("doctor")}check the setup; each problem comes with its fix
${pad("policy show")}the active policy and its policy.lock
${pad("policy add <name> [--yes]")}narrow the policy with a library policy (shows the diff first)
${pad("policy test <cases.yaml>")}run test cases against the active policy
${pad("approver list")}approver pins and flagged passkeys
${pad("approver accept")}make a flagged passkey the approver (at a terminal)
${pad("demo [--http]")}run against a local demo Intent Cloud (HTTP when typed in a terminal)

Options for every command:
  --demo               use the demo Intent Cloud and the demo data dir (<data dir>/demo)
  --trust-keys <file>  root keys for the Intent Cloud host: {"rootKeys":[{"kid":…,"jwk":…}]}
  --help, --version

With no policy file the bundled zip-only policy applies: the only detail about you it sends is your ZIP code.
${intent} policy add per-order-60 (or another library policy) narrows it, here to $60 a cart.

Settings: INTENT_DATA_DIR, INTENT_POLICY, INTENT_CLOUD_URL, INTENT_HTTP_HOST, INTENT_HTTP_PORT,
INTENT_HTTP_TOKEN, INTENT_DEMO=1, INTENT_DEBUG=1 (stack traces).
`;
}
