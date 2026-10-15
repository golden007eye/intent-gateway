// Violates the child_process ban, which holds in a network module too.
import { spawn } from "node:child_process";

export const spawns = typeof spawn;
