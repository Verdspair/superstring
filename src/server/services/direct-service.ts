import type { ContextUsage } from "../../shared/contracts/context-usage";
import { WebChannel, type WebChannelOptions, type WebRequest } from "../channels/web-channel";

/** Strict v1 presentation adapter. All conversation work belongs to the common Agent host. */
export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; messageId: string; createdAt: string; completedAt: string | null };
export interface DirectServiceOptions extends WebChannelOptions {
  onContextUsage?: (usage: ContextUsage) => void;
}
export class DirectService {
  private readonly channel: WebChannel;
  constructor(private readonly options: DirectServiceOptions) {
    this.channel = new WebChannel(options);
  }
  async openReply(args: WebRequest): Promise<AsyncGenerator<StreamEvent, void, unknown>> {
    const reply = await this.channel.openReply(args);
    const onUsage = this.options.onContextUsage;
    return (async function* () {
      let latestUsage: ContextUsage | undefined;
      let sentUsage = false;
      const flushUsage = () => {
        if (!sentUsage && latestUsage) {
          onUsage?.(latestUsage);
          sentUsage = true;
        }
      };
      for await (const event of reply) {
        if (event.type === "context_usage") {
          latestUsage = event.usage;
          continue;
        }
        if (["output_delta", "failed", "cancelled", "completed"].includes(event.type)) flushUsage();
        if (event.type === "output_delta") yield { kind: "delta" as const, text: event.text };
        else if (event.type === "replay") {
          if (event.message.text) yield { kind: "delta" as const, text: event.message.text };
          yield {
            kind: "done" as const,
            messageId: event.message.id,
            createdAt: event.message.createdAt,
            completedAt: event.message.completedAt,
          };
        } else if (event.type === "completed" && event.messageId && event.createdAt) {
          yield {
            kind: "done" as const,
            messageId: event.messageId,
            createdAt: event.createdAt,
            completedAt: event.completedAt ?? null,
          };
        }
      }
    })();
  }
}
