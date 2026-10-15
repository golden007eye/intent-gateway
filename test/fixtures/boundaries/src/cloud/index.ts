// Allowed: src/cloud may open connections.
import { request } from "node:https";

export const cloud = typeof request;
