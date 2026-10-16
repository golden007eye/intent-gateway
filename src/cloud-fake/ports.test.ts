import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { freePort } from "./ports.ts";

describe("freePort", () => {
  it("hands out distinct ports that can be bound on every interface", async () => {
    const ports = [await freePort(), await freePort(), await freePort()];
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
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
});
