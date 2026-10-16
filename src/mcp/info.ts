import { BUILD } from "../config/index.ts";

/** How the gateway names itself to an MCP client. */
export const SERVER_INFO = { name: "intent-gateway", version: BUILD.version } as const;
