// The local evidence chain: an append-only JSONL hash chain behind a fenced lease lock (ADR-0007, invariant 2).
export { type ChainResult, type Entry, ENTRY_KINDS, type EntryKind, GENESIS, neverLeft, NOT_SENT_REASON, parseLines, verifyChain } from "./chain.ts";
export {
  openStore,
  readChain,
  type Store,
  StoreCorruptError,
  StoreFencedError,
  type StoreFs,
  type StoreOptions,
  StoreUnsafeError,
} from "./store.ts";
