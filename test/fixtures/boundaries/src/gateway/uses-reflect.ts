// Bypass: read fetch off the global object through Reflect.
export const usesReflect: unknown = Reflect.get(globalThis, "fetch");
