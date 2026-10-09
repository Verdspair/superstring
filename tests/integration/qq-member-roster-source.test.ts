import { describe, expect, it } from "bun:test";
import { inspectContext, sourceAccess } from "../../src/server/agent/context-access";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  createQqMemberRosterSource,
  qqExecutionModuleSourceAccess,
} from "../../src/server/services/qq-member-roster-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const now = "2026-10-09T06:00:00.000Z";
const expiry = "2099-01-01T00:00:00.000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: ReturnType<typeof setup>, id = "binding", peerId = "30003") {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'90001','group',?,?,?, ?,?)",
    )
    .run(id, peerId, DEFAULT_AGENT_ID, "scheme", now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(id);
  if (!conversation) throw new Error("synthetic conversation missing");
  const row = h.db
    .query("SELECT account_id,peer_id,revision,authority_revision FROM qq_bindings WHERE id=?")
    .get(id) as {
    account_id: string;
    peer_id: string;
    revision: number;
    authority_revision: number;
  };
  const epoch = h.db
    .query("SELECT binding_epoch FROM conversations WHERE id=?")
    .get(conversation.id) as { binding_epoch: number };
  const scope = {
    conversationId: conversation.id,
    bindingId: id,
    agentId: DEFAULT_AGENT_ID,
    accountId: row.account_id,
    groupId: row.peer_id,
    bindingRevision: row.revision,
    bindingAuthorityRevision: row.authority_revision,
    bindingEpoch: epoch.binding_epoch,
  };
  const owner: RunOwner = {
    kind: "conversation",
    id: conversation.id,
    userId: DEFAULT_USER_ID,
    agentId: DEFAULT_AGENT_ID,
  };
  return { conversation, scope, owner };
}

function mint(scope: ReturnType<typeof bind>["scope"], expiresAt = expiry): SourceRef {
  return createQqMemberRosterSource(scope, {
    token: "synthetic-roster-token",
    capturedAt: now,
    expiresAt,
  });
}

describe("qq_member_roster source revalidation", () => {
  it("accepts the minted ref only for its current conversation, principal, and binding epoch", () => {
    const h = setup();
    try {
      const { scope, owner } = bind(h);
      const ref = mint(scope);
      expect(ref.kind).toBe("qq_member_roster");
      expect(sourceAccess(h.db, ref, owner, { userId: DEFAULT_USER_ID }, now)).toBe("available");
      expect(
        sourceAccess(
          h.db,
          ref,
          { ...owner, kind: "qq_binding", id: scope.bindingId },
          { userId: DEFAULT_USER_ID },
          now,
        ),
      ).toBe("available");
      expect(
        sourceAccess(
          h.db,
          ref,
          { ...owner, kind: "qq_binding", id: "another-binding" },
          { userId: DEFAULT_USER_ID },
          now,
        ),
      ).toBe("revoked");
      expect(JSON.parse(ref.id)).toEqual([
        scope.conversationId,
        scope.bindingId,
        scope.agentId,
        scope.accountId,
        scope.groupId,
        "synthetic-roster-token",
      ]);
      expect(JSON.parse(ref.revision)).toEqual([
        scope.bindingRevision,
        scope.bindingAuthorityRevision,
        scope.bindingEpoch,
        now,
      ]);
    } finally {
      h.close();
    }
  });

  it("revokes a roster ref for another owner, peer, binding-authority revision, or epoch", () => {
    const h = setup();
    try {
      const first = bind(h);
      const ref = mint(first.scope);
      const principal = { userId: DEFAULT_USER_ID };
      const other = bind(h, "binding-other", "30004");
      expect(sourceAccess(h.db, ref, other.owner, principal, now)).toBe("revoked");

      const wrongPeer = {
        ...ref,
        id: JSON.stringify([
          first.scope.conversationId,
          first.scope.bindingId,
          first.scope.agentId,
          first.scope.accountId,
          "30004",
          "synthetic-roster-token",
        ]),
      };
      expect(sourceAccess(h.db, wrongPeer, first.owner, principal, now)).toBe("revoked");

      h.db
        .query(
          "UPDATE qq_bindings SET revision=revision+1,authority_revision=authority_revision+1 WHERE id=?",
        )
        .run(first.scope.bindingId);
      expect(sourceAccess(h.db, ref, first.owner, principal, now)).toBe("revoked");

      h.db
        .query("UPDATE conversations SET binding_epoch=binding_epoch+1 WHERE id=?")
        .run(first.scope.conversationId);
      expect(sourceAccess(h.db, ref, first.owner, principal, now)).toBe("revoked");
      expect(sourceAccess(h.db, ref, first.owner, { userId: "another-user" }, now)).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("reports expiry only to the matching owner", () => {
    const h = setup();
    try {
      const { scope, owner } = bind(h);
      const expired = mint(scope, "2026-10-09T05:59:00.000Z");
      expect(sourceAccess(h.db, expired, owner, { userId: DEFAULT_USER_ID }, now)).toBe("expired");
      expect(
        sourceAccess(
          h.db,
          expired,
          { ...owner, id: "foreign-conversation" },
          { userId: DEFAULT_USER_ID },
          now,
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("keeps QQ member module snapshots revoked after policy change or disablement", () => {
    const owner: RunOwner = {
      kind: "conversation",
      id: "synthetic-conversation",
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const oldPolicy: SourceRef = {
      kind: "execution_module",
      id: "qqMembers",
      revision: "policy-1",
    };
    expect(qqExecutionModuleSourceAccess(oldPolicy, owner, "policy-2", true)).toBe("revoked");
    expect(qqExecutionModuleSourceAccess(oldPolicy, owner, "policy-1", false)).toBe("revoked");
    expect(
      qqExecutionModuleSourceAccess(
        oldPolicy,
        { ...owner, userId: "another-user" },
        "policy-1",
        true,
      ),
    ).toBe("revoked");
    expect(
      qqExecutionModuleSourceAccess({ ...oldPolicy, id: "not-qqMembers" }, owner, "policy-1", true),
    ).toBe("revoked");
  });

  it("redacts a revoked roster principal through stored protected context; a resolver cannot revive it", () => {
    const h = setup();
    try {
      const { scope, owner } = bind(h);
      const ref = mint(scope);
      const repository = new AgentRunRepository(h.db);
      const handle = { runId: "roster-inspection-run", stepId: "roster-inspection-step" };
      repository.createRun({
        runId: handle.runId,
        specId: "synthetic-roster-test",
        specVersion: "1",
        owner,
        at: now,
      });
      repository.startStep({
        ...handle,
        stepNo: 1,
        model: "synthetic-model",
        phase: "next",
        at: now,
        messages: [{ role: "user", content: [{ kind: "text", text: "PRIVATE_ROSTER_BODY" }] }],
        sources: [ref],
      });
      expect(repository.getContext(handle)?.messages).not.toBeNull();

      h.db
        .query(
          "UPDATE qq_bindings SET revision=revision+1,authority_revision=authority_revision+1 WHERE id=?",
        )
        .run(scope.bindingId);
      const inspected = inspectContext(
        h.db,
        repository,
        handle,
        { userId: DEFAULT_USER_ID },
        now,
        () => "available",
      );
      expect(inspected).toMatchObject({ status: "revoked" });
      expect(inspected?.exactMessages).toBeUndefined();
      expect(repository.getContext(handle)?.messages).toBeNull();
      expect(
        h.db
          .query("SELECT protected_messages,status FROM context_snapshots WHERE step_id=?")
          .get(handle.stepId),
      ).toEqual({ protected_messages: null, status: "revoked" });
    } finally {
      h.close();
    }
  });
});
