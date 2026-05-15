import { db } from "./db";
import { activityEvents } from "../schema";
import { eq, and, gt, sql } from "drizzle-orm";

type ActivityEventType =
  | "assistant_chat_created"
  | "tabular_review_created"
  | "workflow_used";

interface ActivityInput {
  userId: string;
  eventType: ActivityEventType;
  title: string;
  entityType?: string | null;
  entityId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}

interface ActivityLookupInput {
  userId: string;
  eventType: ActivityEventType;
  entityType: string;
  entityId: string;
}

export async function activityEventExists({
  userId,
  eventType,
  entityType,
  entityId,
}: ActivityLookupInput) {
  try {
    const rows = db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.userId, userId),
          eq(activityEvents.eventType, eventType),
          eq(activityEvents.entityType, entityType),
          eq(activityEvents.entityId, entityId),
        ),
      )
      .limit(1)
      .all();
    return rows.length > 0;
  } catch (err) {
    console.warn("[activity] failed to check existing event", err);
    return false;
  }
}

export async function updateActivityTitle({
  userId,
  entityType,
  entityId,
  title,
}: {
  userId: string;
  entityType: string;
  entityId: string;
  title: string;
}) {
  try {
    db.update(activityEvents)
      .set({ title })
      .where(
        and(
          eq(activityEvents.userId, userId),
          eq(activityEvents.eventType, "assistant_chat_created"),
          eq(activityEvents.entityType, entityType),
          eq(activityEvents.entityId, entityId),
        ),
      )
      .run();
  } catch (err) {
    console.warn("[activity] failed to update title", err);
  }
}

export async function logActivityEvent({
  userId,
  eventType,
  title,
  entityType = null,
  entityId = null,
  projectId = null,
  metadata = {},
}: ActivityInput) {
  try {
    db.insert(activityEvents)
      .values({
        userId,
        projectId,
        eventType,
        entityType,
        entityId,
        title,
        metadata,
      })
      .run();
  } catch (err) {
    console.warn("[activity] failed to record event", err);
  }
}

export function titleFromPrompt(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 90 ? `${clean.slice(0, 87)}...` : clean;
}

export function scheduleAnonymousUserCleanup(
  deleteUser: (userId: string) => Promise<void>,
) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      const cutoff = new Date(Date.now() - 7 * ONE_DAY_MS).toISOString();
      // Activity events older than 7 days for anonymous users — placeholder.
      // Real anonymous user deletion requires integration with Supabase Auth.
      console.log("[cleanup] anonymous user cleanup skipped (no local auth store)");
    } catch (err) {
      console.warn("[cleanup] anonymous user cleanup failed", err);
    }
  }, ONE_DAY_MS);
}
