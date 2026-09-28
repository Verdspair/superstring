import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  ProtocolError,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mcpError } from "./schema";

export function guardMcpTransport(transport: Transport, beforeToolCall: () => void) {
  const discoveryIds = new Set<string | number>();
  let fallbackError: Error | undefined;
  let probing = false;
  let closedDuringProbe = false;
  const guarded: Transport = {
    ...(transport instanceof StdioClientTransport
      ? { pid: transport.pid, stderr: transport.stderr }
      : {}),
    get hasPerRequestStream() {
      return transport.hasPerRequestStream;
    },
    get sessionId() {
      return transport.sessionId;
    },
    async start() {
      transport.onmessage = (message, extra) => {
        if (
          (isJSONRPCErrorResponse(message) || isJSONRPCResultResponse(message)) &&
          message.id !== undefined &&
          discoveryIds.has(message.id)
        ) {
          if (
            isJSONRPCErrorResponse(message) &&
            [-32020, -32021, -32022].includes(message.error.code)
          )
            fallbackError = new ProtocolError(
              message.error.code,
              message.error.message,
              message.error.data,
            );
          if (isJSONRPCResultResponse(message) && Array.isArray(message.result.supportedVersions))
            fallbackError = mcpError(
              "MCP_PROTOCOL_ERROR",
              "MCP 服务器提供的新版协议不受支持，不能退回旧握手",
            );
        }
        guarded.onmessage?.(message, extra);
      };
      transport.onerror = (error) => guarded.onerror?.(error);
      transport.onclose = () => {
        closedDuringProbe = probing;
        guarded.onclose?.();
      };
      await transport.start();
    },
    async send(message, options) {
      if (isJSONRPCRequest(message)) {
        if (message.method === "server/discover") {
          probing = true;
          discoveryIds.add(message.id);
        } else if (message.method === "initialize") {
          // SDK 2.2 may downgrade recognized modern errors; the specification forbids that.
          if (fallbackError) throw fallbackError;
          probing = false;
        } else {
          probing = false;
          if (message.method === "tools/call") beforeToolCall();
        }
      }
      await transport.send(message, options);
    },
    async close() {
      probing = false;
      await transport.close();
    },
    setProtocolVersion(version) {
      transport.setProtocolVersion?.(version);
    },
  };
  return { transport: guarded, canRestartLegacy: () => closedDuringProbe && !fallbackError };
}
