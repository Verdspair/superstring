import type { SourceRef } from "../../shared/contracts/evidence";

export interface CodeRunnerLimits {
  /** 整段脚本的墙钟上限（毫秒）。 */
  readonly timeoutMs: number;
  /** 结论的 Unicode 字符数上限：超了判失败，不截断。 */
  readonly maxConclusionChars: number;
  /** 脚本最多能调用几次工具。 */
  readonly maxCalls: number;
  readonly concurrency: number;
  readonly memoryBytes: number;
  readonly maxTransferBytes: number;
}

export const CODE_RUN_DEFAULT_LIMITS: CodeRunnerLimits = Object.freeze({
  timeoutMs: 20_000,
  maxConclusionChars: 4_000,
  maxCalls: 32,
  concurrency: 3,
  memoryBytes: 32 * 1024 * 1024,
  maxTransferBytes: 1024 * 1024,
});

/**
 * 绑定：名字来自目录，参数由**脚本**给出——调用方负责校验形状与权限；
 * 返回值只给脚本，不整份进模型上下文（只回结论）。
 */
export type CodeRunnerBinding = (arguments_: Record<string, unknown>) => Promise<unknown>;

export interface CodeRunResult {
  readonly conclusion: string;
  /** 结论引用的来源：作为观测的来源随结果一起记（引用不是授权，读取侧仍会复验）。 */
  readonly refs?: readonly SourceRef[];
}

export interface CodeRunner {
  readonly available: boolean;
  run(input: {
    readonly script: string;
    readonly bindings: Readonly<Record<string, CodeRunnerBinding>>;
    readonly limits: CodeRunnerLimits;
    readonly signal: AbortSignal;
  }): Promise<CodeRunResult>;
}

export const unavailableCodeRunner: CodeRunner = Object.freeze({
  available: false,
  async run(): Promise<never> {
    throw Object.assign(new Error("CODE_EXECUTION_UNAVAILABLE: 没有配置代码沙箱"), {
      code: "CODE_EXECUTION_UNAVAILABLE",
    });
  },
});
