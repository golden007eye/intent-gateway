// Bypass: Node's `global` alias of the global object.
export const usesGlobalAlias = global.fetch;
