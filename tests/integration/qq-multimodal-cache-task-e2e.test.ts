//
// T15 P5 补块（resume-t15-cache-tasks）：矩阵 ids 41–47（读取任务预算/缓存/取消/跨 scope/
// expiry）的链路验证。唯一新文件；不改 qq-message-multimodal-e2e.test.ts、tests/harness
// 或任何生产代码。
//
// 链路分层（如实标注，不冒充整链）：
//  * [S41]/[S42]/[S44-run 级] 整链 = createOneBotHarness 真实 OneBot wire→intake→宿主→
//    生产 createQqMediaTools（宿主装配）→readQqMediaTaskOnce→夹具 vision/bytes；模型经
//    decideInvoke 真实驱动；视觉调用用 h.visionCalls 真计数。
//  * [S43]/[S44-tool 级]/[S45]/[S46]/[S47] 生产组件集成（辅助）= 生产 createQqMediaTools
//    mount 在 harness 同一业务库上（qq-media-typed-tools 同形态，不建第二库/第二模型链）。
//    补充时间语义（equal/earlier 拒、严格更晚解锁）由宿主 freshSupplementLaterThan 真查
//    journal（受控 occurredAt 的真实 journal 事件），不用 boolean shim。
//  * [S44] 两个取消子面：tool 级 = 测试自持 AbortController 在生产 adapter.read 挂起期间
//    abort（生产 reader cleanup 路径，已消耗尝试结清 failed）+ 过期 claim token 的 CAS 拒；
//    run 级 = h.activate("direct_reply", { signal }) 真实宿主 run，caller 在 run 在飞时
//    abort（生产工具边界拒绝 claim，不烧尝试）。proveSupplementLaterThan 的 () => true 只
//    用于隔离 claim-token CAS 子面，不作为补充证据语义的通过证据。
//  * [S41] detail attempt-2 补充闸**已接线**（当前实物：producer `qq-media-tools.ts` sha256
//    536c9620…／reader `qq-media-reader.ts` a5cfaad5…）：detail 分支有自己的
//    `proveDetailSupplementLaterThan`——按 purpose=detail + questionKey 取那条预算行、基准
//    取该行 claim CAS 打点的 lastAttemptAt，再真查 journal（严格更晚／窗口内／同 scope／
//    member 的 mention|reply_to_agent|legacy_addressed／排除原图自身）。baseline 分支同规则、
//    同基准来源。旧注释「detail 未接线／恒 fail closed」随该接线作废；正例与强负例见下方
//    [S41] 与 [S41-neg]。
//
// 红线：不 import artifacts；不触真实数据/网络/服务；结果撤销走真实清理入口
// purgeExpiredMediaNotes（不手工改任务行状态）；mint/复验用生产 createQqMediaSourceRef +
// sourceAccess；资产/来源 link 用生产 recordMediaAsset/linkMediaAssetSource（真实
// bytes/hash；到期取夹具时钟未来值——夹具时钟是 2033 域）。

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { ActionContext } from "../../src/server/agent/built-in-actions";
import { sourceAccess } from "../../src/server/agent/context-access";
import {
  readBindingByConversation,
  toContractQqBinding,
} from "../../src/server/db/qq-binding-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import {
  mediaNoteRow,
  purgeExpiredMediaNotes,
  recordMediaSegment,
} from "../../src/server/db/qq-media-repository";
import {
  attemptMediaReadTask,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, DEFAULT_USER_ID, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import {
  createQqMediaTools,
  type QqMediaToolsOptions,
} from "../../src/server/services/qq-media-tools";
import { decideInline, decideInvoke, type ModelStep } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";
import { driveToolFirst } from "../harness/scenarios";

afterEach(closeHarnesses);

const ACCOUNT = "90001";
const PEER = "30003";
const AGENT = DEFAULT_AGENT_ID;
const POLICY = "baseline/v1/e2e-p5";
const png8 = (fill: number) => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(fill), 8, 8);
const bytes = () => png8(64);

type DescribeValue =
  | {
      status: "described";
      described: true;
      attempt: number;
      id: string;
      model: string;
      text: string;
      offset: number;
      nextOffset: number | null;
    }
  | { status: "failed"; described: false; attempt: number; awaitSupplement: boolean }
  | { status: "unavailable"; code: string };

interface TaskRow {
  id: string;
  mediaNoteId: string | null;
  identityKey: string | null;
  purpose: string;
  questionKey: string | null;
  attempts: number;
  status: string;
  lastAttemptAt: string | null;
  note: string | null;
  revision: number;
}

/** [S41] 第三次视觉的真实成功描述：正例的正文必须来自这里，不能只是 status。 */
const SUPPLEMENT_DESCRIPTION = "第二次真实读取的合成描述";

/** 本轮真实发出的 describe 序列（只在本文件内维护，不动 tests/harness/onebot.ts）。 */
interface IssuedDescribe {
  readonly purpose: "baseline" | "detail";
  readonly questionMessageId: string | null;
}

/** 一轮 describe 的结果收件箱：只按「真实观察到的 media.describe 观察」入列。 */
interface DetailCapture {
  readonly detailValues: DescribeValue[];
}

/** 一轮宿主 run 的账：视觉调用增量、typed 任务账本全量、describe 结果、刻度。 */
interface RunTrace {
  readonly label: string;
  readonly visionDelta: readonly { model: string; prompt: string }[];
  readonly issued: readonly IssuedDescribe[];
  readonly ledgerBefore: readonly TaskRow[];
  readonly ledgerAfter: readonly TaskRow[];
  readonly detailValues: readonly DescribeValue[];
  readonly clockSeconds: number;
  readonly nowIso: string;
  /**
   * 本轮每条 describe 与 typed 账本 attempts 增量的配对结果（见 `pairingOf`）。只由
   * `runTrace` 在跑完之后算出，不来自任何夹具字段或产品状态。
   */
  readonly issuedPairing: readonly ("baseline" | "detail")[];
  /**
   * 本轮宿主 run 的真实返回（`h.activate` 的原样返回）。只记录、不硬编形状：null＝唤醒
   * 领取层就没有该类可领取唤醒（run 未启动）；非 null 则是宿主终态对象（status/reason）。
   * 负触发的可观测面由 modelCalls/issued/vision/ledger 断言回答，不猜 reason 值。
   */
  readonly runResult?: unknown;
  /** 本轮模型端口真实收件数（scripted 端口 `receivedMessages` 公开面）的前后快照。 */
  readonly modelCallsBefore?: number | null;
  readonly modelCallsAfter?: number | null;
}

/** `pairingOf` 只需要账的前后两份与本轮 describe；与完整 RunTrace 同形。 */
type RunTraceLedger = Omit<RunTrace, "issuedPairing">;

const taskLedger = (h: OneBotHarness): TaskRow[] =>
  h.db
    .query(
      "SELECT id,media_note_id AS mediaNoteId,identity_key AS identityKey,purpose,question_key AS questionKey,attempts,status,last_attempt_at AS lastAttemptAt,note,revision FROM qq_media_read_tasks ORDER BY purpose",
    )
    .all() as TaskRow[];

/**
 * 该 purpose 必须**有且只有一行**：0 行或 2 行都显式失败。这样「凭空多出一条新预算行」
 * 不会被 `find` 静默吞掉，baseline/detail 两条独立预算的唯一性由取行本身保证。
 */
const uniqueLedgerRow = (rows: readonly TaskRow[], purpose: string): TaskRow => {
  const matched = rows.filter((row) => row.purpose === purpose);
  if (matched.length !== 1) {
    throw new Error(`ledger must hold exactly one ${purpose} row, found ${matched.length}`);
  }
  const only = matched[0];
  if (only === undefined) throw new Error(`ledger ${purpose} row vanished`);
  return only;
};

