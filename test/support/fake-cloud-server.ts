// Starts the fake Intent Cloud for manual and acceptance runs: `node test/support/fake-cloud-server.ts --port 8787`.
// It prints one JSON line ({url, rootPin}) and then reads commands on stdin, one per line, acting as the buyer:
//   approve <ap_…> | reject <ap_…> | handoff <ap_…> | order <ap_…>
// TEST KEYS ONLY. Not part of the npm package or the image.
import { createInterface } from "node:readline";
import { SoftPasskey, startFakeCloud } from "../../src/cloud-fake/index.ts";

const portArg = process.argv.indexOf("--port");
const port = portArg === -1 ? 0 : Number(process.argv[portArg + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write("usage: fake-cloud-server.ts [--port N]\n");
  process.exit(2);
}

const cloud = await startFakeCloud({ port });
const buyer = new SoftPasskey({ sub: "buyer-1" });
process.stdout.write(`${JSON.stringify({ url: cloud.url, rootPin: cloud.keys.rootPin })}\n`);

const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  const [command = "", handle = ""] = line.trim().split(/\s+/);
  const outcome =
    command === "approve"
      ? cloud.approveWithPasskey(handle, buyer)
      : command === "reject"
        ? cloud.reject(handle, buyer)
        : command === "handoff"
          ? cloud.handoff(handle)
          : command === "order"
            ? cloud.order(handle)
            : { status: 400, reason: "commands: approve|reject|handoff|order <approval handle>" };
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
});

const stop = (): void => {
  void cloud.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
