import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { FREE_PORT_RANGE, freePort } from "./ports.ts";

describe("freePort", () => {
  it("hands out distinct ports that can be bound on every interface", async () => {
    const ports = [await freePort(), await freePort(), await freePort()];
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(FREE_PORT_RANGE.first);
      expect(port).toBeLessThanOrEqual(FREE_PORT_RANGE.last);
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject).listen(port, resolve);
      });
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("skips a port something already holds", async () => {
    const first = await freePort();
    // Hold the port the next call would try, as another process could.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject).listen(first + 1, resolve);
    });
    try {
      const port = await freePort();
      expect(port).not.toBe(first + 1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  // The point of the range: the kernel never picks these ports for listen(0) or a connection, so no other listener
  // can take one between freePort's check and the caller's bind. On Linux the range must stay below the host's.
  it.runIf(process.platform === "linux")("stays below this host's ephemeral port range", () => {
    const [low = 0] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
    expect(FREE_PORT_RANGE.last).toBeLessThan(low);
  });
});
