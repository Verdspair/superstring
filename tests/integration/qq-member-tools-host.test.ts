import { afterEach, describe, expect, it } from "bun:test";
import { decideInline, decideInvoke } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarnessOptions } from "../harness/onebot";

const botId = "10001";
function memberPort(enabled = true) {
  let listCalls = 0;
  let detailCalls = 0;
  const memberTools: NonNullable<OneBotHarnessOptions["memberTools"]> = {
    enabled: () => enabled,
    policyRevision: () => "synthetic-policy-1",
    sourceExpiresAt: () => "2099-01-01T00:00:00.000Z",
    platform: {
      async list() {
        listCalls++;
        return {
          kind: "ok",
          members: [
            { user_id: "20002", nickname: "Questioner", role: "member" },
            { user_id: "20003", card: "Silent Owner", role: "owner" },
            { user_id: botId, nickname: "Bot", role: "admin" },
          ],
        };
      },
      async read(_groupId, userId) {
        detailCalls++;
        return { kind: "ok", member: { user_id: userId, title: "Provided title" } };
      },
    },
  };
  return { memberTools, listCalls: () => listCalls, detailCalls: () => detailCalls };
}

afterEach(closeHarnesses);
describe("QQ members through the real host and context fitter", () => {
  it("queries platform members without a Skill pre-call and passes facts into the next model step", async () => {
    const port = memberPort();
    const h = createOneBotHarness({
      memberTools: port.memberTools,
      model: [decideInvoke("qq.members.query"), decideInline("20002", "查到本群成员")],
    });
    h.receive({ id: "101", speaker: "20002", text: "谁是群主？", addressed: true });
    await h.activate("direct_reply");
    const run = h.runs.listRuns({ ownerKind: "conversation", ownerId: h.conversationId })[0];
    expect(run?.status).toBe("completed");
    expect(port.listCalls()).toBe(1);
    expect(port.detailCalls()).toBe(0);
    expect(h.model?.calls[0].tools).toContain("qq.members.query");
    expect(h.model?.calls[0].tools).toContain("qq.members.read");
    const nextMessages = h.model?.receivedMessages[1]?.messages ?? [];
    const text = nextMessages
      .flatMap((message) =>
        message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
      )
      .join("\n");
    const observation = text
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find(
        (entry) => entry?.kind === "action_observation" && entry.value?.name === "qq.members.query",
      );
    expect(observation?.value.value.members).toContainEqual({
      userId: "20003",
      groupCard: "Silent Owner",
      role: "owner",
      isSelf: false,
    });
    expect(observation?.value.value.members).toContainEqual({
      userId: botId,
      nickname: "Bot",
      role: "admin",
      isSelf: true,
    });
    expect(h.model?.calls.some((call) => call.tools.includes("skill.read"))).toBe(false);
  });

  it("ordinary chat makes no member requests", async () => {
    const port = memberPort();
    const h = createOneBotHarness({
      memberTools: port.memberTools,
      model: [decideInline("20002", "你好")],
    });
    h.receive({ id: "102", speaker: "20002", text: "你好", addressed: true });
    await h.activate("direct_reply");
    expect(
      h.runs.listRuns({ ownerKind: "conversation", ownerId: h.conversationId })[0]?.status,
    ).toBe("completed");
    expect(port.listCalls()).toBe(0);
    expect(port.detailCalls()).toBe(0);
  });

  it.each(["private", "global-off", "group-off"] as const)(
    "does not advertise member tools when %s",
    async (scope) => {
      const port = memberPort(scope !== "global-off");
      const h = createOneBotHarness({
        kind: scope === "private" ? "private" : "group",
        memberTools: port.memberTools,
        model: [decideInline("20002", "你好")],
      });
      if (scope === "group-off") {
        h.db
          .query(
            "INSERT INTO qq_group_agent_configs(id,binding_id,agent_id,scheme_overrides,disabled_capabilities,revision,created_at,updated_at) VALUES('member-config',?,?, '{}', '[\"members_read\"]', 1, ?, ?)",
          )
          .run(
            h.bindingId,
            (
              h.db.query("SELECT agent_id FROM qq_bindings WHERE id=?").get(h.bindingId) as {
                agent_id: string;
              }
            ).agent_id,
            h.now(),
            h.now(),
          );
      }
      h.receive({ id: "103", speaker: "20002", text: "你好", addressed: true });
      await h.activate("direct_reply");
      expect(h.model?.calls[0].tools).not.toContain("qq.members.query");
      expect(h.model?.calls[0].tools).not.toContain("qq.members.read");
      expect(port.listCalls()).toBe(0);
    },
  );
});
