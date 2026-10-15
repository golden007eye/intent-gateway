// Allowed: the fake Intent Cloud may serve HTTP and call fetch.
import { createServer } from "node:http";

export const fake = [typeof createServer, typeof fetch];
