import { db } from "./db";
import { projects } from "../schema";
import { eq, and, ne, sql } from "drizzle-orm";

export type ProjectAccess =
  | {
      ok: true;
      isOwner: boolean;
      project: { id: string; user_id: string; shared_with: string[] | null };
    }
  | { ok: false };

export async function checkProjectAccess(
  projectId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<ProjectAccess> {
  const [project] = db
    .select({
      id: projects.id,
      userId: projects.userId,
      sharedWith: projects.sharedWith,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .all();

  if (!project) return { ok: false };

  if (project.userId === userId) {
    return {
      ok: true,
      isOwner: true,
      project: { id: project.id, user_id: project.userId, shared_with: project.sharedWith ?? [] },
    };
  }

  const sharedWith = Array.isArray(project.sharedWith) ? project.sharedWith : [];
  const email = (userEmail ?? "").toLowerCase();
  if (email && sharedWith.some((e) => (e ?? "").toLowerCase() === email)) {
    return {
      ok: true,
      isOwner: false,
      project: { id: project.id, user_id: project.userId, shared_with: sharedWith },
    };
  }
  return { ok: false };
}

export async function ensureDocAccess(
  doc: { user_id: string; project_id: string | null },
  userId: string,
  userEmail: string | null | undefined,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
  if (doc.user_id === userId) return { ok: true, isOwner: true };
  if (!doc.project_id) return { ok: false };
  const access = await checkProjectAccess(doc.project_id, userId, userEmail);
  if (access.ok) return { ok: true, isOwner: false };
  return { ok: false };
}

export async function ensureReviewAccess(
  review: { user_id: string; project_id: string | null; shared_with?: string[] | null },
  userId: string,
  userEmail: string | null | undefined,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
  if (review.user_id === userId) return { ok: true, isOwner: true };
  const email = (userEmail ?? "").toLowerCase();
  if (email && Array.isArray(review.shared_with)) {
    if (review.shared_with.some((e) => (e ?? "").toLowerCase() === email)) {
      return { ok: true, isOwner: false };
    }
  }
  if (!review.project_id) return { ok: false };
  const access = await checkProjectAccess(review.project_id, userId, userEmail);
  if (access.ok) return { ok: true, isOwner: false };
  return { ok: false };
}

export async function listAccessibleProjectIds(
  userId: string,
  userEmail: string | null | undefined,
): Promise<string[]> {
  const own = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.userId, userId))
    .all();

  const ids = new Set<string>(own.map((p) => p.id));

  if (userEmail) {
    const email = userEmail.toLowerCase();
    const shared = db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          ne(projects.userId, userId),
          sql`EXISTS (SELECT 1 FROM json_each(${projects.sharedWith}) WHERE lower(value) = lower(${email}))`,
        ),
      )
      .all();
    for (const p of shared) ids.add(p.id);
  }

  return [...ids];
}
