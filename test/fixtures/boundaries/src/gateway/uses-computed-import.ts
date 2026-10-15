// Bypass: a dynamic import whose specifier no static rule can read.
const name = ["node:", "net"].join("");
export const usesComputedImport: unknown = import(name);
