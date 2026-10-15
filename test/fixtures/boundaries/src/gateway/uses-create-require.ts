// Bypass: load node:net through a CommonJS require.
import { createRequire } from "node:module";

export const usesCreateRequire = createRequire(import.meta.url)("node:net") as unknown;
