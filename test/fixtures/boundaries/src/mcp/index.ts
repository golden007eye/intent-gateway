// Allowed: src/mcp may listen on a socket.
import { createServer } from "node:net";

export const mcp = typeof createServer;
