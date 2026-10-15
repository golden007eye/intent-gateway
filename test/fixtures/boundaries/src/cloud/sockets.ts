// Allowed: src/cloud may open any kind of connection, also through a literal dynamic import.
import { connect } from "node:tls";

export const sockets = [typeof connect, import("node:https")];
