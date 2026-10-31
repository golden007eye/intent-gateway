// A reader without the lease (the panel, `intent verify`, a second gateway's entries()) can read the log while another
// process's append is mid-copy, so the file ends in the first bytes of a line. Invariant 2: the log is the developer's
// proof, so that in-flight append must read as the entry it becomes, never as corruption; src/store/store.test.ts
// checks that a fragment that stays is still reported. The second writer is a real process, as in production.
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openStore, readChain, verifyChain } from "../src/store/index.ts";

// Starting a second Node process on a loaded CI runner can take seconds.
vi.setConfig({ testTimeout: 30_000 });

// Waits for the log to end in a fragment, then finishes the line 10 ms later and releases the lease, as a writer whose
// write(2) was caught mid-copy would.
const WRITER = `
const fs = require("node:fs");
const [file, lock, rest] = process.argv.slice(1);
process.stdout.write("ready\\n");
const poll = setInterval(() => {
  if (fs.readFileSync(file, "utf8").endsWith("\\n")) return;
  clearInterval(poll);
  setTimeout(() => { fs.appendFileSync(file, rest); fs.unlinkSync(lock); process.stdout.write("done\\n"); }, 10);
}, 1);
`;

it("waits for another process's append in flight, under its lease, and reads the completed line", async () => {
  const dir = join(await fsp.mkdtemp(join(tmpdir(), "torn-read-")), "data");
  const log = join(dir, "audit.jsonl");
  const lock = join(dir, "audit.lock");
  const store = await openStore(dir);
  for (let i = 0; i < 3; i++) await store.append("session", { i });
  await store.close();
  const text = await fsp.readFile(log, "utf8");
  const third = text.slice(text.lastIndexOf("\n", text.length - 2) + 1);
  const whole = text.slice(0, text.length - third.length);
  await fsp.writeFile(log, whole);
  await fsp.writeFile(lock, JSON.stringify({ token: "other", holder: "other:1", expires_at: Date.now() + 30_000 }));

  const writer = spawn(process.execPath, ["-e", WRITER, log, lock, third.slice(20)], { stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  const said = (word: string) =>
    new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (lines.includes(word)) resolve();
      };
      writer.stdout.on("data", (chunk: Buffer) => {
        lines.push(...chunk.toString().split("\n"));
        check();
      });
      writer.once("exit", () => {
        check();
        reject(new Error(`writer exited before ${word}`));
      });
      check();
    });
  const done = said("done");
  await said("ready");

  const reader = await openStore(dir);
  await fsp.appendFile(log, third.slice(0, 20));
  expect(reader.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
  await done;
  expect(verifyChain(readChain(dir))).toEqual({ ok: true });
});
