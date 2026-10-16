// Intent Cloud hosts that cannot be reached, for tests of what the gateway says then: a host name with no DNS
// record (as the staging host has before it opens) and a host that accepts a connection and never answers. Neither
// reaches any network beyond this machine.
import { Agent } from "node:https";
import { createServer, type Socket } from "node:net";

/** An https agent whose every host-name lookup fails as for a name with no DNS record (ENOTFOUND). */
export function noDnsAgent(): Agent {
  const lookup = (hostname: string, _options: unknown, callback: (error: Error) => void): void => {
    callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname }));
  };
  return new Agent({ lookup } as ConstructorParameters<typeof Agent>[0]);
}

export interface SilentHost {
  /** `http://127.0.0.1:<port>`: accepts connections and never answers. */
  url: string;
  close(): Promise<void>;
}

/** A host on 127.0.0.1 that accepts every connection and never sends a byte. */
export async function startSilentHost(): Promise<SilentHost> {
  const held: Socket[] = [];
  const server = createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of held) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
