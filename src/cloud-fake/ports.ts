// Free ports for tests that start a listener through an env setting (INTENT_HTTP_PORT, INTENT_DEMO_CONFIRM_PORT),
// where the CLI refuses 0. Asking the kernel, instead of picking a number, means a process that holds 8788 or any
// other port on this machine cannot make such a test fail.
import { createServer } from "node:net";

const handedOut = new Set<number>();

/**
 * A port the kernel picked as free on every interface a moment ago, released again for the caller to bind, and never
 * the same one twice in this process (the kernel may hand a just-released port out again).
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject).listen(0, resolve);
    });
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
}
