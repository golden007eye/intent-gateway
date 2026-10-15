// Bypass: read fetch off the global object with a computed key.
export const usesGlobalIndex = globalThis["fetch"];
