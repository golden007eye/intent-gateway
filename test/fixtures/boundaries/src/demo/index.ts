// Allowed: demo mode loads the fake Intent Cloud and serves its confirm page over HTTP.
import { createServer } from "node:http";
import { fake } from "../cloud-fake/index.ts";

export const demo = [typeof createServer, fake];
