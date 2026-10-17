// Request signing (contract appendix C): the per-session Ed25519 key and the RFC 9421 profile every
// gateway → Intent Cloud request carries, and the per-approval completer keys kept on disk (contract 1.6.0,
// ADR-0016). verifyRequest is the verifier side, used by the fake Cloud and tests.
export {
  createCompleterKey,
  createSession,
  type Session,
  sessionFromPem,
  sessionFromSeed,
  type SignedHeaders,
  SigningError,
  type SignInput,
  signRequest,
} from "./sign.ts";
export { COMPLETER_DIR, type CompleterKey, CompleterKeyError, type CompleterKeys, openCompleterKeys } from "./completer.ts";
export { contentDigest, isEd25519PublicKey } from "./profile.ts";
export {
  createNonceCache,
  type NonceCache,
  type RejectCode,
  type Verified,
  type VerifyResult,
  verifyRequest,
} from "./verify.ts";
