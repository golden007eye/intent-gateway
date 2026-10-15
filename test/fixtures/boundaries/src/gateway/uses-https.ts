// Violates the node:https restriction.
import { request } from "node:https";

export const usesHttps = typeof request;
