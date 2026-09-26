import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { parseAttentionMembers, type QqInputs } from "./draft-state";
import { useQqInput } from "./use-qq-input";
// 快捷管理 → 第三方App接入 (§11.1, P5q).
//
// The plan puts four things on this page: the QQ connection, the list of groups and private chats,
// the binding of a conversation to an assistant and a scheme, and a quick on/off field with the
// current status. All of it exists on the server already (P5b); this is the surface.
//
// Three shapes here are deliberate rather than incidental:
//
//   * The TOKEN is write-only. The saved value is never sent back to the browser, so the field
//     says whether one is stored and lets the user replace or clear it — it never displays it.
//   * A conversation normally comes from the INTAKE's own observations. The manual row exists
//     because an unbound conversation's messages are not recorded at all, so a conversation
//     nobody has spoken in yet has no observation to appear from — without the row there would be
//     no way to bind the first one (2026-09-25). Once bound, such a conversation still shows,
//     marked as having nothing observed yet.
//   * The switch appears here as §11.1's 基础启停快捷字段 and on 运行模式 as the master one. One
//     value, two surfaces, both compare-and-swap on the revision the page saved.

import { type ReactNode, useEffect } from "react";
import type { QqBindingResponse, QqConversationListItem } from "../../../shared/contracts/qq";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { QqMemoryControls } from "../memory/QqMemoryControls";

/** §0.6/F05's four module switches, in the order the scheme page lists them. */
const TRIGGER_ROWS = [
  { key: "direct_reply", label: "直接回应" },
  { key: "follow_up", label: "连续交谈" },
  { key: "chiming_in", label: "自主接话" },
  { key: "idle_topic", label: "冷场发起" },
] as const;

const PHASE_LABELS: Record<string, string> = {
  unavailable: "本进程没有传输运行时",
  idle: "未连接",
  connecting: "正在连接",
  verifying: "正在校验",
  ready: "已连接",
  closed: "连接已关闭",
};

