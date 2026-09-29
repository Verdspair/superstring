import { Hono } from "hono";
import {
  TaskApprovalSchema,
  TaskBodyPageSchema,
  TaskBodyQuerySchema,
  TaskCallOrdinalSchema,
  TaskDetailSchema,
  TaskFiltersSchema,
  TaskListSchema,
} from "../../shared/contracts/agent-task";
import {
  executionPolicy,
  type PermissionResource,
  PermissionSnapshotSchema,
  PermissionsResponseSchema,
  PermissionUpdateSchema,
} from "../../shared/contracts/permissions";
import type { BuiltInAction } from "../agent/built-in-actions";
import type { AgentTaskService } from "../agent/task-service";
import type { PermissionService } from "../permissions/service";
import { managementErrors, managementGuard } from "./management";
import { parseBody, parseUuidParam, readJsonBody } from "./validation";

const permissionErrors = {
  PERMISSION_POLICY_CONFLICT: [409, "权限配置已变化，请重新读取后保存"],
  PERMISSION_POLICY_INVALID: [503, "权限配置格式无效，请修正配置后重新读取"],
  PERMISSION_POLICY_UNAVAILABLE: [503, "权限配置不可读，请检查文件访问权限"],
  PERMISSION_MANAGEMENT_UNAVAILABLE: [503, "当前实例未提供权限管理"],
  PERMISSION_REVISION_CHANGED: [409, "授权或工具修订已变化，请重新读取后确认"],
  PERMISSION_DENIED: [409, "工具授权已撤销，请重新读取任务"],
  PERMISSION_APPROVAL_REQUIRED: [409, "该调用需要重新批准"],
  PERMISSION_DIRECTORY_DENIED: [409, "工具目录授权已变化，请重新读取后确认"],
  PERMISSION_MODE_DENIED: [409, "当前执行模式不允许该操作"],
  TASK_AUTHORITY_CHANGED: [409, "任务所属会话已变化，不能继续操作"],
  TASK_EXPIRED: [409, "任务已过期，不能继续操作"],
  TASK_SOURCE_INVALID: [409, "任务来源已失效，不能继续操作"],
  CONTEXT_SOURCE_INVALID: [409, "任务来源已失效，不能继续操作"],
  TASK_ACTION_UNAVAILABLE: [409, "任务工具不可用，请检查接入状态"],
  TASK_CALL_NOT_FOUND: [404, "任务调用不存在"],
} as const;
const taskNotFound = { error: { code: "TASK_NOT_FOUND", message: "任务不存在或不可访问" } };

export function permissionRoutes(
  service: PermissionService,
  actions: () => readonly BuiltInAction[],
  tasks?: AgentTaskService,
): Hono {
  const router = new Hono();
  router.onError(managementErrors(permissionErrors));
  router.use("*", managementGuard());
  router.get("/", (c) => {
    const snapshot = service.snapshot();
    // 资源投影按 resource 去重：一条授权覆盖一个 resource（web.search / web.fetch 共用 "web"），
    // 同一 resource 只投影一次，授权面板与执行器都按 resource 记账。
    const resources = new Map<string, PermissionResource>();
    for (const action of actions()) {
      const requirement = action.permission;
      if (!requirement || resources.has(requirement.resource)) continue;
      resources.set(requirement.resource, {
        name: action.description.name,
        description: action.description.description,
        effect: action.description.effect ?? "write",
        resource: requirement.resource,
        revision: requirement.revision,
        approvalRequired: requirement.approvalRequired,
        ...(requirement.directories === undefined
          ? {}
          : { directories: [...requirement.directories] }),
      });
    }
    return c.json(
      PermissionsResponseSchema.parse({
        ...snapshot,
        // 有效执行配置：老策略文件里没有该组时也给出缺省值，页面不必自己补。
        policy: { ...snapshot.policy, execution: executionPolicy(snapshot.policy) },
        resources: [...resources.values()],
      }),
    );
  });
  router.put("/", async (c) => {
    const input = parseBody(PermissionUpdateSchema, await readJsonBody(c.req.raw));
    return c.json(
      PermissionSnapshotSchema.parse(service.replace(input.expectedRevision, input.policy)),
    );
  });
  if (tasks) {
    router.get("/tasks", (c) => {
      const query = parseBody(TaskFiltersSchema, c.req.query());
      return c.json(TaskListSchema.parse(tasks.list(query)));
    });
    router.get("/tasks/:id", (c) => {
      const task = tasks.detail(parseUuidParam(c.req.param("id")));
      return task ? c.json(TaskDetailSchema.parse(task)) : c.json(taskNotFound, 404);
    });
    for (const field of ["arguments", "result"] as const) {
      router.get(`/tasks/:id/calls/:ordinal/${field}`, (c) => {
        const result = tasks.readBody(
          parseUuidParam(c.req.param("id")),
          parseBody(TaskCallOrdinalSchema, c.req.param("ordinal")),
          field,
          parseBody(TaskBodyQuerySchema, c.req.query()),
        );
        return result ? c.json(TaskBodyPageSchema.parse(result)) : c.json(taskNotFound, 404);
      });
    }
    router.post("/tasks/:id/approval", async (c) => {
      const id = parseUuidParam(c.req.param("id"));
      const input = parseBody(TaskApprovalSchema, await readJsonBody(c.req.raw));
      const changed = tasks.approve(id, input.ordinal, input.expectedApproval, input.approve);
      return changed
        ? c.json({ ok: true })
        : c.json({ error: { code: "TASK_STATE_CONFLICT", message: "任务状态已变化" } }, 409);
    });
    router.post("/tasks/:id/cancel", (c) =>
      tasks.cancel(parseUuidParam(c.req.param("id")))
        ? c.json({ ok: true })
        : c.json({ error: { code: "TASK_STATE_CONFLICT", message: "任务状态已变化" } }, 409),
    );
  }
  return router;
}
