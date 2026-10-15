// Violates panel-offline transitively: panel -> relay -> disclosure -> cloud.
import { relay } from "../relay/index.ts";

export const transitive = relay;
