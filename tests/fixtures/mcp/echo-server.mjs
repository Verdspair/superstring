// 最小 MCP 服务器（stdio）：给 P6 客户端的集成测试当对端。
//
// 只实现握手、工具清单与调用三件事；特意保留两类"脏"行为，用来看客户端守不守纪律：
//   * 启动时往 stdout 写一行**非 JSON** 噪音（真实服务器也常这么干）；
//   * 有一个工具返回 5000 字符的长文本、有一个工具 isError。

import { createInterface } from "node:readline";

const tools = [
  {
    name: "read_notes",
    description: "读取本机笔记",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "save_note",
    description: "写入一条笔记",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "big_result",
    description: "返回很长的文本",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "failing_tool",
    description: "总是报错",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// 噪音：不是 JSON 的一行；客户端必须无视它。
console.log("mcp-echo-server ready");

createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (message.id === undefined) return; // 通知
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize")
    return reply({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "echo", version: "1" },
    });
  if (message.method === "tools/list") return reply({ tools });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "read_notes")
      return reply({ content: [{ type: "text", text: "note: 冰箱里有牛奶" }] });
    if (name === "save_note") return reply({ content: [{ type: "text", text: "saved" }] });
    if (name === "big_result")
      return reply({ content: [{ type: "text", text: "x".repeat(5000) }] });
    if (name === "failing_tool")
      return reply({ isError: true, content: [{ type: "text", text: "boom" }] });
    return reply({ isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method ${message.method}` },
  });
});
