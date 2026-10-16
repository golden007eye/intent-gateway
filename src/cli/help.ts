// `intent --help`: short and example-led. The test pins it as a snapshot.
import { npxPackage } from "../config/index.ts";

const NPX = npxPackage();

export const HELP = `intent-gateway: the gateway between your agent and Intent Cloud.

Try it now, with no setup (demo Intent Cloud on this machine, test keys, nothing can be bought):
  npx -y ${NPX} demo

Connect an agent:
  claude mcp add intent -- npx -y ${NPX} demo     the demo
  claude mcp add intent -- npx -y ${NPX} --trust-keys <file>

Commands:
  intent serve [--http]             MCP server over stdio (the default), or Streamable HTTP
  intent log                        what was sent, blocked and approved, field by field
  intent verify                     re-check the chain, receipts, approvals and this install
  intent panel [--port <n>]         read-only local page: pending approvals, approver pin
  intent doctor                     check the setup; each problem comes with its fix
  intent policy show                the active policy and its policy.lock
  intent policy add <name> [--yes]  narrow the policy with a library policy (shows the diff first)
  intent policy test <cases.yaml>   run test cases against the active policy
  intent approver list              approver pins and flagged passkeys
  intent approver accept            make a flagged passkey the approver (at a terminal)
  intent demo                       run against a local demo Intent Cloud

Options for every command:
  --demo               use the demo Intent Cloud and the demo data dir (<data dir>/demo)
  --trust-keys <file>  root keys for the Intent Cloud host: {"rootKeys":[{"kid":…,"jwk":…}]}
  --help, --version

With no policy file the bundled zip-only policy applies: the only detail about you it sends is your ZIP code.
intent policy add strict-default (or another library policy) narrows it.

Settings: INTENT_DATA_DIR, INTENT_POLICY, INTENT_CLOUD_URL, INTENT_HTTP_HOST, INTENT_HTTP_PORT,
INTENT_HTTP_TOKEN, INTENT_DEMO=1, INTENT_DEBUG=1 (stack traces).
`;
