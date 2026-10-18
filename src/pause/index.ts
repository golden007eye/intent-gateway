// Pause (ADR-0023): stop every purchase through the gateway that is not paid yet, locally at once and at Intent Cloud
// through the disclosure log; resume needs the buyer's passkey on the confirm page. State is read from the chain alone.
export {
  type AccountKey,
  type AccountKeySource,
  isPausedAnswer,
  noteSubmitAnswer,
  pauseLocally,
  type PauseRetry,
  type PauseTransport,
  refuseForPause,
  resumeLocally,
  type SendDeps,
  sendPause,
  type SendOutcome,
  signPause,
  startPauseRetry,
} from "./pause.ts";
export {
  confirmOrigin,
  nextCounter,
  nextSendAt,
  pauseProblems,
  type PauseEntry,
  pausedIn,
  pauseReasonWords,
  type PauseSource,
  type PauseState,
  pauseState,
  type SendReason,
  type SendResult,
  stoppedPurchases,
  type StoppedPurchase,
} from "./state.ts";
