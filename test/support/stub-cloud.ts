// A local node:http stand-in for Intent Cloud that records every byte each connection received, for the disclosure
// tests (which may not open sockets themselves: src/ outside the network modules cannot import node:http).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface StubReply {
  status: number;
  headers?: [string, string][];
  body?: string;
}

/** A reply, or "reset" to destroy the connection without answering. */
export type StubHandler = (req: IncomingMessage) => StubReply | "reset";

export interface StubCloud {
  baseUrl: string;
  /** Raw bytes of every connection, in arrival order: the request line, the header block and the body. */
  connections: Buffer[];
  /** The request bodies, in arrival order. */
  bodies: Buffer[];
  handler: StubHandler;
  close(): Promise<void>;
}

export async function startStubCloud(handler: StubHandler): Promise<StubCloud> {
  const sockets: Socket[] = [];
  const stub: StubCloud = { baseUrl: "", connections: [], bodies: [], handler, close: () => Promise.resolve() };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      stub.bodies.push(Buffer.concat(chunks));
      const reply = stub.handler(req);
      if (reply === "reset") {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, reply.headers?.flat() ?? []);
      res.end(reply.body);
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.push(socket);
    const index = stub.connections.push(Buffer.alloc(0)) - 1;
    socket.on("data", (chunk: Buffer) => {
      stub.connections[index] = Buffer.concat([stub.connections[index] ?? Buffer.alloc(0), chunk]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        resolve();
      });
    });
  return stub;
}
