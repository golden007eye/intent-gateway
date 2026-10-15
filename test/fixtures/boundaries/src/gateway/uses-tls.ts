// Bypass: a TLS socket instead of node:https.
import { connect } from "node:tls";

export const usesTls = typeof connect;
