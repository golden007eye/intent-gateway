// Allowed: the fake Shop wallet may serve HTTP.
import { createServer } from "node:http";

export const walletFake = typeof createServer;
