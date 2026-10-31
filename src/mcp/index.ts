// The gateway's MCP face: the three agent tools (find_offers, create_cart, get_approval_status) over stdio (npx) or
// Streamable HTTP (Docker). The tools call the gateway; the transports add no logic of their own beyond the HTTP
// token and Host/Origin checks (ADR-0005).
export { type HttpHandle, type HttpOptions, MAX_BODY_BYTES, MCP_PATH, McpHttpError, runHttp } from "./http.ts";
export { type McpHandle, runStdio, type StdioOptions } from "./stdio.ts";
export { inputJsonSchema, registerTools, TOOLS } from "./tools.ts";