export function QqAppAccess({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useI18n();
  const settings = useSuperstringStore((s) => s.qqSettings);
  const connection = useSuperstringStore((s) => s.qqConnection);
  const conversations = useSuperstringStore((s) => s.qqConversations);
  const bindings = useSuperstringStore((s) => s.qqBindings);
  const agents = useSuperstringStore((s) => s.agents);
  const schemes = useSuperstringStore((s) => s.qqSchemes);
  const loading = useSuperstringStore((s) => s.qqAccessLoading);
  const saving = useSuperstringStore((s) => s.qqAccessSaving);
  const error = useSuperstringStore((s) => s.error);
  const feedback = useSuperstringStore((s) => s.feedback);
  const load = useSuperstringStore((s) => s.loadQqAccess);
  const refreshConnection = useSuperstringStore((s) => s.refreshQqConnection);
  const save = useSuperstringStore((s) => s.saveQqSurface);
  const bind = useSuperstringStore((s) => s.bindQqConversation);
  const bindByNumber = useSuperstringStore((s) => s.bindQqPeerNumber);
  const updateRow = useSuperstringStore((s) => s.updateQqBindingRow);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);

  const [connectionDraft, setConnectionDraft] = useQqInput("connection");
  const endpoint = connectionDraft?.endpoint ?? settings?.transport.endpoint ?? "";
  const accountId = connectionDraft?.accountId ?? settings?.account_id ?? "";
  const token = connectionDraft?.token ?? "";
  const connectionPatch = (patch: Partial<NonNullable<QqInputs["connection"]>>) => {
    if (!settings) return;
    setConnectionDraft((current) => ({
      source: current?.source ?? settings,
      endpoint,
      accountId,
      token,
      ...patch,
    }));
  };
  const setEndpoint = (endpoint: string) => connectionPatch({ endpoint });
  const setAccountId = (accountId: string) => connectionPatch({ accountId });
  const setToken = (token: string) => connectionPatch({ token });
  const [choices, setChoices] = useQqInput("choices");
  const [manualKind, setManualKind] = useQqInput("manualKind");
  const [manualPeer, setManualPeer] = useQqInput("manualPeer");
  const [manualAgentId, setManualAgentId] = useQqInput("manualAgentId");
  const [manualSchemeId, setManualSchemeId] = useQqInput("manualSchemeId");
  const [attentionDrafts, setAttentionDrafts] = useQqInput("attention");

  useEffect(() => {
    void load();
  }, [load]);

  const bindingOf = (conversation: QqConversationListItem) =>
    bindings.find(
      (row) =>
        row.account_id === conversation.account_id &&
        row.kind === conversation.kind &&
        row.peer_id === conversation.peer_id,
    ) ?? null;

  const choiceFor = (conversation: QqConversationListItem, bindingId: string | null) => {
    const existing = choices[bindingId ?? `${conversation.kind}:${conversation.peer_id}`];
    const binding = bindingOf(conversation);
    return {
      agentId: existing?.agentId ?? binding?.agent_id ?? agents[0]?.id ?? "",
      schemeId: existing?.schemeId ?? binding?.scheme_id ?? schemes[0]?.id ?? "",
    };
  };

  // The manual row starts on the first choices and only stores what the user actually changed, so
  // an unrelated reload cannot overwrite a selection that was never touched.
  const manualAgent = manualAgentId || agents[0]?.id || "";
  const manualScheme = manualSchemeId || schemes[0]?.id || "";

  // Seeded from the row's CURRENT effective choice, so the first keystroke changes one field
  // instead of starting from an empty draft.
  const patchChoice = (
    key: string,
    base: { agentId: string; schemeId: string },
    patch: { agentId?: string; schemeId?: string },
  ) =>
    setChoices((current) => ({
      ...current,
      [key]: {
        ...base,
        source: current[key]?.source ?? bindings.find((item) => item.id === key),
        ...patch,
      },
    }));

  // The list is the union of what the intake saw and what was bound by number: a binding whose
  // conversation has not spoken yet has no observation row to appear from, and hiding it would
  // make a successful manual binding look like nothing happened.
  const unobserved: QqConversationListItem[] = bindings
    .filter(
      (row) =>
        !conversations.some(
          (conversation) =>
            conversation.account_id === row.account_id &&
            conversation.kind === row.kind &&
            conversation.peer_id === row.peer_id,
        ),
    )
    .map((row) => ({
      account_id: row.account_id,
      kind: row.kind,
      peer_id: row.peer_id,
      messages: 0,
      last_at_seconds: 0,
      binding_id: row.id,
    }));
  const rows = [...conversations, ...unobserved];

  /**
   * 「重要的人」(0031): the attention editor for one bound conversation.
   *
   * The members travel as one text field, because the list is short and hand-typed — the same
   * shape as the manual binding. The mode decides what the list does: `soft` only marks the
   * listed speakers in the context, `hard` lets only them trigger anything, and `off` clears both
   * halves at once, which is the only pairing the server contract accepts.
   */
  const attentionEditor = (binding: QqBindingResponse) => {
    const draft = attentionDrafts[binding.id] ?? {
      source: binding,
      mode: binding.attention.mode,
      members: binding.attention.members.join(" "),
    };
    const members = parseAttentionMembers(draft.members);
    return (
      <div
        className="qq-access-triggers grid gap-3 sm:grid-cols-2 xl:grid-cols-4 [&>label]:grid [&>label]:min-w-0 [&>label]:gap-2 [&>label]:text-xs [&>label]:text-muted-foreground"
        id={`qq-access-attention-${binding.id}`}
      >
        <span className="hint text-sm leading-relaxed text-muted-foreground">{t("重要的人")}</span>
        <Label>
          <span>{t("模式")}</span>
          <NativeSelect
            className="w-full"
            aria-label={t("重要的人模式")}
            disabled={saving}
            value={draft.mode}
            onChange={(event) =>
              setAttentionDrafts((current) => ({
                ...current,
                [binding.id]: {
                  ...draft,
                  mode:
                    event.target.value === "soft"
                      ? "soft"
                      : event.target.value === "hard"
                        ? "hard"
                        : "off",
                },
              }))
            }
          >
            <option value="off">{t("不启用")}</option>
            <option value="soft">{t("软优先")}</option>
            <option value="hard">{t("只回应名单内的人")}</option>
          </NativeSelect>
        </Label>
        <Label>
          <span>{t("名单")}</span>
          <Input
            aria-label={t("重要的人名单")}
            disabled={saving || draft.mode === "off"}
            value={draft.members}
            placeholder={t("QQ号，用逗号或空格分隔")}
            onChange={(event) =>
              setAttentionDrafts((current) => ({
                ...current,
                [binding.id]: { ...draft, members: event.target.value },
              }))
            }
          />
        </Label>
        <Button
          variant="outline"
          type="button"
          disabled={saving || (draft.mode !== "off" && members.length === 0)}
          onClick={() =>
            void updateRow(draft.source, {
              attention:
                draft.mode === "off" ? { mode: "off", members: [] } : { mode: draft.mode, members },
            }).then((ok) => {
              // Dropping the draft makes the field show what was actually stored (the server
              // normalizes and sorts the list), instead of the text that was typed.
              if (!ok) return;
              setAttentionDrafts((current) => {
                const next = { ...current };
                delete next[binding.id];
                return next;
              });
            })
          }
        >
          {t("保存名单")}
        </Button>
        <span className="hint text-sm leading-relaxed text-muted-foreground">
          {t(
            "软优先只让他们的发言在上下文里更显眼，不改任何门槛；只回应模式下名单外的人照常记录，但不会让它开口。",
          )}
        </span>
      </div>
    );
  };

  const memoryEditor = (binding: QqBindingResponse) => (
    <div
      className="qq-access-triggers grid gap-3 sm:grid-cols-2 xl:grid-cols-4 [&>label]:grid [&>label]:min-w-0 [&>label]:gap-2 [&>label]:text-xs [&>label]:text-muted-foreground"
      id={`qq-access-memory-${binding.id}`}
    >
      <span className="hint text-sm leading-relaxed text-muted-foreground">{t("记忆整理")}</span>
      <QqMemoryControls
        key={binding.id}
        binding={{ ...binding, enabled: settings?.enabled === true }}
        pending={binding.pending_observations}
        disabled={saving}
        onChanged={() => void load()}
      />
      <Button
        variant="link"
        type="button"
        className="link-button h-auto p-0 text-sm"
        onClick={() => openRoute("long-memory")}
      >
        {t("前往长期记忆")}
      </Button>
    </div>
  );

  // 嵌在「运行模式 → QQ」分组里时不再套一层分组（两层标题带就是两层外框），改用小标题分段；
  // 独立成页时仍是完整分组。两种形态共用同一份内容，不复制。
  //
  // 刻意**不是**一个组件而是一个返回元素的函数：定义在渲染体里的组件每次渲染都是新类型，React 会
  // 把整棵子树卸载重建——这一段的每行都有自己的输入草稿与判决文案，重建就会把它们全部清掉。
  const panel = (id: string, title: string, note: string | undefined, children: ReactNode) =>
    embedded ? (
      <section
        id={id}
        className="qq-access-subsection space-y-4 [&>h4]:text-sm [&>h4]:font-semibold"
        aria-label={t(title)}
      >
        <h4>{t(title)}</h4>
        {note !== undefined && (
          <p className="hint text-sm leading-relaxed text-muted-foreground">{t(note)}</p>
        )}
        {children}
      </section>
    ) : (
      <SettingsGroup id={id} title={title} note={note}>
        {children}
      </SettingsGroup>
    );

  return (
    <>
      {!embedded && (
        <p className="settings-note text-sm leading-relaxed text-muted-foreground">
          {t("这里配置 QQ 机器人侧的连接参数，并给已经说过话的群和私聊绑定助手与方案。")}
        </p>
      )}
      {loading && <p role="status">{t("正在读取接入状态…")}</p>}
      {error && (
        <p role="alert" className="error text-sm text-destructive">
          {translateNotice(error)}
        </p>
      )}
      {feedback && (
        <p
          className="hint workspace-feedback text-sm leading-relaxed text-muted-foreground"
          role="status"
        >
          {translateNotice(feedback)}
        </p>
      )}

      {settings &&
        panel(
          "qq-access-connection",
          "连接",
          "地址与令牌只保存在本机；令牌写入后不再回显。",
          <>
            <Field
              label="连接状态"
              info="来自运行中的传输，不是从已保存地址推断；总开关在上方「第三方聊天（QQ）」那一行。"
            >
              <span role="status">
                {connection ? t(PHASE_LABELS[connection.phase] ?? connection.phase) : t("未知")}
                {connection?.reason ? `（${connection.reason}）` : ""}
              </span>
              <Button
                variant="link"
                type="button"
                className="link-button h-auto p-0 text-sm"
                onClick={() => void refreshConnection()}
              >
                {t("刷新状态")}
              </Button>
            </Field>
            <Field label="助手账号" info="机器人自己的QQ号；与绑定会话的账号一致才会处理消息。">
              <Input
                aria-label={t("助手账号")}
                value={accountId}
                disabled={saving}
                inputMode="numeric"
                onChange={(event) => setAccountId(event.target.value)}
              />
            </Field>
            <Field
              label="WebSocket 地址"
              info="NapCat 的正向 WebSocket 地址，本机优先，例如 ws://127.0.0.1:3000/。"
            >
              <Input
                aria-label={t("WebSocket 地址")}
                value={endpoint}
                disabled={saving}
                placeholder="ws://127.0.0.1:3000/"
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </Field>
            <Field
              label="访问令牌"
              info="写入后不再回显；留空表示不改动已保存的令牌，清空按钮单独提供。"
            >
              <Input
                aria-label={t("访问令牌")}
                type="password"
                value={token}
                disabled={saving}
                placeholder={
                  settings.transport.has_token ? t("已保存（留空则不修改）") : t("尚未保存")
                }
                onChange={(event) => setToken(event.target.value)}
              />
              <small className="hint text-sm leading-relaxed text-muted-foreground">
                {settings.transport.has_token ? t("已保存令牌") : t("尚未保存令牌")}
              </small>
            </Field>
            <div className="qq-sticker-actions flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                type="button"
                disabled={saving}
                onClick={() => {
                  void save(
                    {
                      account_id: accountId.trim() === "" ? null : accountId.trim(),
                      endpoint: endpoint.trim() === "" ? null : endpoint.trim(),
                      ...(token === "" ? {} : { token }),
                    },
                    connectionDraft?.source.revision,
                  ).then((ok) => {
                    if (ok) setConnectionDraft(null);
                  });
                }}
              >
                {t("保存接入设置")}
              </Button>
              {settings.transport.has_token && (
                <Button
                  variant="outline"
                  type="button"
                  disabled={saving}
                  onClick={() => void save({ token: null })}
                >
                  {t("清除已保存令牌")}
                </Button>
              )}
            </div>
          </>,
        )}

      {panel(
        "qq-access-conversations",
        "群与私聊",
        "绑定后才会按方案参与判断与发言；没有绑定的群或私聊，消息不会被记录。",
        <>
          <div
            className="qq-access-controls flex flex-wrap items-end gap-3 [&>label]:grid [&>label]:min-w-0 [&>label]:flex-1 [&>label]:gap-2 [&>label]:text-xs [&>label]:text-muted-foreground"
            id="qq-access-manual"
          >
            <Label>
              <span>{t("手动绑定")}</span>
              <NativeSelect
                className="w-full"
                aria-label={t("手动绑定的类型")}
                disabled={saving}
                value={manualKind}
                onChange={(event) =>
                  setManualKind(event.target.value === "private" ? "private" : "group")
                }
              >
                <option value="group">{t("群")}</option>
                <option value="private">{t("私聊")}</option>
              </NativeSelect>
            </Label>
            <Label>
              <span>{t("号码")}</span>
              <Input
                aria-label={t("号码")}
                value={manualPeer}
                inputMode="numeric"
                disabled={saving}
                placeholder={t("群号或QQ号")}
                onChange={(event) => setManualPeer(event.target.value)}
              />
            </Label>
            <Label>
              <span>{t("助手")}</span>
              <NativeSelect
                className="w-full"
                aria-label={t("手动绑定的助手")}
                disabled={saving}
                value={manualAgent}
                onChange={(event) => setManualAgentId(event.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label>
              <span>{t("方案")}</span>
              <NativeSelect
                className="w-full"
                aria-label={t("手动绑定的方案")}
                disabled={saving}
                value={manualScheme}
                onChange={(event) => setManualSchemeId(event.target.value)}
              >
                {schemes.map((scheme) => (
                  <option key={scheme.id} value={scheme.id}>
                    {scheme.name}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Button
              variant="outline"
              type="button"
              disabled={
                saving || manualPeer.trim() === "" || manualAgent === "" || manualScheme === ""
              }
              onClick={() =>
                void bindByNumber({
                  kind: manualKind,
                  peerId: manualPeer.trim(),
                  agentId: manualAgent,
                  schemeId: manualScheme,
                }).then((ok) => {
                  if (ok) setManualPeer("");
                })
              }
            >
              {t("绑定这个号码")}
            </Button>
          </div>
          {rows.length === 0 ? (
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("还没有会话：用上面的号码直接绑定一个群或私聊。")}
            </p>
          ) : (
            <ul className="qq-access-list grid gap-4 [&>li]:space-y-4 [&>li]:rounded-xl [&>li]:border [&>li]:bg-card [&>li]:p-5">
              {rows.map((conversation) => {
                const binding = bindingOf(conversation);
                const key = binding?.id ?? `${conversation.kind}:${conversation.peer_id}`;
                const choice = choiceFor(conversation, binding?.id ?? null);
                return (
                  <li key={key}>
                    <div className="qq-access-row flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2">
                      <strong>
                        {conversation.kind === "group" ? t("群") : t("私聊")} {conversation.peer_id}
                      </strong>
                      {conversation.messages === 0 ? (
                        <span className="hint text-sm leading-relaxed text-muted-foreground">
                          {t("还没有观察到消息")}
                        </span>
                      ) : (
                        <small className="hint text-sm leading-relaxed text-muted-foreground">
                          {t(
                            "{0} 条消息 · 最近 {1}",
                            conversation.messages,
                            lastSeen(conversation),
                          )}
                        </small>
                      )}
                      {binding === null ? (
                        <span className="hint text-sm leading-relaxed text-muted-foreground">
                          {t("未绑定")}
                        </span>
                      ) : (
                        <span className="hint text-sm leading-relaxed text-muted-foreground">
                          {binding.paused ? t("已暂停") : t("参与中")}
                        </span>
                      )}
                    </div>
                    {binding !== null && (
                      <div className="qq-access-triggers grid gap-3 sm:grid-cols-2 xl:grid-cols-4 [&>label]:grid [&>label]:min-w-0 [&>label]:gap-2 [&>label]:text-xs [&>label]:text-muted-foreground">
                        <span className="hint text-sm leading-relaxed text-muted-foreground">
                          {t("模块开关")}
                        </span>
                        {TRIGGER_ROWS.map((row) => (
                          <Label key={row.key}>
                            <span>{t(row.label)}</span>
                            <NativeSelect
                              className="w-full"
                              aria-label={t("{0} 的开关", row.label)}
                              disabled={saving}
                              value={
                                binding.triggers[row.key] === null
                                  ? "inherit"
                                  : binding.triggers[row.key]
                                    ? "on"
                                    : "off"
                              }
                              onChange={(event) =>
                                void updateRow(binding, {
                                  triggers: {
                                    ...binding.triggers,
                                    [row.key]:
                                      event.target.value === "inherit"
                                        ? null
                                        : event.target.value === "on",
                                  },
                                })
                              }
                            >
                              <option value="inherit">{t("跟随方案")}</option>
                              <option value="on">{t("开")}</option>
                              <option value="off">{t("关")}</option>
                            </NativeSelect>
                          </Label>
                        ))}
                      </div>
                    )}
                    {binding !== null && attentionEditor(binding)}
                    {binding !== null && memoryEditor(binding)}
                    <div className="qq-access-controls flex flex-wrap items-end gap-3 [&>label]:grid [&>label]:min-w-0 [&>label]:flex-1 [&>label]:gap-2 [&>label]:text-xs [&>label]:text-muted-foreground">
                      <Label>
                        <span>{t("助手")}</span>
                        <NativeSelect
                          className="w-full"
                          aria-label={t("助手")}
                          disabled={saving}
                          value={choice.agentId}
                          onChange={(event) =>
                            patchChoice(key, choice, { agentId: event.target.value })
                          }
                        >
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </Label>
                      <Label>
                        <span>{t("方案")}</span>
                        <NativeSelect
                          className="w-full"
                          aria-label={t("方案")}
                          disabled={saving}
                          value={choice.schemeId}
                          onChange={(event) =>
                            patchChoice(key, choice, { schemeId: event.target.value })
                          }
                        >
                          {schemes.map((scheme) => (
                            <option key={scheme.id} value={scheme.id}>
                              {scheme.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </Label>
                      {binding === null ? (
                        <Button
                          variant="outline"
                          type="button"
                          disabled={saving || choice.agentId === "" || choice.schemeId === ""}
                          onClick={() =>
                            void bind({
                              conversation,
                              agentId: choice.agentId,
                              schemeId: choice.schemeId,
                            })
                          }
                        >
                          {t("绑定")}
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="outline"
                            type="button"
                            disabled={saving}
                            onClick={() =>
                              void updateRow(choices[key]?.source ?? binding, {
                                agent_id: choice.agentId,
                                scheme_id: choice.schemeId,
                              }).then((ok) => {
                                if (ok)
                                  setChoices((current) => {
                                    const { [key]: _saved, ...next } = current;
                                    return next;
                                  });
                              })
                            }
                          >
                            {t("保存改绑")}
                          </Button>
                          <Button
                            variant="outline"
                            type="button"
                            disabled={saving}
                            onClick={() => void updateRow(binding, { paused: !binding.paused })}
                          >
                            {binding.paused ? t("恢复参与") : t("暂停发言")}
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {schemes.length === 0 && (
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("还没有方案：先到聊天方案页建一个，才能绑定会话。")}
              <Button
                variant="link"
                type="button"
                className="link-button h-auto p-0 text-sm"
                onClick={() => openRoute("qq-scheme-config")}
              >
                {t("前往聊天方案")}
              </Button>
            </p>
          )}
        </>,
      )}

      {panel(
        "qq-access-links",
        "相关配置",
        "这些是 QQ 全局资源，不随助手切换。",
        <>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            <Button
              variant="link"
              type="button"
              className="link-button h-auto p-0 text-sm"
              onClick={() => openRoute("qq-scheme-config")}
            >
              {t("聊天方案")}
            </Button>
            {t("：发言触发、节奏、上下文、媒体与六段提示词。")}
          </p>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            <Button
              variant="link"
              type="button"
              className="link-button h-auto p-0 text-sm"
              onClick={() => openRoute("qq-stickers")}
            >
              {t("表情素材")}
            </Button>
            {t("：导入、归类与启用；方案授权集合后才可能被选中。")}
          </p>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            <Button
              variant="link"
              type="button"
              className="link-button h-auto p-0 text-sm"
              onClick={() => openRoute("qq-storage")}
            >
              {t("存储与诊断")}
            </Button>
            {t("：保存了什么、在等什么、清理与保留窗口。")}
          </p>
        </>,
      )}
    </>
  );
}

/** Local time for the last observed message; the wire carries epoch seconds. */
function lastSeen(conversation: QqConversationListItem): string {
  if (conversation.last_at_seconds <= 0) return "—";
  return new Date(conversation.last_at_seconds * 1000).toLocaleString();
}
