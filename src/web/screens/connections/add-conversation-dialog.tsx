import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { isQqPrivateSelfTarget, type QqBindingResponse } from "../../../shared/contracts/qq";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { manualBindingTarget, qqConversationKey } from "../../features/qq/draft-state";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";

export function AddConversationDialog({
  schemeId,
  initialKind,
  onClose,
  onManage,
  onCloseAutoFocus,
}: {
  schemeId: string | null;
  initialKind?: "group" | "private";
  onClose: () => void;
  onManage: (binding: QqBindingResponse) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t, i18n } = useTranslation();
  const state = useSuperstringStore(
    useShallow((s) => ({
      agents: s.agents,
      error: s.error,
      qqAccessSaving: s.qqAccessSaving,
      qqBindings: s.qqBindings,
      qqBindingsLoaded: s.qqBindingsLoaded,
      qqBindingsLoading: s.qqBindingsLoading,
      qqBindingsError: s.qqBindingsError,
      qqConversations: s.qqConversations,
      qqInputs: s.qqInputs,
      qqSchemes: s.qqSchemes,
      qqSettings: s.qqSettings,
      summaryById: s.summaryById,
      bindQqConversation: s.bindQqConversation,
      bindQqPeerNumber: s.bindQqPeerNumber,
      loadQqBindingDirectory: s.loadQqBindingDirectory,
      openSettingsRoute: s.openSettingsRoute,
      requestConversationNavigation: s.requestConversationNavigation,
      resolveConversationSource: s.resolveConversationSource,
      directoryError: s.directoryError,
      createQqScheme: s.createQqScheme,
      qqSchemeSaving: s.qqSchemeSaving,
    })),
  );
  const [query, setQuery] = useState("");
  const [schemeName, setSchemeName] = useState<string | null>(null);
  const [success, setSuccess] = useState<QqBindingResponse | null>(null);
  const [refreshingConversation, setRefreshingConversation] = useState(false);
  const inputs = state.qqInputs;
  const patch = (next: Partial<typeof inputs>) =>
    useSuperstringStore.setState((s) => ({ qqInputs: { ...s.qqInputs, ...next } }));
  useEffect(() => {
    const current = useSuperstringStore.getState().qqInputs;
    if (current.manualPicked || current.manualPeer.trim()) return;
    useSuperstringStore.setState((s) => ({
      qqInputs: {
        ...s.qqInputs,
        ...(initialKind ? { manualKind: initialKind } : {}),
        ...(schemeId ? { manualSchemeId: schemeId } : {}),
      },
    }));
  }, [initialKind, schemeId]);
  const target = manualBindingTarget({ qqInputs: inputs, qqConversations: state.qqConversations });
  const observed = target?.conversation ?? null;
  const kind = target?.kind ?? inputs.manualKind;
  const peer = target?.peer ?? "";
  const saving = state.qqAccessSaving;
  const busy = saving || state.qqSchemeSaving || state.qqBindingsLoading;
  const agent = state.agents.find((a) => a.id === inputs.manualAgentId);
  const selectedScheme = state.qqSchemes.find((s) => s.id === inputs.manualSchemeId);
  const schemeAvailable = !!selectedScheme;
  const existing = state.qqBindings.find(
    (b) =>
      b.account_id === (observed?.account_id ?? state.qqSettings?.account_id) &&
      b.kind === kind &&
      b.peer_id === peer,
  );
  const bindingAccount = observed?.account_id ?? state.qqSettings?.account_id ?? "";
  const selfTargetId = useId();
  // 只拦私聊把机器人自己当对方：群号与账号是两个命名空间，数字相同也合法。
  const selfTarget =
    kind === "private" && !!bindingAccount && !!peer && isQqPrivateSelfTarget(bindingAccount, peer);
  const summaryOf = (binding: QqBindingResponse) =>
    Object.values(state.summaryById).find(
      (s) =>
        s.channel === "onebot11" && s.sourceId === binding.id && s.agentId === binding.agent_id,
    );
  const ready =
    state.qqBindingsLoaded &&
    !busy &&
    !!state.qqSettings?.account_id &&
    !!agent &&
    schemeAvailable &&
    !!peer &&
    (!inputs.manualPicked || !!observed) &&
    !selfTarget &&
    !existing;
  const needle = query.trim().toLocaleLowerCase(i18n.language);
  const visible = state.qqConversations.filter((row) => {
    if (row.kind !== kind) return false;
    const binding = state.qqBindings.find(
      (b) => b.account_id === row.account_id && b.kind === row.kind && b.peer_id === row.peer_id,
    );
    const title = binding ? (summaryOf(binding)?.title ?? "") : "";
    return (
      !needle ||
      `${title} ${row.peer_id}`.toLocaleLowerCase(i18n.language).includes(needle) ||
      qqConversationKey(row) === inputs.manualPicked
    );
  });
  const bind = async () => {
    if (!ready) return;
    const accountId = bindingAccount;
    const agentId = inputs.manualAgentId;
    const schemeChoice = inputs.manualSchemeId;
    const ok = observed
      ? await state.bindQqConversation({ conversation: observed, agentId, schemeId: schemeChoice })
      : await state.bindQqPeerNumber({ kind, peerId: peer, agentId, schemeId: schemeChoice });
    if (!ok) return;
    const saved = useSuperstringStore
      .getState()
      .qqBindings.find(
        (b) =>
          b.account_id === accountId &&
          b.kind === kind &&
          b.peer_id === peer &&
          b.agent_id === agentId,
      );
    patch({ manualPeer: "", manualPicked: "", manualAgentId: "" });
    if (saved) setSuccess(saved);
    else onClose();
  };
  const navigate = (route: "basic" | "scheme-library" | "qq-connection") => {
    state.openSettingsRoute(route);
    if (!useSuperstringStore.getState().navigationConfirmOpen) onClose();
  };
  const createScheme = async () => {
    if (!schemeName?.trim() || state.qqSchemeSaving) return;
    if (await state.createQqScheme(schemeName.trim(), { forBinding: true })) setSchemeName(null);
  };
  const refreshConversation = async () => {
    if (!success || refreshingConversation) return;
    setRefreshingConversation(true);
    try {
      await state.resolveConversationSource("onebot11", success.id, success.agent_id);
    } finally {
      setRefreshingConversation(false);
    }
  };
  const savedSummary = success ? summaryOf(success) : null;
  const savedScheme = state.qqSchemes.find((s) => s.id === success?.scheme_id);
  const savedTriggersOff =
    success &&
    savedScheme &&
    !Object.entries(savedScheme.triggers).some(
      ([key, value]) => success.triggers[key as keyof typeof success.triggers] ?? value,
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        showCloseButton={!saving}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              success
                ? "qq.entry.successTitle"
                : kind === "private"
                  ? "conversation.entry.addPrivate"
                  : "conversation.entry.addGroup",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(success ? "qq.entry.successHint" : "qq.entry.addHint")}
          </DialogDescription>
        </DialogHeader>
        {success ? (
          <div className="space-y-4">
            <p role="status" className="text-sm">
              {t("qq.entry.added", {
                kind: t(
                  success.kind === "private" ? "connections.privateChat" : "connections.group",
                ),
                peer: success.peer_id,
              })}
            </p>
            {!savedSummary && (
              <div className="space-y-2">
                <p role="status" className="text-sm text-muted-foreground">
                  {t("qq.entry.directoryPending")}
                </p>
                {state.directoryError && (
                  <p role="alert" className="text-sm text-destructive">
                    {translateNotice(state.directoryError)}
                  </p>
                )}
                <Button
                  variant="outline"
                  disabled={refreshingConversation}
                  tooltip={t("qq.entry.refreshConversationHint")}
                  onClick={() => void refreshConversation()}
                >
                  {t("qq.entry.refreshConversation")}
                </Button>
              </div>
            )}
            {savedSummary && savedSummary.lastSeq === 0 && (
              <p className="text-sm text-muted-foreground">{t("qq.entry.emptyConversation")}</p>
            )}
            {savedTriggersOff && (
              <p className="text-sm text-muted-foreground">{t("qq.entry.schemeInactive")}</p>
            )}
            {!state.qqSettings?.enabled && (
              <p className="text-sm text-muted-foreground">{t("qq.entry.globalOff")}</p>
            )}
            <DialogFooter>
              {savedSummary && (
                <Button
                  tooltip={t("qq.entry.viewHint")}
                  onClick={() => {
                    void state.requestConversationNavigation(savedSummary.id);
                    onClose();
                  }}
                >
                  {t("qq.entry.view")}
                </Button>
              )}
              <Button
                variant="outline"
                tooltip={t("qq.entry.configureHint")}
                onClick={() => onManage(success)}
              >
                {t("qq.entry.configure")}
              </Button>
            </DialogFooter>
          </div>
        ) : state.qqBindingsLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("schemes.bindings.reading")}
          </p>
        ) : !state.qqBindingsLoaded ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {t("schemes.bindings.loadFailed")}
            </p>
            {state.qqBindingsError && (
              <p className="text-sm text-muted-foreground">
                {translateNotice(state.qqBindingsError)}
              </p>
            )}
            <Button
              variant="outline"
              tooltip={t("hints.qq.bindingsRetry")}
              onClick={() => void state.loadQqBindingDirectory()}
            >
              {t("capabilities.retry")}
            </Button>
          </div>
        ) : (
          <>
            {!state.qqSettings?.account_id && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm">{t("qq.entry.accountMissing")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  tooltip={t("qq.entry.connectionHint")}
                  onClick={() => navigate("qq-connection")}
                >
                  {t("qq.entry.connection")}
                </Button>
              </div>
            )}
            {state.agents.length > 0 && state.qqSettings?.account_id && (
              <>
                <Field
                  label="connections.conversationType"
                  tooltip={t("hints.fieldExtra.bindingKind")}
                >
                  <NativeSelect
                    value={kind}
                    disabled={busy}
                    onChange={(e) => {
                      patch({
                        manualKind: e.target.value === "private" ? "private" : "group",
                        manualPicked: "",
                        manualPeer: "",
                      });
                      setQuery("");
                    }}
                  >
                    <option value="group">{t("connections.group")}</option>
                    <option value="private">{t("connections.privateChat")}</option>
                  </NativeSelect>
                </Field>
                <Field label="qq.entry.search" tooltip={t("qq.entry.searchHint")}>
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={busy}
                    placeholder={t("qq.entry.searchHint")}
                  />
                </Field>
                <Field
                  label="schemes.bindings.pickConversation"
                  tooltip={t("hints.fieldExtra.bindingPick")}
                >
                  <NativeSelect
                    value={inputs.manualPicked}
                    disabled={busy}
                    onChange={(e) => patch({ manualPicked: e.target.value })}
                  >
                    <option value="">{t("schemes.bindings.pickManual")}</option>
                    {inputs.manualPicked && !observed && (
                      <option value={inputs.manualPicked}>
                        {t("connections.unknown")} · {peer}
                      </option>
                    )}
                    {visible.map((row) => {
                      const binding = state.qqBindings.find(
                        (b) =>
                          b.account_id === row.account_id &&
                          b.kind === row.kind &&
                          b.peer_id === row.peer_id,
                      );
                      return (
                        <option
                          key={qqConversationKey(row)}
                          value={qqConversationKey(row)}
                        >{`${binding ? (summaryOf(binding)?.title ?? "") : ""} ${row.peer_id} · ${t(binding ? "qq.entry.alreadyAdded" : "schemes.bindings.observedUnbound")}`}</option>
                      );
                    })}
                  </NativeSelect>
                </Field>
                {!visible.length && (
                  <p className="text-xs text-muted-foreground">{t("qq.entry.noObserved")}</p>
                )}
                {bindingAccount && (
                  <p className="text-xs text-muted-foreground">
                    {t("qq.entry.botAccount", { account: bindingAccount })}
                  </p>
                )}
                {!inputs.manualPicked && (
                  <Field
                    label={kind === "private" ? "qq.entry.privateNumber" : "qq.entry.groupNumber"}
                    tooltip={t("hints.fieldExtra.bindingPeer")}
                  >
                    <Input
                      inputMode="numeric"
                      value={inputs.manualPeer}
                      disabled={busy}
                      aria-invalid={selfTarget}
                      aria-describedby={selfTarget ? selfTargetId : undefined}
                      placeholder={t(
                        kind === "private" ? "qq.entry.privateNumber" : "qq.entry.groupNumber",
                      )}
                      onChange={(e) => patch({ manualPeer: e.target.value })}
                    />
                  </Field>
                )}
                {selfTarget && (
                  <p id={selfTargetId} role="alert" className="text-xs text-destructive">
                    {t("qq.entry.selfTarget")}
                  </p>
                )}
                {existing && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm text-muted-foreground">
                      {t("schemes.bindings.boundElsewhere", {
                        "0":
                          state.qqSchemes.find((s) => s.id === existing.scheme_id)?.name ??
                          t("connections.unknown"),
                      })}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      tooltip={t("hints.qq.manageExistingBinding")}
                      onClick={() => {
                        patch({ manualPeer: "", manualPicked: "", manualAgentId: "" });
                        onManage(existing);
                      }}
                    >
                      {t("schemes.bindings.manageExisting")}
                    </Button>
                  </div>
                )}
                <div className="grid gap-4 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                  <Field label="connections.assistant" tooltip={t("hints.fieldExtra.bindingAgent")}>
                    <NativeSelect
                      value={inputs.manualAgentId}
                      disabled={busy}
                      onChange={(e) => patch({ manualAgentId: e.target.value })}
                    >
                      <option value="">{t("schemes.bindings.selectAgent")}</option>
                      {state.agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {!a.is_active ? ` · ${t("library.disabled")}` : ""}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="connections.schemes" tooltip={t("hints.fieldExtra.bindingScheme")}>
                    <NativeSelect
                      value={inputs.manualSchemeId}
                      disabled={busy}
                      onChange={(e) => patch({ manualSchemeId: e.target.value })}
                    >
                      <option value="">{t("schemes.bindings.selectScheme")}</option>
                      {inputs.manualSchemeId && !schemeAvailable && (
                        <option value={inputs.manualSchemeId}>
                          {t("schemes.bindings.schemeMissing")}
                        </option>
                      )}
                      {state.qqSchemes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                {schemeId && inputs.manualSchemeId && schemeId !== inputs.manualSchemeId && (
                  <p className="text-xs text-muted-foreground">
                    {t("qq.entry.retainedScheme", {
                      name: selectedScheme?.name ?? t("connections.unknown"),
                    })}
                  </p>
                )}
                {selectedScheme && !Object.values(selectedScheme.triggers).some(Boolean) && (
                  <p className="text-xs text-muted-foreground">{t("qq.entry.schemeInactive")}</p>
                )}
                {schemeName === null ? (
                  <Button
                    variant="link"
                    className="w-fit px-0"
                    disabled={busy}
                    tooltip={t("qq.entry.newSchemeHint")}
                    onClick={() => setSchemeName("")}
                  >
                    {t("connections.newScheme")}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <Field
                      label="connections.schemeName"
                      tooltip={t("hints.fieldExtra.schemeName")}
                    >
                      <Input
                        value={schemeName}
                        disabled={busy}
                        onChange={(e) => setSchemeName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void createScheme();
                          }
                        }}
                      />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={busy || !schemeName.trim()}
                        tooltip={t("qq.entry.newSchemeHint")}
                        onClick={() => void createScheme()}
                      >
                        {t("qq.entry.createAndUse")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        tooltip={t("hints.complete.cancel")}
                        onClick={() => setSchemeName(null)}
                      >
                        {t("connections.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
            {!state.agents.length && (
              <Button
                variant="outline"
                tooltip={t("qq.entry.agentHint")}
                onClick={() => navigate("basic")}
              >
                {t("qq.entry.createAgent")}
              </Button>
            )}
            {agent && !agent.is_active && (
              <p className="text-xs text-muted-foreground">{t("qq.entry.agentOff")}</p>
            )}
            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {translateNotice(state.error)}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                tooltip={t("qq.entry.closeHint")}
                disabled={saving}
                onClick={onClose}
              >
                {t("connections.cancel")}
              </Button>
              <Button
                tooltip={t("hints.qq.confirmBind")}
                disabled={!ready}
                onClick={() => void bind()}
              >
                {t("connections.bind")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
