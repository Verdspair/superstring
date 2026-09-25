import { describe, expect, it } from "bun:test";
import { estimateMessages } from "../../src/server/services/context-builder";
import { checkQqModelCapacity } from "../../src/server/services/qq-capacity-preflight";

const input = {
  model: "synthetic",
  messages: [
    { role: "system" as const, content: "规则" },
    { role: "user" as const, content: "问候" },
  ],
  outputReserved: 512,
};
describe("QQ capacity preflight", () => {
  it("uses the existing web estimator and explicit output reservation", async () => {
    const estimated = estimateMessages(input.messages);
    expect(
      await checkQqModelCapacity({ loadedContextCapacity: async () => estimated + 512 }, input),
    ).toEqual({ kind: "allowed", inputUnits: estimated, capacity: estimated + 512 });
    expect(
      await checkQqModelCapacity({ loadedContextCapacity: async () => estimated + 511 }, input),
    ).toEqual({ kind: "exceeded" });
  });
  it("fails closed when capacity unknown or probe errors", async () => {
    expect(await checkQqModelCapacity({ loadedContextCapacity: async () => null }, input)).toEqual({
      kind: "unavailable",
    });
    expect(
      await checkQqModelCapacity(
        {
          loadedContextCapacity: async () => {
            throw new Error("synthetic");
          },
        },
        input,
      ),
    ).toEqual({ kind: "unavailable" });
  });
  it("does not accept guessed zero, invalid or absent reserves", async () => {
    for (const outputReserved of [0, -1, 1.5, 255, 16385])
      await expect(
        checkQqModelCapacity(
          { loadedContextCapacity: async () => 1000 },
          { ...input, outputReserved },
        ),
      ).rejects.toThrow(TypeError);
    await expect(
      checkQqModelCapacity(
        { loadedContextCapacity: async () => 1000 },
        { model: "synthetic", messages: input.messages },
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      checkQqModelCapacity({ loadedContextCapacity: async () => 1000 }, { ...input, extra: true }),
    ).rejects.toThrow(TypeError);
  });
});