/** 该 purpose 的 attempts；行不存在时返回 0（配对只看增量，不在这里判存在性）。 */
const attemptsOf = (rows: readonly TaskRow[], purpose: string): number =>
  rows
    .filter((row) => row.purpose === purpose)
    .reduce((max, row) => Math.max(max, row.attempts), 0);

/**
 * 把「本轮真实发出的 describe」与「typed 任务账本的真实 attempts 增量」配对：每个
 * describe 必须让某条 purpose 预算行的 attempts 真的 +1，且该行在 run 后新增。配不上的
 * describe 不被丢弃——它会让 pairing 少一段，从而让断言失败，而不是静默忽略。
 */
const pairingOf = (trace: RunTraceLedger): ("baseline" | "detail")[] => {
  const pairing: ("baseline" | "detail")[] = [];
  for (const entry of trace.issued) {
    const before = attemptsOf(trace.ledgerBefore, entry.purpose);
    const after = attemptsOf(trace.ledgerAfter, entry.purpose);
    if (after === before + 1) pairing.push(entry.purpose);
  }
  return pairing;
};

const purposeLedger = (h: OneBotHarness): TaskRow[] => taskLedger(h).map((row) => ({ ...row }));

/**
 * S41 真实 trace 的落盘位置：只由 `SUPERSTRING_S41_TRACE_DIR` 指定（测试自己定的 A 目录），
 * 用 Bun 自带 fs；不 import artifacts、也不从 artifacts 读任何东西。未指定该变量时
 * 完全不写盘。
 */
const s41TraceDir = (): string | null => process.env.SUPERSTRING_S41_TRACE_DIR ?? null;

/**
 * 落一份独有 trace 文件：**只新建、不覆盖**（文件名带 Date.now()+pid，末尾序号去重）。
 * 落点只由 `SUPERSTRING_S41_TRACE_DIR` 指定；未设该变量时完全返回，测试不写任何盘。
 */
const writeS41Trace = (payload: {
  readonly case: string;
  readonly run: string;
  readonly phase: "after-run" | "on-throw" | "case-final";
  readonly error?: string;
  readonly ledger: readonly TaskRow[];
  readonly run3?: RunTrace;
}): string | null => {
  const dir = s41TraceDir();
  if (dir === null) return null;
  mkdirSync(dir, { recursive: true });
  const stem = `s41-${payload.case}-${payload.run}-${payload.phase}`;
  let name = `${stem}-${Date.now()}-${process.pid}.json`;
  for (let n = 2; existsSync(path.join(dir, name)); n += 1) {
    name = `${stem}-${Date.now()}-${process.pid}-${n}.json`;
  }
  writeFileSync(path.join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return name;
};

/**
 * 跑一轮宿主 run 期间已捕到的全部现场（成功或抛错都用它落盘）。形状与 `RunTrace` 相同：
 * 配对在这里就已算好，所以落盘的那份不需要读者再推一次。
 */
type RunTraceSnapshot = RunTrace;

const snapshotRun = (
  h: OneBotHarness,
  label: string,
  issued: IssuedDescribe[],
  capture: DetailCapture,
  taken: {
    readonly ledgerBefore: readonly TaskRow[];
    readonly visionBefore: number;
    readonly issueBefore: number;
    readonly detailBefore: number;
    readonly clockSeconds: number;
    readonly modelCallsBefore: number | null;
  },
): RunTraceSnapshot => {
  const trace: Omit<RunTrace, "issuedPairing"> = {
    label,
    visionDelta: h.visionCalls.slice(taken.visionBefore).map((call) => ({ ...call })),
    issued: issued.slice(taken.issueBefore).map((entry) => ({ ...entry })),
    ledgerBefore: taken.ledgerBefore,
    ledgerAfter: taskLedger(h),
    detailValues: capture.detailValues.slice(taken.detailBefore).map((value) => ({ ...value })),
    clockSeconds: taken.clockSeconds,
    nowIso: h.now(),
    modelCallsBefore: taken.modelCallsBefore,
    modelCallsAfter: h.model?.receivedMessages.length ?? null,
  };
  return { ...trace, issuedPairing: pairingOf(trace) };
};

/**
 * 跑一轮宿主 run，并在**返回给调用方之前**（即调用方任何 expect 之前）把这一轮完整账
 * 落成一个真实文件：成功时 phase=after-run；run 抛错时 phase=on-throw 并带错误原文，
 * 然后把原错误原样抛出。断言失败不再意味着盘上只有最后一份总结。
 */
const runTrace = async (
  h: OneBotHarness,
  label: string,
  issued: IssuedDescribe[],
  capture: DetailCapture,
  caseName: string,
  run: () => Promise<unknown>,
): Promise<RunTrace> => {
  const taken = {
    ledgerBefore: taskLedger(h),
    visionBefore: h.visionCalls.length,
    issueBefore: issued.length,
    detailBefore: capture.detailValues.length,
    clockSeconds: h.clock.seconds,
    modelCallsBefore: h.model?.receivedMessages.length ?? null,
  };
  let failure: unknown = null;
  let returned: unknown;
  try {
    returned = await run();
  } catch (error) {
    failure = error;
  }
  const snapshot: RunTraceSnapshot = {
    ...snapshotRun(h, label, issued, capture, taken),
    runResult: returned,
  };
  writeS41Trace({
    case: caseName,
    run: label,
    phase: failure === null ? "after-run" : "on-throw",
    ...(failure === null ? {} : { error: String(failure) }),
    ledger: snapshot.ledgerAfter,
    run3: snapshot,
  });
  if (failure !== null) throw failure;
  return snapshot;
};

/** 全部 typed 读取任务行（真实库读回，含 questionKey 与 claim 打点时刻）。 */
function taskRows(h: OneBotHarness): TaskRow[] {
  return taskLedger(h);
}

const eventKeyOf = (messageId: string) => JSON.stringify(["qq", ACCOUNT, "group", PEER, messageId]);

function imageNote(h: OneBotHarness, messageId: string): string {
  const row = mediaNoteRow(h.orm, eventKeyOf(messageId), 1);
  if (!row) throw new Error(`media note missing for ${messageId}`);
  return row.id;
}

function seedAsset(
  h: OneBotHarness,
  mediaNoteId: string,
  sourceBytes: Uint8Array,
  scope = { accountId: ACCOUNT, conversationKind: "group" as const, peerId: PEER, agentId: AGENT },
) {
  const future = new Date(Date.parse(h.now()) + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { asset } = recordMediaAsset(h.orm, {
    scope,
    bytes: sourceBytes,
    mimeType: "image/png",
    expiresAt: future,
  });
  linkMediaAssetSource(h.orm, {
    assetId: asset.id,
    mediaNoteId,
    scope,
    expiresAt: future,
  });
}

function seedMediaEvent(
  h: OneBotHarness,
  input: {
    eventKey: string;
    peerId?: string;
    agentId?: string;
    bindingId?: string;
    at?: number;
    sourceRef?: string;
  },
) {
  const peerId = input.peerId ?? PEER;
  const agentId = input.agentId ?? AGENT;
  const at = input.at ?? Math.floor(Date.now() / 1000);
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: input.eventKey,
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId,
      agentId,
      messageId: `message-${input.eventKey}`,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: "20002",
      addressed: 1,
      recordedAt: nowIso(),
    })
    .run();
  const seg = recordMediaSegment(h.orm, {
    eventKey: input.eventKey,
    segmentIndex: 0,
    kind: "image",
    sourceRef: input.sourceRef ?? `ref-${input.eventKey}`,
    occurredAtSeconds: at,
    addressed: true,
  });
  h.orm
    .update(schema.qqMediaNotes)
    .set({ expiresAt: new Date(Date.parse(h.now()) + 14 * 24 * 60 * 60 * 1000).toISOString() })
    .where(eq(schema.qqMediaNotes.id, seg.id))
    .run();
  h.journal.ingestOneBotEvent(input.eventKey, input.bindingId ?? h.bindingId);
  return seg;
}

