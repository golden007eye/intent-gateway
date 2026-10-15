// Bypass: a UDP socket, through the bare specifier.
import { createSocket } from "dgram";

export const usesDgram = typeof createSocket;
