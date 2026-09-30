// 本群控制（ADR0019 §13.1）：QQ 群卡片与群顶部常显「启用 / 停用 + 本群配置」。
// 启停是只带 paused 的即时 PUT；「本群配置」走统一导航守卫；状态如实呈现阻止原因。
//
// 事实读取（2026-09-25）：默认每个实例自读一次整页事实（绑定/设置/连接），同屏多卡由 store 的
// 读取门去重，一次失败不再自动重试；目录行（方案详情的「使用会话」）由父级读取目录，传
// `loadFacts={false}` 不再回读，缺失的事实在状态里如实呈现为未知，启停仍按目录里的行可用。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { msg, translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";

export function QqGroupControls({
  bindingId,
  expectedAgentId,
  className,
  loadFacts = true,
}: {
  /** 绑定行 id；QQ 会话的 summary.sourceId 就是它。 */
  bindingId: string;
  /** 当前目录/会话指向的 Agent：与绑定不一致（改绑后的旧视图）时不可操作。 */
  expectedAgentId?: string;
  className?: string;
  /** 目录行交由父级读取时传 false：不发起整页读取，也不提供会触发回读的重试入口。 */
  loadFacts?: boolean;
}) {
  const { t } = useTranslation();
  const qqBindings = useSuperstringStore((s) => s.qqBindings);
  const qqBindingsLoaded = useSuperstringStore((s) => s.qqBindingsLoaded);
  const qqBindingsLoading = useSuperstringStore((s) => s.qqBindingsLoading);
  const qqBindingsError = useSuperstringStore((s) => s.qqBindingsError);
  const qqAccessLoading = useSuperstringStore((s) => s.qqAccessLoading);
  const qqSettings = useSuperstringStore((s) => s.qqSettings);
  const qqConnection = useSuperstringStore((s) => s.qqConnection);
  const agents = useSuperstringStore((s) => s.agents);
  const qqAccessSaving = useSuperstringStore((s) => s.qqAccessSaving);
  const qqGroupConfigSaving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const loadQqAccess = useSuperstringStore((s) => s.loadQqAccess);
  const openQqGroupConfig = useSuperstringStore((s) => s.openQqGroupConfig);
  // 操作自己的失败原因：全局 error 可能属于别的群/别的操作，启停失败必须在控件原地可见。
  const [operationError, setOperationError] = useState<string | null>(null);
  const rootClass = className
    ? `inline-flex flex-wrap items-center gap-1.5 ${className}`
    : "inline-flex flex-wrap items-center gap-1.5";
  // 首读补齐事实（绑定／设置／连接）：每实例只发起一次真实读取，同屏多卡由模块加载门去重；
  // 已有失败不再自动重试，重试交给用户；三个事实都在就不再读。目录行（loadFacts=false）不回读。
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (!loadFacts) return;
    if (qqBindingsLoaded && qqSettings && qqConnection) return;
    if (qqAccessLoading || qqBindingsLoading) return;
    if (qqBindingsError || attempted) return;
    setAttempted(true);
    void loadQqAccess();
  }, [
    attempted,
    loadFacts,
    loadQqAccess,
    qqBindingsLoaded,
    qqBindingsLoading,
    qqAccessLoading,
    qqSettings,
    qqConnection,
    qqBindingsError,
  ]);
  const retry = () => {
    const current = useSuperstringStore.getState();
    if (current.qqAccessLoading || current.qqBindingsLoading) return;
    void current.loadQqAccess();
  };
  if (!qqBindingsLoaded) {
    if (loadFacts && (qqAccessLoading || qqBindingsLoading))
      return (
        <span role="status" className={`${rootClass} text-xs text-muted-foreground`}>
          {t("schemes.qq.groupConfig.controls.reading")}
        </span>
      );
    // 从未尝试且没有失败：先不占位，等读取真正发起（或失败）再出现，避免闪一下「未知」。
    if (loadFacts && !attempted && !qqBindingsError) return null;
    // 事实未知就如实说未知；重试只在默认（自读）模式提供——目录行由父级负责重试。
    return (
      <span className={rootClass}>
        <span role="status" className="text-xs text-muted-foreground">
          {t("schemes.qq.groupConfig.controls.unknown")}
        </span>
        {loadFacts && (
          <Button variant="outline" size="sm" className="min-h-8 whitespace-normal" onClick={retry}>
            {t("capabilities.retry")}
          </Button>
        )}
      </span>
    );
  }
  const binding = qqBindings.find((row) => row.id === bindingId);
  // 绑定不存在（别处解绑）：把入口留给目录本身，不渲染死按钮。
  // 私聊（意外行）：本组件的作用域只看群，私聊不渲染群按钮。
  if (binding?.kind !== "group") return null;
  const wrongAgent = !!expectedAgentId && binding.agent_id !== expectedAgentId;
  const bindingBusy = qqAccessSaving || qqGroupConfigSaving;
  const agent = agents.find((row) => row.id === binding.agent_id);
  // 阻止原因按优先级如实呈现：改绑的旧视图最先（此刻再提暂停/运行只会误导），随后才是暂停、
  // 总开关、连接与 Agent；事实缺失（未读或读取未完成）呈现为未知而不是空。
  const status = wrongAgent
    ? t("schemes.qq.groupConfig.controls.wrongAgent")
    : binding.paused
      ? t("schemes.qq.groupConfig.controls.paused")
      : !qqSettings
        ? t("schemes.qq.groupConfig.controls.unknown")
        : !qqSettings.enabled
          ? t("schemes.qq.groupConfig.controls.globalOff")
          : !qqConnection
            ? t("schemes.qq.groupConfig.controls.unknown")
            : qqConnection.phase !== "ready"
              ? t("schemes.qq.groupConfig.controls.disconnected")
              : !agent
                ? t("schemes.qq.groupConfig.controls.unknown")
                : !agent.is_active
                  ? t("schemes.qq.groupConfig.controls.agentOff")
                  : t("schemes.qq.groupConfig.controls.enabled");
  const pause = (next: boolean) => {
    const current = useSuperstringStore.getState();
    if (current.qqAccessSaving || current.qqGroupConfigSaving) return;
    const row = current.qqBindings.find((item) => item.id === bindingId);
    if (row?.kind !== "group" || row.paused === next) return;
    if (expectedAgentId && row.agent_id !== expectedAgentId) return;
    setOperationError(null);
    void current.updateQqBindingRow(row, { paused: next }).then((ok) => {
      if (!ok) setOperationError(useSuperstringStore.getState().error ?? msg("操作失败，请重试。"));
    });
  };
  return (
    <fieldset aria-label={t("schemes.qq.groupConfig.controls.label")} className={rootClass}>
      {status && (
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        className="min-h-8 whitespace-normal"
        aria-pressed={!binding.paused}
        disabled={bindingBusy || wrongAgent || !binding.paused}
        onClick={() => pause(false)}
      >
        {t("schemes.qq.groupConfig.controls.enable")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="min-h-8 whitespace-normal"
        aria-pressed={binding.paused}
        disabled={bindingBusy || wrongAgent || binding.paused}
        onClick={() => pause(true)}
      >
        {t("schemes.qq.groupConfig.controls.disable")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="min-h-8 whitespace-normal"
        disabled={bindingBusy || wrongAgent}
        onClick={() => openQqGroupConfig(bindingId)}
      >
        {t("schemes.qq.groupConfig.controls.configure")}
      </Button>
      {operationError && (
        <span role="alert" className="text-xs text-destructive">
          {translateNotice(operationError)}
        </span>
      )}
    </fieldset>
  );
}
