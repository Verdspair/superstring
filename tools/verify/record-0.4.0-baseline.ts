// 0.4.0 基线记录器：跑 P0 的全部场景，把指标写成 JSON——这是 P8 新旧对照里"旧"的那一侧。
//
// 用法（用 bun 跑，因为场景与夹具都是 TS）：
//   ./node_modules/.bin/bun tools/verify/record-0.4.0-baseline.ts
//   ./node_modules/.bin/bun tools/verify/record-0.4.0-baseline.ts --out artifacts/validation/0.4.0/P0/baseline.json
//
// 只读场景、只写一个文件：不调真实模型、不碰真实数据（每个场景用隔离库，跑完关闭）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { closeHarnesses } from "../../tests/harness/onebot";
import { ALL_SCENARIOS, type ScenarioMetric } from "../../tests/harness/scenarios";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex >= 0 && !args[outIndex + 1]) {
  console.error("[baseline] 用法：--out <路径>");
  process.exit(1);
}
const out = resolve(
  outIndex >= 0 ? (args[outIndex + 1] ?? "") : "artifacts/validation/0.4.0/P0/baseline.json",
);
const version = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const scenarios: ScenarioMetric[] = [];
for (const scenario of ALL_SCENARIOS) {
  const run = await scenario();
  scenarios.push(run.metric);
  const metric = run.metric;
  console.log(
    `[baseline] ${metric.name}：状态 ${metric.status}、模型调用 ${metric.modelCalls}、发送 ${metric.sends}` +
      (metric.error === null ? "" : `、错误 ${metric.error}`),
  );
}
closeHarnesses();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      kind: "superstring-0.4.0-baseline",
      createdAt: new Date().toISOString(),
      version,
      scenarioCount: scenarios.length,
      scenarios,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`[baseline] 已写入 ${out}`);
