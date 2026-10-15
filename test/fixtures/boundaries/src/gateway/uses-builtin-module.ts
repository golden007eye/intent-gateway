// Bypass: load node:net without any import.
export const usesBuiltinModule = process.getBuiltinModule("node:net");
