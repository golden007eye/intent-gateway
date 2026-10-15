// Bypass: an HTTP/2 client instead of node:https.
import { connect } from "node:http2";

export const usesHttp2 = typeof connect;
