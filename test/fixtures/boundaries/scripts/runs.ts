// Allowed: repo tooling under scripts/ may run other processes.
import { execFileSync } from "node:child_process";

export const runs = typeof execFileSync;