interface ToolMount {
  stats: { calls: number };
  context: (runId: string) => { controller: AbortController; ctx: ActionContext };
  execute: (
    name: string,
    args: Record<string, unknown>,
    ctx: ActionContext,
  ) => Promise<{ value: unknown; sources: readonly unknown[] }>;
}

function mountTools(
  h: OneBotHarness,
  input: {
    adapter?: QqMediaToolsOptions["adapter"];
    conversationId?: string;
    peerId?: string;
    agentId?: string;
    bindingId?: string;
    now?: () => string;
  } = {},
): ToolMount {
  const peerId = input.peerId ?? PEER;
  const agentId = input.agentId ?? AGENT;
  // 两个分支都必须产出**契约形状**的 binding（`paused` 是 boolean、`kind` 来自
  // conversation_kind），所以按 id 读的那条也走生产同一个 `toContractQqBinding`，
  // 而不是把 Drizzle 原始行摊开冒充契约对象。
  const binding =
    input.bindingId !== undefined
      ? (() => {
          const raw = h.orm
            .select()
            .from(schema.qqBindings)
            .where(eq(schema.qqBindings.id, input.bindingId))
            .get();
          return raw === undefined ? null : toContractQqBinding(raw);
        })()
      : readBindingByConversation(h.orm, { accountId: ACCOUNT, kind: "group", peerId });
  if (!binding) throw new Error("binding fixture missing");
  const conversationId = input.conversationId ?? h.conversationId;
  const stats = { calls: 0 };
  const adapter: QqMediaToolsOptions["adapter"] =
    input.adapter ??
    ({
      capabilities: ["image"] as const,
      fetchBytes: async () => ({ bytes: bytes() }),
      read: async () => {
        stats.calls += 1;
        return "mount 描述";
      },
    } as QqMediaToolsOptions["adapter"]);
  const actions = createQqMediaTools({
    db: h.db,
    orm: h.orm,
    conversationId,
    binding,
    adapter,
    modelConfig: { visionModelName: "vision-stub", transcriptionModelName: null },
    supplementWindowMinutes: 10,
    policyRevision: POLICY,
    ...(input.now !== undefined ? { now: input.now } : {}),
    assertCurrent: () => {
      const current = readBindingByConversation(h.orm, {
        accountId: ACCOUNT,
        kind: "group",
        peerId,
      });
      if (
        !current ||
        current.agentId !== agentId ||
        current.authorityRevision !== binding.authorityRevision ||
        current.paused
      ) {
        throw Object.assign(new Error("宿主授权已变化"), { code: "CONTEXT_SOURCE_INVALID" });
      }
    },
    fit: async () => () => true,
    evidence: { db: h.db, orm: h.orm },
  });
  const named = (name: string) => {
    const action = actions.find((entry) => entry.description.name === name);
    if (!action) throw new Error(`missing action ${name}`);
    return action;
  };
  return {
    stats,
    context: (runId) => ({
      controller: new AbortController(),
      ctx: {
        owner: {
          kind: "conversation" as const,
          id: conversationId,
          userId: DEFAULT_USER_ID,
          agentId,
        },
        runId,
        signal: new AbortController().signal,
      },
    }),
    execute: (name, args, ctx) => named(name).execute(args, ctx),
  };
}

