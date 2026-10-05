// QQ 图片输入契约（T01）：默认 native、三阶段独立 bool（允许全 false）、严格字段、
// 1–10 帧与 64–2048 尺寸边界（复用现有 rhythm 数值边界）、ordinary null=原图不是「跟随」。

import { expect, test } from "bun:test";
import {
  QQ_MEDIA_INPUT_DEFAULT,
  type QqImageCategory,
  type QqImagePhase,
  type QqMediaInputSettings,
  QqMediaInputSettingsSchema,
} from "../../src/shared/contracts/qq-media-input";

test("approved defaults and boundaries", () => {
  // 计划 T01 Step1 锚点测试（逐字）。
  expect(QQ_MEDIA_INPUT_DEFAULT).toEqual({
    mode: "native",
    stages: { decision: true, evaluation: true, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: null,
    expression_max_dimension: 512,
    expression_frame_count: 3,
    expression_frame_max_dimension: 512,
  });
  expect(
    QqMediaInputSettingsSchema.safeParse({
      ...QQ_MEDIA_INPUT_DEFAULT,
      stages: { decision: true, evaluation: true, generation: true, extra: true },
    }).success,
  ).toBe(false);
});

test("mode 与顶层字段严格：额外字段拒绝、mode 只有两个值", () => {
  expect(
    QqMediaInputSettingsSchema.safeParse({ ...QQ_MEDIA_INPUT_DEFAULT, extra: 1 }).success,
  ).toBe(false);
  expect(
    QqMediaInputSettingsSchema.safeParse({ ...QQ_MEDIA_INPUT_DEFAULT, mode: "hybrid" }).success,
  ).toBe(false);
  expect(
    QqMediaInputSettingsSchema.safeParse({ ...QQ_MEDIA_INPUT_DEFAULT, mode: "description" })
      .success,
  ).toBe(true);
  // max_images：正整数（具体上限执行期由服务/安全约束验证，schema 只要求正整数）。
  expect(
    QqMediaInputSettingsSchema.safeParse({ ...QQ_MEDIA_INPUT_DEFAULT, max_images: 1 }).success,
  ).toBe(true);
  expect(
    QqMediaInputSettingsSchema.safeParse({ ...QQ_MEDIA_INPUT_DEFAULT, max_images: 0 }).success,
  ).toBe(false);
  expect(
    QqMediaInputSettingsSchema.safeParse({ ...QQ_MEDIA_INPUT_DEFAULT, max_images: 100 }).success,
  ).toBe(true);
  expect(
    QqMediaInputSettingsSchema.safeParse({ ...QQ_MEDIA_INPUT_DEFAULT, max_images: 1.5 }).success,
  ).toBe(false);
});

test("stages 三个 bool 独立，允许全 false（图片开关开但不自动发，仅按需）", () => {
  const allFalse = QqMediaInputSettingsSchema.parse({
    ...QQ_MEDIA_INPUT_DEFAULT,
    stages: { decision: false, evaluation: false, generation: false },
  });
  expect(allFalse.stages).toEqual({ decision: false, evaluation: false, generation: false });
  // 缺一个阶段不是全 false，是形状错误。
  expect(
    QqMediaInputSettingsSchema.safeParse({
      ...QQ_MEDIA_INPUT_DEFAULT,
      stages: { decision: false, evaluation: false },
    }).success,
  ).toBe(false);
});

test("尺寸 64–2048、帧数 1–10；ordinary_still_max_dimension null=原图（不是跟随）", () => {
  const dimension = (value: number | null): boolean =>
    QqMediaInputSettingsSchema.safeParse({
      ...QQ_MEDIA_INPUT_DEFAULT,
      ordinary_still_max_dimension: value,
      expression_max_dimension: value,
      expression_frame_max_dimension: value,
    }).success;
  expect(dimension(64)).toBe(true);
  expect(dimension(2048)).toBe(true);
  expect(dimension(63)).toBe(false);
  expect(dimension(2049)).toBe(false);
  // ordinary 单独允许 null=原图；expression 尺寸不允许 null。
  expect(
    QqMediaInputSettingsSchema.safeParse({
      ...QQ_MEDIA_INPUT_DEFAULT,
      ordinary_still_max_dimension: null,
    }).success,
  ).toBe(true);
  expect(
    QqMediaInputSettingsSchema.safeParse({
      ...QQ_MEDIA_INPUT_DEFAULT,
      expression_max_dimension: null,
    }).success,
  ).toBe(false);
  const frames = (value: number): boolean =>
    QqMediaInputSettingsSchema.safeParse({
      ...QQ_MEDIA_INPUT_DEFAULT,
      expression_frame_count: value,
    }).success;
  expect(frames(1)).toBe(true);
  expect(frames(10)).toBe(true);
  expect(frames(0)).toBe(false);
  expect(frames(11)).toBe(false);
});

test("§2.3 类型逐字沿用：字面量联合与 effective 扩展的编译期钉子", () => {
  const phase: QqImagePhase = "decision";
  const category: QqImageCategory = "expression";
  expect(phase).toBe("decision");
  expect(category).toBe("expression");
  const settings: QqMediaInputSettings = QQ_MEDIA_INPUT_DEFAULT;
  expect(settings.mode).toBe("native");
});
