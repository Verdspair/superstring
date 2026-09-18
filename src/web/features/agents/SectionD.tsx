import type { PersonaResponse } from "../../../shared/contracts";
import { useI18n } from "../../i18n";
import type { AgentDraft } from "../../store";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
import { Field } from "../../ui/Field";

export function SectionD({ draft }: { draft: AgentDraft }) {
  const t = useI18n();
  const persona = useSuperstringStore((state) => state.persona);
  const patchPersona = useSuperstringStore((state) => state.patchPersona);
  const patchDraft = useSuperstringStore((state) => state.patchDraft);
  const saveCurrentSection = useSuperstringStore((state) => state.saveCurrentSection);
  const editablePersona =
    persona ??
    ({
      id: "",
      agent_id: "",
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
      created_at: "",
      updated_at: "",
    } satisfies PersonaResponse);
  const field = (key: keyof PersonaResponse) => String(editablePersona[key] ?? "");
  const updatePersona = (patch: Partial<PersonaResponse>) => {
    patchPersona(patch);
  };
  return (
    <div className="config-section">
      <h3>{t("B · 性格与人设")}</h3>
      <p>{t("留空字段不写入提示词。保存后覆盖原内容，不产生版本号。")}</p>
      <Accordion
        title="① 人设（身份与边界）"
        note={t("决定 Agent 是谁、不能做什么，优先级最高。")}
        open
      >
        <Field
          label={t("核心身份")}
          info={t("这个 Agent 是谁、扮演什么角色、服务什么目标。建议 100—400 字。")}
        >
          <textarea
            rows={5}
            value={field("core_identity")}
            onChange={(event) => updatePersona({ core_identity: event.target.value })}
            placeholder={t(
              "例如：你是「小助」，一位长期陪伴用户的本地中文助理，说话直接、不绕弯子。",
            )}
          />
        </Field>
        <Field
          label={t("互动边界")}
          info={t("明确不能做的事、必须拒绝的请求、以及遇到边界时怎么回应。")}
        >
          <textarea
            rows={5}
            value={field("interaction_boundaries")}
            onChange={(event) => updatePersona({ interaction_boundaries: event.target.value })}
          />
        </Field>
        <Field label={t("高级指令")} info={t("对全部行为都生效的补充规则。")}>
          <textarea
            rows={5}
            value={field("advanced_instructions")}
            onChange={(event) => updatePersona({ advanced_instructions: event.target.value })}
          />
        </Field>
      </Accordion>
      <Accordion title="② 性格（表达风格）" note={t("只影响怎么说，不改变身份与边界。")} open>
        <Field label={t("沟通风格")} info={t("语气、节奏、用词习惯、称呼方式。")}>
          <textarea
            rows={4}
            value={field("communication_style")}
            onChange={(event) => updatePersona({ communication_style: event.target.value })}
          />
        </Field>
        <Field
          label={t("示例对话")}
          info={t("示范语气与节奏；系统禁止复用样例里的人名、事实和话题。")}
        >
          <textarea
            rows={6}
            value={field("example_dialogues")}
            onChange={(event) => updatePersona({ example_dialogues: event.target.value })}
          />
        </Field>
        <Field
          label={t("性格强度")}
          info={t("0 = 完全不注入性格；100 = 完整注入。人设与边界不受此开关影响。")}
        >
          <div className="range-row">
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={draft.persona_intensity}
              onChange={(event) => patchDraft({ persona_intensity: Number(event.target.value) })}
            />
            <output>{draft.persona_intensity}</output>
          </div>
        </Field>
      </Accordion>
      <button
        type="button"
        className="primary internal-save"
        onClick={() => void saveCurrentSection()}
      >
        {t("保存当前分区配置")}
      </button>
    </div>
  );
}
