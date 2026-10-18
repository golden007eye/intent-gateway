// Free ports for tests that start a listener through an env setting (INTENT_HTTP_PORT, INTENT_DEMO_CONFIRM_PORT),
// where the CLI refuses 0. The port is checked free, released, then bound by the code under test a moment later.
// A port the kernel picked for listen(0) could be handed to any other listener or outgoing connection in that moment
// (another vitest worker starts fake clouds all the time): that made a demo exit 1 with EADDRINUSE about once in a
// thousand runs. So freePort hands out ports below every default ephemeral range (Linux 32768-60999, macOS and
// Windows 49152-65535), which the kernel never picks on its own, from a block of its own for each vitest worker.
import { createServer } from "node:net";

/** The ports freePort hands out: below every default ephemeral range, never 8788 or another fixed gateway port. */
export const FREE_PORT_RANGE = { first: 20000, last: 31999 } as const;
const BLOCK = 200;
const BLOCKS = (FREE_PORT_RANGE.last - FREE_PORT_RANGE.first + 1) / BLOCK;

// VITEST_POOL_ID is 1..maxWorkers and unique among the workers running at one time.
const pool = Number.parseInt(process.env.VITEST_POOL_ID ?? "1", 10);
const base = FREE_PORT_RANGE.first + ((Number.isInteger(pool) && pool > 0 ? pool - 1 : 0) % BLOCKS) * BLOCK;
let next = 0;

function canListen(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * A port of this worker's block that was free on every interface a moment ago, released again for the caller to
 * bind. Successive calls walk the block, so the same port comes back only after the other 199 were handed out.
 */
export async function freePort(): Promise<number> {
  for (let tried = 0; tried < BLOCK; tried++) {
    const port = base + (next++ % BLOCK);
    if (await canListen(port)) return port;
  }
  throw new Error(`freePort: no free port in ${String(base)}-${String(base + BLOCK - 1)}`);
}
