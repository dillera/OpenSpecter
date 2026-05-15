import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { activityEvents } from "../schema";
import { eq, desc } from "drizzle-orm";

export const activityRouter = Router();

const MAX_LIMIT = 10;

function entityUrl(event: {
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  project_id?: string | null;
}) {
  if (!event.entity_id) return null;
  if (event.entity_type === "chat") {
    return event.project_id
      ? `/projects/${event.project_id}/assistant/chat/${event.entity_id}`
      : `/assistant/chat/${event.entity_id}`;
  }
  if (event.entity_type === "tabular_review") return `/tabular-reviews/${event.entity_id}`;
  if (event.entity_type === "workflow") return `/workflows/${event.entity_id}`;
  return null;
}

activityRouter.get("/recent", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const requested = Number(req.query.limit ?? MAX_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)))
    : MAX_LIMIT;

  const data = db.select({
    id: activityEvents.id,
    event_type: activityEvents.eventType,
    entity_type: activityEvents.entityType,
    entity_id: activityEvents.entityId,
    project_id: activityEvents.projectId,
    title: activityEvents.title,
    metadata: activityEvents.metadata,
    created_at: activityEvents.createdAt,
  }).from(activityEvents).where(eq(activityEvents.userId, userId)).orderBy(desc(activityEvents.createdAt)).limit(limit).all();

  const events = data.map((event) => ({
    ...event,
    entity_url: entityUrl({
      event_type: event.event_type,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      project_id: event.project_id,
    }),
  }));

  res.json(events);
});
