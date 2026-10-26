import { afterEach, describe, expect, it } from "bun:test";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import { decideInvoke, decideNone } from "../harness/model";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);

function kind(message: ModelMessage): string | undefined {
  const part = message.content.find((entry) => entry.kind === "text");
  if (part?.kind !== "text") return undefined;
  try {
    return (JSON.parse(part.text) as { kind?: string }).kind;
  } catch {
    return undefined;
  }
}

describe("QQ history prefixes across tool decisions", () => {
  it("keeps disclosed conversation facts ahead of newly appended observations", async () => {
    const h = createOneBotHarness({
      model: [
        decideInvoke("history.query", { query: "first", limit: 1 }),
        decideInvoke("history.query", { query: "second", limit: 1 }),
        decideNone(),
      ],
      mediaInput: { stages: { decision: false, evaluation: false, generation: false } },
    });
    h.receive({ id: "70001", text: "A synthetic earlier fact.", speaker: "20002" });
    h.receive({ id: "70002", text: "Check that fact.", speaker: "20002", addressed: true });
    await h.activate("direct_reply");
    const requests = h.model?.receivedMessages.filter((entry) => entry.phase === "next") ?? [];
    expect(requests).toHaveLength(3);
    const initial = requests[0]!.messages;
    const initialFacts = initial.find((message) => kind(message) === "qq_message_facts");
    if (!initialFacts) throw new Error("synthetic message facts missing");
    for (const request of requests.slice(1)) {
      const observation = request.messages.findIndex(
        (message) => kind(message) === "action_observation",
      );
      const facts = request.messages.findIndex((message) => kind(message) === "qq_message_facts");
      expect(facts).toBeGreaterThan(0);
      expect(facts).toBeLessThan(observation);
      expect(request.messages.slice(0, facts + 1)).toEqual(initial.slice(0, facts + 1));
      expect(request.messages[facts]).toEqual(initialFacts);
      expect(request.messages[facts]!.role).toBe("user");
    }
    const second = requests[1]!.messages;
    const third = requests[2]!.messages;
    const firstObservation = second.findIndex((message) => kind(message) === "action_observation");
    expect(third.slice(0, firstObservation + 1)).toEqual(second.slice(0, firstObservation + 1));
    expect(third.filter((message) => kind(message) === "action_observation")).toHaveLength(2);
    expect(h.sent).toHaveLength(0);
  });
});
