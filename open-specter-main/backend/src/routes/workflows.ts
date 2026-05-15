import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import {
  workflows,
  workflowShares,
  hiddenWorkflows,
  userProfiles,
} from "../schema";
import { eq, and, inArray, asc, desc, sql } from "drizzle-orm";

export const workflowsRouter = Router();

type WorkflowRecord = {
  id: string;
  userId: string | null;
  isSystem: boolean;
  [key: string]: unknown;
};

type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      allowEdit: boolean;
      isOwner: boolean;
    }
  | null;

function withWorkflowAccess<T extends Record<string, unknown>>(
  workflow: T,
  access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
  return {
    ...workflow,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<WorkflowAccess> {
  const [workflow] = db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1).all();
  if (!workflow) return null;
  const workflowRecord = workflow as unknown as WorkflowRecord;
  if (workflowRecord.userId === userId) {
    return { workflow: workflowRecord, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const [share] = db.select({ allowEdit: workflowShares.allowEdit }).from(workflowShares).where(and(eq(workflowShares.workflowId, workflowId), eq(workflowShares.sharedWithEmail, normalizedUserEmail))).limit(1).all();
  if (!share) return null;

  return { workflow: workflowRecord, allowEdit: !!share.allowEdit, isOwner: false };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { type } = req.query as { type?: string };

  // Own workflows
  let own = db.select().from(workflows).where(and(eq(workflows.userId, userId), eq(workflows.isSystem, false))).orderBy(desc(workflows.createdAt)).all();
  if (type) own = own.filter((wf) => wf.type === type);

  // Shared workflows (where the current user's email appears in workflow_shares)
  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const shares = db.select({
    workflowId: workflowShares.workflowId,
    sharedByUserId: workflowShares.sharedByUserId,
    allowEdit: workflowShares.allowEdit,
  }).from(workflowShares).where(eq(workflowShares.sharedWithEmail, normalizedUserEmail)).all();

  let sharedWorkflows: Record<string, unknown>[] = [];
  if (shares.length > 0) {
    const sharedIds = shares.map((s) => s.workflowId);
    let wfs = db.select().from(workflows).where(inArray(workflows.id, sharedIds)).all();
    if (type) wfs = wfs.filter((wf) => wf.type === type);

    if (wfs.length > 0) {
      // Fetch sharer profiles (no Supabase Auth lookup — use user_profiles only)
      const sharerIds = [...new Set(shares.map((s) => s.sharedByUserId).filter(Boolean))] as string[];
      const profiles = sharerIds.length > 0
        ? db.select({ userId: userProfiles.userId, displayName: userProfiles.displayName }).from(userProfiles).where(inArray(userProfiles.userId, sharerIds)).all()
        : [];

      sharedWorkflows = wfs.map((wf) => {
        const share = shares.find((s) => s.workflowId === wf.id);
        const sharerId = share?.sharedByUserId;
        const profile = profiles.find((p) => p.userId === sharerId);
        const shared_by_name = profile?.displayName ?? null;
        return withWorkflowAccess(wf as unknown as Record<string, unknown>, {
          allowEdit: !!share?.allowEdit,
          isOwner: false,
          sharedByName: shared_by_name,
        });
      });
    }
  }

  const ownWithFlag = own.map((wf) =>
    withWorkflowAccess(wf as unknown as Record<string, unknown>, { allowEdit: true, isOwner: true }),
  );
  res.json([...ownWithFlag, ...sharedWorkflows]);
});

// POST /workflows
workflowsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { title, type, prompt_md, columns_config, practice } = req.body as {
    title: string;
    type: string;
    prompt_md?: string;
    columns_config?: unknown;
    practice?: string | null;
  };
  if (!title?.trim())
    return void res.status(400).json({ detail: "title is required" });
  if (!["assistant", "tabular"].includes(type))
    return void res
      .status(400)
      .json({ detail: "type must be 'assistant' or 'tabular'" });

  const [data] = db.insert(workflows).values({
    userId,
    title: title.trim(),
    type,
    promptMd: prompt_md ?? null,
    columnsConfig: columns_config ?? null,
    practice: practice ?? null,
    isSystem: false,
  }).returning().all();
  if (!data) return void res.status(500).json({ detail: "Failed to create workflow" });
  res.status(201).json(data);
});

async function handleWorkflowUpdate(req: import("express").Request, res: import("express").Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const drizzleUpdates: Record<string, unknown> = {};
  if (req.body.title != null) drizzleUpdates.title = req.body.title;
  if (req.body.prompt_md != null) drizzleUpdates.promptMd = req.body.prompt_md;
  if (req.body.columns_config != null) drizzleUpdates.columnsConfig = req.body.columns_config;
  if ("practice" in req.body) drizzleUpdates.practice = req.body.practice ?? null;

  const access = await resolveWorkflowAccess(workflowId, userId, userEmail);
  if (!access || access.workflow.isSystem || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const [data] = db.update(workflows).set(drizzleUpdates).where(and(eq(workflows.id, workflowId), eq(workflows.isSystem, false))).returning().all();
  if (!data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(data as unknown as Record<string, unknown>, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, handleWorkflowUpdate);

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, handleWorkflowUpdate);

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  db.delete(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId), eq(workflows.isSystem, false))).run();
  res.status(204).send();
});

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const data = db.select({ workflowId: hiddenWorkflows.workflowId }).from(hiddenWorkflows).where(eq(hiddenWorkflows.userId, userId)).all();
  res.json(data.map((r) => r.workflowId));
});

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflow_id } = req.body as { workflow_id: string };
  if (!workflow_id?.trim())
    return void res.status(400).json({ detail: "workflow_id is required" });
  db.insert(hiddenWorkflows).values({ userId, workflowId: workflow_id }).onConflictDoNothing().run();
  res.status(204).send();
});

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  db.delete(hiddenWorkflows).where(and(eq(hiddenWorkflows.userId, userId), eq(hiddenWorkflows.workflowId, workflowId))).run();
  res.status(204).send();
});

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail);
  if (!access)
    return void res.status(404).json({ detail: "Workflow not found" });
  res.json(
    withWorkflowAccess(access.workflow as unknown as Record<string, unknown>, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
});

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;

  const [wf] = db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId), eq(workflows.isSystem, false))).limit(1).all();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const shares = db.select({
    id: workflowShares.id,
    shared_with_email: workflowShares.sharedWithEmail,
    allow_edit: workflowShares.allowEdit,
    created_at: workflowShares.createdAt,
  }).from(workflowShares).where(eq(workflowShares.workflowId, workflowId)).orderBy(asc(workflowShares.createdAt)).all();

  res.json(shares);
});

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId, shareId } = req.params;

  const [wf] = db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId))).limit(1).all();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

  db.delete(workflowShares).where(and(eq(workflowShares.id, shareId), eq(workflowShares.workflowId, workflowId))).run();
  res.status(204).send();
});

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

  if (!emails?.length) return void res.status(400).json({ detail: "emails is required" });

  // Verify ownership
  const [wf] = db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId), eq(workflows.isSystem, false))).limit(1).all();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const rows = emails.map((email: string) => ({
    workflowId,
    sharedByUserId: userId,
    sharedWithEmail: email.trim().toLowerCase(),
    allowEdit: allow_edit ?? false,
  }));
  // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
  // person updates the existing row instead of stacking duplicates.
  db.insert(workflowShares).values(rows).onConflictDoUpdate({
    target: [workflowShares.workflowId, workflowShares.sharedWithEmail],
    set: { allowEdit: sql`excluded.allow_edit` },
  }).run();

  res.status(204).send();
});
