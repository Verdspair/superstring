import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
// QQ 判断模型（0038，用户 2026-09-25）：判断开口兴趣打分用哪一个模型。
//
// 它出现在「快捷管理 → 默认模型」页（用户要求"判断开口兴趣打分的模型也加到这个界面里"），但存在
// `qq_settings` 上而不是助手或方案里：一份设置供所有群与私聊共用。选完立即保存——这是一个下拉，不是
// 一页字段，为它造一份草稿与保存按钮只会多一次"改了没保存"的机会。
//
// 第三方聊天总开关关着时置灰并说明原因（用户对齐的判据），并给出去打开它的入口。

import { useEffect } from "react";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { ModelUseHint } from "../models/ModelUseHint";
import { modelOptionLabel } from "../models/model-availability";

export function QqJudgementModelPage() {
  const t = useI18n();
  const settings = useSuperstringStore((s) => s.qqSettings);
  const loading = useSuperstringStore((s) => s.qqAccessLoading);
  const saving = useSuperstringStore((s) => s.qqAccessSaving);
  const error = useSuperstringStore((s) => s.error);
  const models = useSuperstringStore((s) => s.modelNames);
  const availability = {
    loaded: useSuperstringStore((s) => s.loadedModelNames),
    external: useSuperstringStore((s) => s.externalModelNames),
  };
  const load = useSuperstringStore((s) => s.loadQqSettings);
  const save = useSuperstringStore((s) => s.saveQqJudgementModel);
  // 第三方聊天的开关与配置住在运行模式页（2026-09-25 用户指示），所以这里指向那个视图而不是一条路由。
  const requestPageNavigation = useSuperstringStore((s) => s.requestPageNavigation);
  useEffect(() => {
    void load();
  }, [load]);
  const note = "QQ 全局：所有群与私聊共用同一个「判断开口兴趣打分」模型，不随当前助手切换。";
  if (!settings) {
    return (
      <SettingsGroup id="qq-judgement-model" title="QQ 判断模型" note={note}>
        {loading ? (
          <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
            {t("正在读取 QQ 设置…")}
          </p>
        ) : (
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("读取 QQ 设置失败：{0}", translateNotice(error ?? t("未连接")))}
            <Button
              variant="link"
              type="button"
              className="link-button h-auto p-0 text-sm"
              onClick={() => void load()}
            >
              {t("重试读取 QQ 设置")}
            </Button>
          </p>
        )}
      </SettingsGroup>
    );
  }
  const value = settings.judgement_model_name ?? "";
  const options = [...new Set([...models, ...(value === "" ? [] : [value])])];
  return (
    <SettingsGroup id="qq-judgement-model" title="QQ 判断模型" note={note}>
      <Field
        label="判断开口兴趣打分模型"
        info="未选择＝跟随每间会话绑定助手的对话模型；改选立即保存，所有群与私聊下一轮判断起生效。"
      >
        <NativeSelect
          className="w-full"
          aria-label={t("判断开口兴趣打分模型")}
          value={value}
          disabled={saving || !settings.enabled}
          onChange={(event) => void save(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">{t("跟随对话模型")}</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {modelOptionLabel(name, availability, t)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <ModelUseHint
        purpose="qq_judgement"
        configured={settings.judgement_model_name}
        saved={settings.judgement_model_name}
      />
      {settings.enabled ? (
        <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
          {t("当前判断模型：{0}", value === "" ? t("跟随对话模型") : value)}
        </p>
      ) : (
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("第三方聊天总开关关着，判断不会运行；这个选择先留着，打开开关后生效。")}
          <Button
            variant="link"
            type="button"
            className="link-button h-auto p-0 text-sm"
            onClick={() => requestPageNavigation("settings", "operating-mode")}
          >
            {t("前往运行模式")}
          </Button>
        </p>
      )}
    </SettingsGroup>
  );
}
