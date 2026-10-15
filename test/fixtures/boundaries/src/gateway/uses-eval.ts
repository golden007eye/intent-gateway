// Bypass: eval and the Function constructor hide fetch from every other rule.
export const usesEval: unknown = eval("fetch");
export const usesFunction = Function("return fetch");