/** biome noNonNullAssertion 合规：断言后取值统一走本 helper（null 即显式失败）。 */
function nonNull<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture missing: ${label}`);
  return value;
}

describe("QQ multimodal cache/task P5 (ids 41-47)", () => {
  it("[S41][整链] baseline 与 detail 各自独立预算；detail 第二次尝试由真实更晚补充解锁", async () => {
    const h = createOneBotHarness({
      accountId: ACCOUNT,
      mediaEnabled: true,
      // 单一顺序游标：用完重复最后一项。run1 的 baseline 与 detail 各吃一次真实失败，
      // run3 的 detail 第二次吃这一条真实成功描述——正例必须来自合成出来的成功答复，
      // 不能靠把成功期望改成 failed 叫绿。
      vision: ["fail", "fail", SUPPLEMENT_DESCRIPTION],
      imageBytes: { b1: bytes() },
      model: [],
    });
    // 本轮真实由模型发出的 describe 序列（purpose 由 decide 的入参形态决定）。它与逐轮
    // visionCalls 增量、typed 任务账本三方对账：每条 describe 各自消耗一次真实视觉调用，
    // 落在哪条 purpose 预算行由 typed 账本的真实 attempts 增量回答。不给夹具加新字段。
    const issued: IssuedDescribe[] = [];
    const traces: RunTrace[] = [];
    const capture: DetailCapture = { detailValues: [] };
    let queue: string[] = [];
    let runMediaId = "";
    const ask = (next: string): ModelStep[] => {
      const detail = next === "detail";
      issued.push({
        purpose: detail ? "detail" : "baseline",
        questionMessageId: detail ? "-411" : null,
      });
      return [
        decideInvoke(
          "media.describe",
          detail ? { id: runMediaId, questionMessageId: "-411" } : { id: runMediaId },
        ),
      ];
    };
    driveToolFirst(h, (observation) => {
      if (observation?.name === "media.describe") {
        capture.detailValues.push(observation.value as DescribeValue);
      }
      if (observation?.name === "media.list") {
        const items = (observation.value as { items: { id: string }[] }).items;
        if (items.length === 0) return [decideInline("20002", "没有图", [])];
        runMediaId = nonNull(items[0], "items[0]").id;
        if (queue.length === 0) return [decideInline("20002", "没有要做的读取", [])];
        return ask(nonNull(queue.shift(), "queue.shift()"));
      }
      if (observation?.name === "media.describe") {
        if (queue.length > 0) return ask(nonNull(queue.shift(), "queue.shift()"));
        return [decideInline("20002", "已处理", [])];
      }
      return null;
    });
    // Run1（focus=图片消息 -411）：baseline describe 失败烧 attempt 1；同 run 内 detail
    // describe（questionMessageId=focus 本身，宿主 resolver 真源）独立烧 detail attempt 1。
    h.model?.push([decideInvoke("media.list", {})]);
    queue = ["baseline", "detail"];
    h.receive({ id: "-411", speaker: "20002", addressed: true, image: "b1", text: "看图" });
    const mediaId = imageNote(h, "-411");
    seedAsset(h, mediaId, bytes());
    const run1 = await runTrace(
      h,
      "run1-baseline-and-detail-attempt1",
      issued,
      capture,
      "S41",
      async () => {
        await h.activate("direct_reply");
      },
    );
    traces.push(run1);
    // 本 run 真实发出两次 describe（baseline + detail），所以收件箱里就是**两条**观察。
    expect(run1.visionDelta).toHaveLength(2);
    expect(run1.detailValues).toHaveLength(2);
    // 两条观察按真实契约逐项断：都被 @ 叫到，两次都是第一次尝试、都真失败，且都还等补充
    // （attempts 1 < 上限 2 → awaitSupplement 真为 true）。少断一项就会放过「其实没烧到
    // 第二次预算」或「失败被吞成 unavailable」这两种假绿。
    for (const value of run1.detailValues) {
      expect(value).toEqual({
        status: "failed",
        described: false,
        attempt: 1,
        awaitSupplement: true,
      });
    }
    // 账本恰好两条、各一条：多一条新预算行会被 uniqueLedgerRow 直接判失败。
    expect(run1.ledgerAfter.map((row) => row.purpose)).toEqual(["baseline", "detail"]);
    expect(run1.ledgerAfter.every((row) => row.attempts === 1)).toBe(true);
    expect(run1.ledgerAfter.every((row) => row.status === "failed")).toBe(true);
    expect(pairingOf(run1)).toEqual(["baseline", "detail"]);
    // detail 行带 questionKey、baseline 行为 NULL：两条独立预算，绝不合流。
    const detailRow1 = uniqueLedgerRow(run1.ledgerAfter, "detail");
    const baselineRow1 = uniqueLedgerRow(run1.ledgerAfter, "baseline");
    expect(detailRow1.questionKey).not.toBeNull();
    expect(baselineRow1.questionKey).toBeNull();
    expect(detailRow1.id).not.toBe(baselineRow1.id);
    const baselineStampRun1 = baselineRow1.lastAttemptAt;
    // Run2（focus=无 @ 闲聊，没有 addressed 回应机会）：**负触发对照**。本轮宿主没有可
    // 回答的机会，根本不会走到模型——所以零模型收件、零工具、零视觉、账本原样。上一版在
    // 这里预置 media.list 脚本并期待一次 baseline describe（detailValues expected 1）是
    // 错误流程前提：未被触发的 run 不产生任何 describe，把期望改成 0 不是给产品失败放行，
    // 而是把负触发明示出来；预置脚本若不被消耗还会留在队列里污染 run3 的脚本队列。因此
    // 本轮**不预置任何脚本步骤**，只静读脚本队列余量做前后对照；run 的真实返回与模型收件
    // 前后数（scripted 端口 receivedMessages 公开面）由 runTrace 原样落盘。
    h.advance(1);
    const scriptBeforeRun2 = nonNull(h.model, "h.model").remaining();
    h.receive({ id: "-412", speaker: "20002", addressed: false, text: "刚才那张怎么了" });
    const run2 = await runTrace(
      h,
      "run2-unrelated-later-refused",
      issued,
      capture,
      "S41",
      async () => {
        await h.activate("direct_reply");
      },
    );
    traces.push(run2);
    // run 的真实返回已原样进 trace（runResult）：null＝唤醒领取层就没有可领取的
    // direct_reply 唤醒（run 未启动）；非 null 则是宿主终态对象。不把具体 reason 硬编成
    // 断言——「未触发」由下面四组可观测断言回答。
    expect(run2.modelCallsAfter).toBe(run2.modelCallsBefore);
    expect(run2.issued).toEqual([]);
    expect(run2.detailValues).toHaveLength(0);
    expect(run2.visionDelta).toHaveLength(0);
    // 整份 typed 账本与 run1 之后**逐字相同**：不烧尝试、不新增预算行、不动打点时刻；
    // 没有任何 attempts 增量，所以配对为空。
    expect(run2.ledgerAfter).toEqual(run1.ledgerAfter);
    expect(run2.ledgerAfter.every((row) => row.attempts === 1)).toBe(true);
    expect(pairingOf(run2)).toEqual([]);
    // 脚本队列原样：本轮没有预置、也没有消耗任何步骤，run3 的脚本队列不被污染。
    expect(nonNull(h.model, "h.model").remaining()).toBe(scriptBeforeRun2);
    // Run3（focus 回复引用 -411 → 宿主 resolver 以 replyTo 直接目标放行问题锚）：
    // 严格更晚的 addressed 消息构成真实补充证据，detail 花 attempt 2 并成功描述。
    h.advance(1);
    h.model?.push([decideInvoke("media.list", {})]);
    queue = ["detail"];
    h.receive({
      id: "-413",
      speaker: "20002",
      addressed: true,
      replyTo: "-411",
      text: "细问一下",
    });
    const run3 = await runTrace(
      h,
      "run3-later-supplement-unlocks-attempt2",
      issued,
      capture,
      "S41",
      async () => {
        await h.activate("direct_reply");
      },
    );
    traces.push(run3);
    // spec：detail 独立预算第二次尝试由真实更晚补充解锁，产出真实描述。
    expect(run3.detailValues).toEqual([
      {
        status: "described",
        described: true,
        attempt: 2,
        id: mediaId,
        model: "vision-stub",
        text: SUPPLEMENT_DESCRIPTION,
        offset: 0,
        nextOffset: null,
      },
    ]);
    expect(run3.visionDelta).toHaveLength(1);
    expect(pairingOf(run3)).toEqual(["detail"]);
    const detailRow3 = uniqueLedgerRow(run3.ledgerAfter, "detail");
    expect(detailRow3).toMatchObject({
      attempts: 2,
      status: "succeeded",
      note: SUPPLEMENT_DESCRIPTION,
    });
    // 第二次尝试落在**同一条 detail 预算行**上：questionKey 与 task id 都与 run1 相同——
    // 不是新开一条 detail 预算，也不是换了一个问题身份。
    expect(detailRow3.id).toBe(detailRow1.id);
    expect(detailRow3.questionKey).toBe(detailRow1.questionKey);
    // baseline 预算不被借：仍停在 attempt 1，连 claim 打点时刻都没被 run3 移动。
    const baselineRow3 = uniqueLedgerRow(run3.ledgerAfter, "baseline");
    expect(baselineRow3).toMatchObject({ attempts: 1, status: "failed", note: null });
    expect(baselineRow3.id).toBe(baselineRow1.id);
    expect(baselineRow3.lastAttemptAt).toBe(baselineStampRun1);
    expect(h.visionCalls).toHaveLength(3);
    writeS41Trace({
      case: "S41",
      run: "case-final",
      phase: "case-final",
      ledger: purposeLedger(h),
      ...(traces.length === 0 ? {} : { run3: traces[traces.length - 1] }),
    });
  });

  it("[S41-neg][整链] detail 第二次真失败：failed/attempt 2/不再等补充；第三次耗尽零视觉不重开", async () => {
    const h = createOneBotHarness({
      accountId: ACCOUNT,
      mediaEnabled: true,
      // 三条视觉 outcome 全是真失败；游标用完重复最后一项，所以即便闸再打开也没有成功。
      vision: ["fail", "fail", "fail"],
      imageBytes: { n1: bytes() },
      model: [],
    });
    const issued: IssuedDescribe[] = [];
    const traces: RunTrace[] = [];
    const capture: DetailCapture = { detailValues: [] };
    let queue: string[] = [];
    let runMediaId = "";
    const ask = (next: string): ModelStep[] => {
      const detail = next === "detail";
      issued.push({
        purpose: detail ? "detail" : "baseline",
        questionMessageId: detail ? "-431" : null,
      });
      return [
        decideInvoke(
          "media.describe",
          detail ? { id: runMediaId, questionMessageId: "-431" } : { id: runMediaId },
        ),
      ];
    };
    driveToolFirst(h, (observation) => {
      if (observation?.name === "media.describe") {
        capture.detailValues.push(observation.value as DescribeValue);
      }
      if (observation?.name === "media.list") {
        const items = (observation.value as { items: { id: string }[] }).items;
        if (items.length === 0) return [decideInline("20002", "没有图", [])];
        runMediaId = nonNull(items[0], "items[0]").id;
        if (queue.length === 0) return [decideInline("20002", "没有要做的读取", [])];
        return ask(nonNull(queue.shift(), "queue.shift()"));
      }
      if (observation?.name === "media.describe") {
        if (queue.length > 0) return ask(nonNull(queue.shift(), "queue.shift()"));
        return [decideInline("20002", "已处理", [])];
      }
      return null;
    });
    h.model?.push([decideInvoke("media.list", {})]);
    queue = ["baseline", "detail"];
    h.receive({ id: "-431", speaker: "20002", addressed: true, image: "n1", text: "看图" });
    const mediaId = imageNote(h, "-431");
    seedAsset(h, mediaId, bytes());
    const neg1 = await runTrace(
      h,
      "neg-run1-attempt1-fails",
      issued,
      capture,
      "S41-neg",
      async () => {
        await h.activate("direct_reply");
      },
    );
    traces.push(neg1);
    // 同 run 两次 describe（baseline + detail），所以两条观察都按真实契约逐项断。
    expect(neg1.visionDelta).toHaveLength(2);
    expect(neg1.detailValues).toHaveLength(2);
    for (const value of neg1.detailValues) {
      expect(value).toEqual({
        status: "failed",
        described: false,
        attempt: 1,
        awaitSupplement: true,
      });
    }
    expect(neg1.ledgerAfter.map((row) => row.purpose)).toEqual(["baseline", "detail"]);
    expect(neg1.ledgerAfter.every((row) => row.attempts === 1)).toBe(true);
    expect(neg1.ledgerAfter.every((row) => row.status === "failed")).toBe(true);
    // 两次真实尝试各让一条 purpose 行 +1：baseline 与 detail 配对齐全。
    expect(pairingOf(neg1)).toEqual(["baseline", "detail"]);
    const negDetailRow1 = uniqueLedgerRow(neg1.ledgerAfter, "detail");
    const negBaselineRow1 = uniqueLedgerRow(neg1.ledgerAfter, "baseline");
    expect(negDetailRow1.id).not.toBe(negBaselineRow1.id);
    // 第二次：真实更晚的 addressed 补充解锁 attempt 2，但视觉本身再失败一次。
    h.advance(1);
    h.model?.push([decideInvoke("media.list", {})]);
    queue = ["detail"];
    h.receive({
      id: "-432",
      speaker: "20002",
      addressed: true,
      replyTo: "-431",
      text: "再问一下",
    });
    const neg2 = await runTrace(
      h,
      "neg-run2-attempt2-fails",
      issued,
      capture,
      "S41-neg",
      async () => {
        await h.activate("direct_reply");
      },
    );
    traces.push(neg2);
    expect(neg2.detailValues).toEqual([
      { status: "failed", described: false, attempt: 2, awaitSupplement: false },
    ]);
    expect(neg2.visionDelta).toHaveLength(1);
    // 第二次尝试仍落在 run1 的**同一条 detail 行**：attempts 由 1 变 2（真实 +1），
    // 所以本轮配对恰为一条 detail；questionKey 与 task id 不变，不是新预算。
    expect(pairingOf(neg2)).toEqual(["detail"]);
    const negDetailRow2 = uniqueLedgerRow(neg2.ledgerAfter, "detail");
    expect(negDetailRow2).toMatchObject({
      attempts: 2,
      status: "failed",
      note: null,
    });
    expect(negDetailRow2.id).toBe(negDetailRow1.id);
    expect(negDetailRow2.questionKey).toBe(negDetailRow1.questionKey);
    // baseline 在本轮完全没被碰。
    expect(uniqueLedgerRow(neg2.ledgerAfter, "baseline")).toMatchObject({ attempts: 1 });
    expect(neg2.ledgerAfter.map((row) => row.purpose)).toEqual(["baseline", "detail"]);
    // 第三次：又一条真实更晚补充到了，但预算已耗尽——不再发视觉、不重开、不借 baseline。
    h.advance(1);
    h.model?.push([decideInvoke("media.list", {})]);
    queue = ["detail"];
    h.receive({
      id: "-433",
      speaker: "20002",
      addressed: true,
      replyTo: "-431",
      text: "再问最后一次",
    });
    const neg3 = await runTrace(
      h,
      "neg-run3-attempts-exhausted",
      issued,
      capture,
      "S41-neg",
      async () => {
        await h.activate("direct_reply");
      },
    );
    traces.push(neg3);
    expect(neg3.detailValues).toEqual([{ status: "unavailable", code: "attempts_exhausted" }]);
    expect(neg3.visionDelta).toHaveLength(0);
    // 预算已耗尽：本轮没有任何 attempts 增量，所以**配对为空**——不为「跑过 describe」
    // 编一条配对出来。整份账本与 neg2 之后逐字相同：不重开、不新增行、不动 baseline。
    expect(pairingOf(neg3)).toEqual([]);
    expect(neg3.ledgerAfter).toEqual(neg2.ledgerAfter);
    const negDetailRow3 = uniqueLedgerRow(neg3.ledgerAfter, "detail");
    expect(negDetailRow3).toMatchObject({
      attempts: 2,
      status: "failed",
      note: null,
    });
    expect(negDetailRow3.id).toBe(negDetailRow1.id);
    expect(uniqueLedgerRow(neg3.ledgerAfter, "baseline")).toMatchObject({ attempts: 1 });
    expect(neg3.ledgerAfter.map((row) => row.purpose)).toEqual(["baseline", "detail"]);
    expect(h.visionCalls).toHaveLength(3);
    writeS41Trace({
      case: "S41-neg",
      run: "case-final",
      phase: "case-final",
      ledger: purposeLedger(h),
      ...(traces.length === 0 ? {} : { run3: traces[traces.length - 1] }),
    });
  });

  it("[S42][整链] 缓存命中不花尝试：第二次视觉调用计数为 0", async () => {
    const h = createOneBotHarness({
      accountId: ACCOUNT,
      mediaEnabled: true,
      vision: ["首次描述"],
      imageBytes: { c1: bytes() },
      model: [],
    });
    driveToolFirst(h, (observation) => {
      if (observation?.name === "media.list") {
        const items = (observation.value as { items: { id: string }[] }).items;
        if (items.length === 0) return [decideInline("20002", "没有图", [])];
        return [decideInvoke("media.describe", { id: nonNull(items[0], "items[0]").id })];
      }
      if (observation?.name === "media.describe") return [decideInline("20002", "好的", [])];
      return null;
    });
    h.model?.push([decideInvoke("media.list", {})]);
    h.receive({ id: "-421", speaker: "20002", addressed: true, image: "c1", text: "看图" });
    const mediaId = imageNote(h, "-421");
    seedAsset(h, mediaId, bytes());
    await h.activate("direct_reply");
    expect(h.visionCalls).toHaveLength(1);
    h.advance(1);
    h.model?.push([decideInvoke("media.list", {})]);
    h.receive({ id: "-422", speaker: "20002", addressed: true, text: "再描述一下" });
    await h.activate("direct_reply");
    expect(h.visionCalls).toHaveLength(1);
    expect(
      h.db
        .query("SELECT attempts,status,note FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(mediaId),
    ).toMatchObject({ attempts: 1, status: "succeeded", note: "首次描述" });
  });

  it("[S45][生产组件集成] 同 sha 不同 URL 复用 identity 预算；来源死亡撤结果不撤预算", async () => {
    const h = createOneBotHarness({ accountId: ACCOUNT, model: [] });
    const shared = bytes();
    const segA = seedMediaEvent(h, { eventKey: "-451", sourceRef: "ref-A" });
    const segB = seedMediaEvent(h, { eventKey: "-452", sourceRef: "ref-B" });
    // A 不预挂资产：第一次读取走 fetchBytes 真实受控字节，reader 在宿主守卫事务里
    // 持久化 A 自己的 asset+link（consumed 授权有真链）；B 预挂同 bytes 真资产。
    seedAsset(h, segB.id, shared);
    const mount = mountTools(h, {
      adapter: {
        capabilities: ["image"] as const,
        fetchBytes: async () => ({ bytes: shared }),
        read: async () => {
          mount.stats.calls += 1;
          return "首次描述";
        },
      },
    });
    const ctxA = mount.context("run-45a").ctx;
    await mount.execute("media.list", {}, ctxA);
    expect(
      (await mount.execute("media.describe", { id: segA.id }, ctxA)).value as DescribeValue,
    ).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: segA.id,
      model: "vision-stub",
      text: "首次描述",
      offset: 0,
      nextOffset: null,
    });
    expect(mount.stats.calls).toBe(1);
    const ctxB = mount.context("run-45b").ctx;
    await mount.execute("media.list", {}, ctxB);
    expect(
      (await mount.execute("media.describe", { id: segB.id }, ctxB)).value as DescribeValue,
    ).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: segB.id,
      model: "vision-stub",
      text: "首次描述",
      offset: 0,
      nextOffset: null,
    });
    expect(mount.stats.calls).toBe(1);
    let rows = taskRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, status: "succeeded" });
    expect(rows[0]?.note).toBe("首次描述");
    const scope = {
      conversationId: h.conversationId,
      accountId: ACCOUNT,
      conversationKind: "group" as const,
      peerId: PEER,
      agentId: AGENT,
      bindingId: h.bindingId,
      bindingEpoch: 1,
      authorityRevision: 1,
    };
    const owner = {
      kind: "conversation" as const,
      id: h.conversationId,
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
    };
    const principal = { userId: DEFAULT_USER_ID };
    const refA = createQqMediaSourceRef({ db: h.db, orm: h.orm }, scope, segA.id, h.now());
    const refB = createQqMediaSourceRef({ db: h.db, orm: h.orm }, scope, segB.id, h.now());
    expect(refA).not.toBeNull();
    expect(refB).not.toBeNull();
    expect(sourceAccess(h.db, nonNull(refA, "refA"), owner, principal, h.now())).toBe("available");
    expect(sourceAccess(h.db, nonNull(refB, "refB"), owner, principal, h.now())).toBe("available");
    const revisionBeforePurge = nonNull(taskRows(h)[0], "taskRows[0]").revision;
    h.db
      .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), segA.id);
    expect(purgeExpiredMediaNotes(h.orm)).toBe(1);
    expect(sourceAccess(h.db, nonNull(refA, "refA"), owner, principal, h.now())).toBe("revoked");
    rows = taskRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attempts: 1,
      status: "failed",
      note: null,
      mediaNoteId: null,
    });
    expect(nonNull(rows[0], "rows[0]").revision).toBeGreaterThan(revisionBeforePurge);
    // 撤销后的剩余尝试按 revoke 设计走 expired-row reclaim（不需要补充证据闸）：
    // fresh carrier B 合法再读花掉 attempt 2，产出新结果（不是借旧正文）。
    const ctxC = mount.context("run-45c").ctx;
    await mount.execute("media.list", {}, ctxC);
    expect(
      (await mount.execute("media.describe", { id: segB.id }, ctxC)).value as DescribeValue,
    ).toEqual({
      status: "described",
      described: true,
      attempt: 2,
      id: segB.id,
      model: "vision-stub",
      text: "首次描述",
      offset: 0,
      nextOffset: null,
    });
    expect(mount.stats.calls).toBe(2);
    expect(taskRows(h)).toHaveLength(1);
    expect(taskRows(h)[0]).toMatchObject({ attempts: 2, status: "succeeded" });
  });

  it("[S43][生产组件集成] 补充时间语义：equal/earlier 拒，严格更晚解锁精确 attempt 2", async () => {
    const h = createOneBotHarness({ accountId: ACCOUNT, model: [] });
    const seg = seedMediaEvent(h, { eventKey: "-431", at: Math.floor(Date.now() / 1000) - 60 });
    seedAsset(h, seg.id, bytes());
    const mount = mountTools(h, {
      adapter: {
        capabilities: ["image"] as const,
        fetchBytes: async () => ({ bytes: bytes() }),
        read: async () => {
          mount.stats.calls += 1;
          throw new Error("synthetic vision failure");
        },
      },
    });
    const ctx1 = mount.context("run-43a").ctx;
    await mount.execute("media.list", {}, ctx1);
    expect(
      (await mount.execute("media.describe", { id: seg.id }, ctx1)).value as DescribeValue,
    ).toEqual({ status: "failed", described: false, attempt: 1, awaitSupplement: true });
    const claimedAt = (
      h.db
        .query("SELECT last_attempt_at FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(seg.id) as {
        last_attempt_at: string;
      }
    ).last_attempt_at;
    const benchmarkSeconds = Math.floor(Date.parse(claimedAt) / 1000);
    const supplement = (eventKey: string, at: number) => {
      seedMediaEvent(h, { eventKey, at, sourceRef: `ref-${eventKey}` });
    };
    supplement("supp-earlier", benchmarkSeconds - 5);
    const ctx2 = mount.context("run-43b").ctx;
    await mount.execute("media.list", {}, ctx2);
    expect(
      (await mount.execute("media.describe", { id: seg.id }, ctx2)).value as DescribeValue,
    ).toEqual({ status: "unavailable", code: "awaiting_supplement" });
    expect(mount.stats.calls).toBe(1);
    supplement("supp-equal", benchmarkSeconds);
    const ctx3 = mount.context("run-43c").ctx;
    await mount.execute("media.list", {}, ctx3);
    expect(
      (await mount.execute("media.describe", { id: seg.id }, ctx3)).value as DescribeValue,
    ).toEqual({ status: "unavailable", code: "awaiting_supplement" });
    expect(mount.stats.calls).toBe(1);
    expect(
      (
        h.db
          .query("SELECT attempts FROM qq_media_read_tasks WHERE media_note_id=?")
          .get(seg.id) as { attempts: number }
      ).attempts,
    ).toBe(1);
    supplement("supp-fresh", benchmarkSeconds + 5);
    const ctx4 = mount.context("run-43d").ctx;
    await mount.execute("media.list", {}, ctx4);
    expect(
      (await mount.execute("media.describe", { id: seg.id }, ctx4)).value as DescribeValue,
    ).toEqual({ status: "failed", described: false, attempt: 2, awaitSupplement: false });
    expect(mount.stats.calls).toBe(2);
    const task = h.db
      .query(
        "SELECT attempts,status,last_attempt_at FROM qq_media_read_tasks WHERE media_note_id=?",
      )
      .get(seg.id) as { attempts: number; status: string; last_attempt_at: string };
    expect(task).toMatchObject({ attempts: 2, status: "failed" });
    expect(Date.parse(task.last_attempt_at)).toBeGreaterThan(Date.parse(claimedAt));
  });

  it("[S44][生产组件集成] tool 级真取消与过期 claim token CAS 拒", async () => {
    const h = createOneBotHarness({ accountId: ACCOUNT, model: [] });
    const seg = seedMediaEvent(h, { eventKey: "-441" });
    seedAsset(h, seg.id, bytes());
    let release: ((error: Error) => void) | null = null;
    const blocked = new Promise<never>((_, reject) => {
      release = (error) => reject(error);
    });
    const calls = { n: 0 };
    const controller = new AbortController();
    const mount = mountTools(h, {
      adapter: {
        capabilities: ["image"] as const,
        fetchBytes: async () => ({ bytes: bytes() }),
        read: async () => {
          calls.n += 1;
          // claim 已成立、读取在飞时真取消（生产 reader cleanup 路径）。
          controller.abort();
          await blocked;
          return "不该到达";
        },
      },
    });
    const ctx: ActionContext = {
      owner: {
        kind: "conversation",
        id: h.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      },
      runId: "run-44",
      signal: controller.signal,
    };
    await mount.execute("media.list", {}, ctx);
    const pending = mount.execute("media.describe", { id: seg.id }, ctx);
    // 显式类型实参：`new Promise` 的 executor 同步执行，`release` 在上一行构造时就已赋值；
    // 但 TS 的控制流分析看不穿构造器，所以在此处把 T 钉成可调用签名，保留 nonNull 的
    // 「null 即显式失败」运行时闸——不 cast、不改共享 helper、不用 ! 断言。
    nonNull<(error: Error) => void>(release, "release")(new Error("aborted release"));
    await expect(pending).rejects.toThrow();
    expect(
      h.db
        .query("SELECT attempts,status,note FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(seg.id),
    ).toMatchObject({ attempts: 1, status: "failed", note: null });
    const claim = await attemptMediaReadTask(h.orm, {
      mediaNoteId: seg.id,
      purpose: "baseline",
      modelName: "vision-stub",
      policy: POLICY,
      contentSha256: (
        h.db.query("SELECT content_sha256 AS sha FROM qq_media_assets LIMIT 1").get() as {
          sha: string;
        }
      ).sha,
      proveSupplementLaterThan: () => true,
      assertCurrent: () => {},
    });
    expect(claim.attempt).toBe(2);
    expect(calls.n).toBe(1);
    let refused = false;
    let code = "";
    try {
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId: seg.id,
        purpose: "baseline",
        note: "迟到的描述",
        modelName: "vision-stub",
        expectedAttempts: 1,
        claimToken: "superseded-token",
        assertCurrent: () => {},
      });
    } catch (error) {
      refused = true;
      code = (error as { code?: string }).code ?? "NO_CODE";
    }
    expect(refused).toBe(true);
    expect(code).toBe("MEMORY_SOURCE_INVALID");
    expect(
      h.db
        .query("SELECT attempts,status FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(seg.id),
    ).toMatchObject({ attempts: 2, status: "running" });
    recordMediaReadTaskResult(h.orm, {
      mediaNoteId: seg.id,
      purpose: "baseline",
      note: "当前 token 的描述",
      modelName: "vision-stub",
      expectedAttempts: claim.attempt,
      claimToken: claim.claimToken,
      assertCurrent: () => {},
    });
    expect(
      h.db.query("SELECT status,note FROM qq_media_read_tasks WHERE media_note_id=?").get(seg.id),
    ).toMatchObject({ status: "succeeded", note: "当前 token 的描述" });
  });

  it("[S44b][整链] 真 run 级取消：activate({signal}) 在飞 abort，工具边界拒绝不烧尝试", async () => {
    const h = createOneBotHarness({
      accountId: ACCOUNT,
      mediaEnabled: true,
      vision: ["fail", "fail"],
      imageBytes: { d1: png8(32) },
      model: [],
    });
    let runCalls = 0;
    let mediaId2 = "";
    let runCancel: AbortController | null = null;
    driveToolFirst(h, (observation) => {
      if (observation?.name === "media.list") {
        const items = (observation.value as { items: { id: string }[] }).items;
        if (items.length === 0) return [decideInline("20002", "没有图", [])];
        mediaId2 = nonNull(items[0], "items[0]").id;
        runCalls += 1;
        if (runCalls === 2 && runCancel !== null) {
          runCancel.abort();
        }
        return [decideInvoke("media.describe", { id: mediaId2 })];
      }
      if (observation?.name === "media.describe") return [decideInline("20002", "好", [])];
      return null;
    });
    h.model?.push([decideInvoke("media.list", {})]);
    h.receive({ id: "-442", speaker: "20002", addressed: true, image: "d1", text: "看这张" });
    await h.activate("direct_reply");
    expect(h.visionCalls).toHaveLength(1);
    const row442 = h.orm
      .select()
      .from(schema.qqEvents)
      .all()
      .find((r) => r.messageId === "-442");
    const seg2 = nonNull(mediaNoteRow(h.orm, nonNull(row442, "row442").eventKey, 1), "seg2");
    expect(
      h.db
        .query("SELECT attempts,status FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(seg2.id),
    ).toMatchObject({ attempts: 1, status: "failed" });
    h.advance(1);
    h.model?.push([decideInvoke("media.list", {})]);
    runCancel = new AbortController();
    h.receive({ id: "-443", speaker: "20002", addressed: true, text: "还在吗" });
    // run 级取消把 abort 传回 activate 调用方（真实 cancel 语义）。
    await expect(h.activate("direct_reply", { signal: runCancel.signal })).rejects.toThrow();
    expect(
      h.db
        .query("SELECT attempts,status FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(seg2.id),
    ).toMatchObject({ attempts: 1, status: "failed" });
  });

  it("[S46][生产组件集成] 同业务库跨群/跨 Agent 不共 identity 缓存与预算；跨 scope ref fail closed", async () => {
    const h = createOneBotHarness({ accountId: ACCOUNT, model: [] });
    const segA = seedMediaEvent(h, { eventKey: "-461" });
    seedAsset(h, segA.id, bytes());
    const mountA = mountTools(h);
    const ctxA = mountA.context("run-46a").ctx;
    await mountA.execute("media.list", {}, ctxA);
    expect(
      (await mountA.execute("media.describe", { id: segA.id }, ctxA)).value as DescribeValue,
    ).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: segA.id,
      model: "vision-stub",
      text: "mount 描述",
      offset: 0,
      nextOffset: null,
    });
    expect(mountA.stats.calls).toBe(1);
    const schemeB = createQqScheme(h.orm, { name: "p5-group-b" });
    const bindingBId = "22222222-2222-4222-8222-222222222222";
    h.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingBId,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: "30777",
        agentId: AGENT,
        schemeId: schemeB.id,
        createdAt: h.now(),
        updatedAt: h.now(),
      })
      .run();
    const conversationB = nonNull(h.journal.ensureOneBot(bindingBId), "conversationB");
    const segB = seedMediaEvent(h, { eventKey: "-462", peerId: "30777", bindingId: bindingBId });
    seedAsset(h, segB.id, bytes(), {
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId: "30777",
      agentId: AGENT,
    });
    const mountB = mountTools(h, {
      conversationId: conversationB.id,
      peerId: "30777",
      bindingId: bindingBId,
    });
    const ctxB = mountB.context("run-46b").ctx;
    await mountB.execute("media.list", {}, ctxB);
    expect(
      (await mountB.execute("media.describe", { id: segB.id }, ctxB)).value as DescribeValue,
    ).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: segB.id,
      model: "vision-stub",
      text: "mount 描述",
      offset: 0,
      nextOffset: null,
    });
    expect(mountB.stats.calls).toBe(1);
    expect(mountA.stats.calls).toBe(1);
    let rows = taskRows(h);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.identityKey)).size).toBe(2);
    expect(rows.map((row) => row.attempts).sort()).toEqual([1, 1]);
    const agentBId = "00000000-0000-0000-0000-000000000002";
    const now = h.now();
    h.orm
      .insert(schema.agents)
      .values({
        id: agentBId,
        name: "助手B",
        systemPrompt: "",
        description: "",
        additionalInstructions: "",
        p5Config: "{}",
        modelName: "synthetic-model",
        temperature: 0.7,
        memoryConsolidationModelName: null,
        memoryConsolidationPrompt: "整理",
        memoryConsolidationAdditionalInstructions: "",
        memoryRetrievalModelName: null,
        memoryRetrievalPrompt: "检索",
        contextCompressionModelName: null,
        personaIntensity: 60,
        isActive: 1,
        configVersion: 1,
        updatedAt: now,
        createdAt: now,
      })
      .run();
    const schemeC = createQqScheme(h.orm, { name: "p5-agent-b" });
    const bindingCId = "33333333-3333-4333-8333-333333333333";
    h.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingCId,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: "30888",
        agentId: agentBId,
        schemeId: schemeC.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const conversationC = nonNull(h.journal.ensureOneBot(bindingCId), "conversationC");
    const segC = seedMediaEvent(h, {
      eventKey: "-463",
      peerId: "30888",
      agentId: agentBId,
      bindingId: bindingCId,
    });
    seedAsset(h, segC.id, bytes(), {
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId: "30888",
      agentId: agentBId,
    });
    const mountC = mountTools(h, {
      conversationId: conversationC.id,
      peerId: "30888",
      agentId: agentBId,
      bindingId: bindingCId,
    });
    const ctxC = mountC.context("run-46c").ctx;
    await mountC.execute("media.list", {}, ctxC);
    expect(
      (await mountC.execute("media.describe", { id: segC.id }, ctxC)).value as DescribeValue,
    ).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: segC.id,
      model: "vision-stub",
      text: "mount 描述",
      offset: 0,
      nextOffset: null,
    });
    expect(mountC.stats.calls).toBe(1);
    rows = taskRows(h);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.identityKey)).size).toBe(3);
    const scopeA = {
      conversationId: h.conversationId,
      accountId: ACCOUNT,
      conversationKind: "group" as const,
      peerId: PEER,
      agentId: AGENT,
      bindingId: h.bindingId,
      bindingEpoch: 1,
      authorityRevision: 1,
    };
    const refA = createQqMediaSourceRef({ db: h.db, orm: h.orm }, scopeA, segA.id, h.now());
    expect(refA).not.toBeNull();
    expect(
      sourceAccess(
        h.db,
        nonNull(refA, "refA"),
        { kind: "conversation", id: conversationB.id, userId: DEFAULT_USER_ID, agentId: AGENT },
        { userId: DEFAULT_USER_ID },
        h.now(),
      ),
    ).toBe("revoked");
  });

  it("[S47][生产组件集成] 过期拒读拒 mint；真实 purge 撤结果不撤预算；fresh carrier 合法再读花剩余尝试产出新 ref；2 耗尽不重获", async () => {
    const h = createOneBotHarness({ accountId: ACCOUNT, model: [] });
    const shared = bytes();
    const segA = seedMediaEvent(h, { eventKey: "-471", sourceRef: "x1" });
    // A 不预挂资产：首次读取走 fetchBytes 真实受控字节并持久化 A 自己的 asset+link。
    let fakeNow = h.now();
    const mount = mountTools(h, {
      now: () => fakeNow,
      adapter: {
        capabilities: ["image"] as const,
        fetchBytes: async () => ({ bytes: shared }),
        read: async () => {
          mount.stats.calls += 1;
          // 第二次读取失败：identity 账本 attempts 烧满 2 且不产生新可服务正文。
          if (mount.stats.calls >= 2) throw new Error("synthetic vision failure 2");
          return "首次描述";
        },
      },
    });
    const ctx1 = mount.context("run-47a").ctx;
    await mount.execute("media.list", {}, ctx1);
    expect(
      (await mount.execute("media.describe", { id: segA.id }, ctx1)).value as DescribeValue,
    ).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: segA.id,
      model: "vision-stub",
      text: "首次描述",
      offset: 0,
      nextOffset: null,
    });
    expect(mount.stats.calls).toBe(1);
    const scope = {
      conversationId: h.conversationId,
      accountId: ACCOUNT,
      conversationKind: "group" as const,
      peerId: PEER,
      agentId: AGENT,
      bindingId: h.bindingId,
      bindingEpoch: 1,
      authorityRevision: 1,
    };
    const owner = {
      kind: "conversation" as const,
      id: h.conversationId,
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
    };
    const principal = { userId: DEFAULT_USER_ID };
    const refA = createQqMediaSourceRef({ db: h.db, orm: h.orm }, scope, segA.id, h.now());
    expect(refA).not.toBeNull();
    expect(sourceAccess(h.db, nonNull(refA, "refA"), owner, principal, h.now())).toBe("available");
    // 过期：行存活时钟下 list（仍在披露清单），宿主时钟推过到期 → 读被拒
    // （segment_expired 明确拒绝码）、零尝试零视觉；mint=null；旧 ref=expired。
    h.db
      .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
      .run(new Date(Date.parse(h.now()) + 7 * 24 * 60 * 60 * 1000).toISOString(), segA.id);
    const ctx2 = mount.context("run-47b").ctx;
    await mount.execute("media.list", {}, ctx2);
    fakeNow = new Date(Date.parse(h.now()) + 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      (await mount.execute("media.describe", { id: segA.id }, ctx2)).value as DescribeValue,
    ).toEqual({ status: "unavailable", code: "segment_expired" });
    expect(mount.stats.calls).toBe(1);
    expect(
      (
        h.db
          .query("SELECT attempts FROM qq_media_read_tasks WHERE media_note_id=?")
          .get(segA.id) as { attempts: number }
      ).attempts,
    ).toBe(1);
    expect(createQqMediaSourceRef({ db: h.db, orm: h.orm }, scope, segA.id, fakeNow)).toBeNull();
    expect(sourceAccess(h.db, nonNull(refA, "refA"), owner, principal, fakeNow)).toBe("expired");
    // 真实清理入口 purge：撤结果（note 清空、revision 推进、载体行删除），预算保留。
    h.db
      .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), segA.id);
    expect(purgeExpiredMediaNotes(h.orm)).toBe(1);
    const afterPurge = taskRows(h);
    expect(afterPurge).toHaveLength(1);
    expect(afterPurge[0]).toMatchObject({
      attempts: 1,
      status: "failed",
      note: null,
      mediaNoteId: null,
    });
    expect(nonNull(afterPurge[0], "afterPurge[0]").revision).toBeGreaterThanOrEqual(2);
    // 撤销后的剩余尝试按 revoke 设计走 expired-row reclaim：fresh carrier B 合法再读
    // 直接花 attempt 2（失败）——attempts 烧满且不产生新可服务正文。
    const segB = seedMediaEvent(h, { eventKey: "-472", sourceRef: "x2" });
    seedAsset(h, segB.id, shared);
    const refB1 = createQqMediaSourceRef({ db: h.db, orm: h.orm }, scope, segB.id, h.now());
    expect(refB1).not.toBeNull();
    const ctx3 = mount.context("run-47c").ctx;
    await mount.execute("media.list", {}, ctx3);
    expect(
      (await mount.execute("media.describe", { id: segB.id }, ctx3)).value as DescribeValue,
    ).toEqual({ status: "failed", described: false, attempt: 2, awaitSupplement: false });
    expect(mount.stats.calls).toBe(2);
    const rows = taskRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 2, status: "failed", mediaNoteId: segB.id });
    const refB2 = createQqMediaSourceRef({ db: h.db, orm: h.orm }, scope, segB.id, h.now());
    expect(refB2).not.toBeNull();
    expect(nonNull(refB2, "refB2").revision).not.toBe(nonNull(refA, "refA").revision);
    expect(sourceAccess(h.db, nonNull(refB2, "refB2"), owner, principal, h.now())).toBe(
      "available",
    );
    // 尝试耗尽后：fresh carrier C 也不能重获预算。
    const segC = seedMediaEvent(h, { eventKey: "-473", sourceRef: "x3" });
    seedAsset(h, segC.id, shared);
    const ctx5 = mount.context("run-47e").ctx;
    await mount.execute("media.list", {}, ctx5);
    expect(
      (await mount.execute("media.describe", { id: segC.id }, ctx5)).value as DescribeValue,
    ).toEqual({ status: "unavailable", code: "attempts_exhausted" });
    expect(mount.stats.calls).toBe(2);
  });
});
