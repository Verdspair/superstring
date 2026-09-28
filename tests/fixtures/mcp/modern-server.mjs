import { createInterface } from "node:readline";

const cancelled = [];
const send = (value) => console.log(JSON.stringify(value));
const tools = ["echo", "hold", "status"].map((name) => ({
  name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
}));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/cancelled") {
    cancelled.push(message.params.requestId);
    return;
  }
  const reply = (result) =>
    send({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...result } });
  if (message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "metadata required" } });
    return;
  }
  if (message.method === "server/discover")
    return reply({
      ttlMs: 0,
      cacheScope: "private",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
    });
  if (message.method === "tools/list") return reply({ tools, ttlMs: 0, cacheScope: "private" });
  if (message.method === "tools/call") {
    if (message.params.name === "hold") return;
    return reply({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            message.params.name === "status" ? cancelled : message.params.arguments,
          ),
        },
      ],
    });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
});
