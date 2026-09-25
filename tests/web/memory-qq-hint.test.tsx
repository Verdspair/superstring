// 长期记忆 → 自动整理 的 QQ 生效范围提示（用户 2026-09-25）。
//
// The shape the user chose: the control stays editable, and the page only owes the reader the fact
// — this setting governs web sessions, QQ organises per conversation — plus a way over there. It
// appears only when the assistant being edited actually has a QQ conversation, because saying
// "governs the web side" to an assistant that never touched QQ would be noise.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import type { QqBindingResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { MemoryPageFields } from "../../src/web/features/agents/MemoryPageFields";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-09-25T00:00:00.000000Z";
const HINT =
  "这个设置仅对网页端会话生效；QQ 里的记忆整理按会话单独设置（攒够多少条自动整理、立即整理）。";

function bindingFor(agentId: string): QqBindingResponse {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    account_id: "10001",
    kind: "group",
    peer_id: "30003",
    agent_id: agentId,
    scheme_id: "33333333-3333-4333-8333-333333333333",
    paused: false,
    triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
    attention: { mode: "off", members: [] },
    share_web_memory: false,
    memory_batch_size: null,
    pending_observations: 0,
    revision: 1,
    authority_revision: 1,
  };
}

function setup(bindings: QqBindingResponse[]) {
  const agent = AgentResponseSchema.parse({
    id: AGENT_ID,
    name: "小助",
    description: "",
    system_prompt: "",
    additional_instructions: "",
    model_name: "qwen/test",
    temperature: 0.7,
    memory_consolidation_model_name: null,
    memory_retrieval_model_name: null,
    context_compression_model_name: null,
    persona_intensity: 60,
    config_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  const persona = PersonaResponseSchema.parse({
    id: "44444444-4444-4444-8444-444444444444",
    agent_id: AGENT_ID,
    core_identity: "",
    communication_style: "",
    interaction_boundaries: "",
    example_dialogues: "",
    advanced_instructions: "",
    created_at: NOW,
    updated_at: NOW,
  });
  store.getState().resetForTests(api);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "long-memory",
    editorAgentId: AGENT_ID,
    pageEditor: newPageEditor(agent, persona),
    qqBindings: bindings,
    qqBindingsLoaded: true,
  });
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("长期记忆页的 QQ 生效范围提示", () => {
  it("当前助手有 QQ 会话时给出原因，并定位同页记忆分区", () => {
    setup([bindingFor(AGENT_ID)]);
    render(<MemoryPageFields page="long-memory" />);
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.getByRole("link", { name: "前往记忆分区" }).getAttribute("href")).toBe(
      "#settings-memory-scopes",
    );
  });

  it("QQ 会话属于别的助手时不打扰", () => {
    setup([bindingFor(OTHER_AGENT_ID)]);
    render(<MemoryPageFields page="long-memory" />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("没有任何 QQ 绑定时不出现", () => {
    setup([]);
    render(<MemoryPageFields page="long-memory" />);
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
