// Bypass: shell out to curl.
import { execFileSync } from "node:child_process";

export const usesChildProcess = typeof execFileSync;
