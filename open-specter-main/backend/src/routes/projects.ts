import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import {
  projects,
  projectSubfolders,
  documents,
  documentVersions,
  chats,
  tabularReviews,
  userProfiles,
} from "../schema";
import { eq, and, ne, sql, inArray, isNull, asc, desc } from "drizzle-orm";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey } from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";

export const projectsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

// Helper: convert a Drizzle project row (camelCase) to snake_case for API
function projectToApi(p: Record<string, unknown>, userId: string) {
  return {
    id: p.id,
    user_id: p.userId,
    name: p.name,
    cm_number: p.cmNumber ?? null,
    shared_with: p.sharedWith ?? [],
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    is_owner: p.userId === userId,
  };
}

// Helper: convert a Drizzle document row (camelCase) to snake_case for API
function docToApi(d: Record<string, unknown>) {
  return {
    id: d.id,
    project_id: d.projectId ?? null,
    user_id: d.userId,
    filename: d.filename,
    file_type: d.fileType ?? null,
    size_bytes: d.sizeBytes ?? 0,
    page_count: d.pageCount ?? null,
    structure_tree: d.structureTree ?? null,
    status: d.status ?? "pending",
    folder_id: d.folderId ?? null,
    current_version_id: d.currentVersionId ?? null,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

// Helper: convert a Drizzle folder row (camelCase) to snake_case for API
function folderToApi(f: Record<string, unknown>) {
  return {
    id: f.id,
    project_id: f.projectId,
    user_id: f.userId,
    name: f.name,
    parent_folder_id: f.parentFolderId ?? null,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;

  const ownProjects = db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.createdAt))
    .all();

  let sharedProjects: typeof ownProjects = [];
  if (userEmail) {
    const email = userEmail.trim().toLowerCase();
    sharedProjects = db
      .select()
      .from(projects)
      .where(
        and(
          ne(projects.userId, userId),
          sql`EXISTS (SELECT 1 FROM json_each(${projects.sharedWith}) WHERE lower(value) = lower(${email}))`,
        ),
      )
      .orderBy(desc(projects.createdAt))
      .all();
  }

  const allProjects = [...ownProjects, ...sharedProjects].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const result = allProjects.map((p) => {
    const docCount = db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.projectId, p.id))
      .all().length;
    const chatCount = db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.projectId, p.id))
      .all().length;
    const reviewCount = db
      .select({ id: tabularReviews.id })
      .from(tabularReviews)
      .where(eq(tabularReviews.projectId, p.id))
      .all().length;
    return {
      ...projectToApi(p as unknown as Record<string, unknown>, userId),
      document_count: docCount,
      chat_count: chatCount,
      review_count: reviewCount,
    };
  });
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { name, cm_number, shared_with } = req.body as {
    name: string;
    cm_number?: string;
    shared_with?: string[];
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const [data] = db
    .insert(projects)
    .values({
      userId,
      name: name.trim(),
      cmNumber: cm_number ?? null,
      sharedWith: shared_with ?? [],
    })
    .returning()
    .all();
  if (!data) return void res.status(500).json({ detail: "Failed to create project" });
  res.status(201).json({ ...projectToApi(data as unknown as Record<string, unknown>, userId), documents: [] });
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;

  const [project] = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .all();
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.userId === userId ||
    (userEmail &&
      Array.isArray(project.sharedWith) &&
      project.sharedWith.some((e) => (e ?? "").toLowerCase() === userEmail.toLowerCase()));
  if (!canAccess)
    return void res.status(404).json({ detail: "Project not found" });

  const rawDocs = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(asc(documents.createdAt))
    .all();
  const folderData = db
    .select()
    .from(projectSubfolders)
    .where(eq(projectSubfolders.projectId, projectId))
    .orderBy(asc(projectSubfolders.createdAt))
    .all();

  // Convert to snake_case objects with current_version_id for attachActiveVersionPaths
  const docsTyped = rawDocs.map((d) => ({
    ...docToApi(d as unknown as Record<string, unknown>),
  })) as unknown as { id: string; current_version_id?: string | null }[];

  await attachLatestVersionNumbers(docsTyped);
  await attachActiveVersionPaths(docsTyped);

  res.json({
    ...projectToApi(project as unknown as Record<string, unknown>, userId),
    documents: docsTyped,
    folders: folderData.map((f) => folderToApi(f as unknown as Record<string, unknown>)),
  });
});

// GET /projects/:projectId/people
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

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
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.userId === userId;
  const sharedWith = (Array.isArray(project.sharedWith)
    ? (project.sharedWith as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  // Resolve display names from user_profiles only (no Supabase auth lookup)
  // Owner profile
  const ownerProfile = db
    .select({ userId: userProfiles.userId, displayName: userProfiles.displayName })
    .from(userProfiles)
    .where(eq(userProfiles.userId, project.userId))
    .limit(1)
    .all()[0];

  // For members: we only have emails, not user IDs. Look up profiles by userId
  // where the user has registered. We can't look up by email without auth admin access,
  // so return email + display_name as null for members who haven't been resolved.
  // Try to find profiles by matching displayName-less approach: just return emails.
  const owner = {
    user_id: project.userId,
    email: null as string | null, // can't look up email without auth admin
    display_name: ownerProfile?.displayName ?? null,
  };
  const members = sharedWith.map((email) => ({
    email,
    display_name: null as string | null,
  }));

  res.json({ owner, members });
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cmNumber = req.body.cm_number;
  if (Array.isArray(req.body.shared_with)) {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of req.body.shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      cleaned.push(e);
    }
    updates.sharedWith = cleaned;
  }
  updates.updatedAt = new Date().toISOString();

  const [data] = db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .returning()
    .all();
  if (!data)
    return void res.status(404).json({ detail: "Project not found" });

  const rawDocs = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(asc(documents.createdAt))
    .all();
  const folderData = db
    .select()
    .from(projectSubfolders)
    .where(eq(projectSubfolders.projectId, projectId))
    .orderBy(asc(projectSubfolders.createdAt))
    .all();

  const docsTyped = rawDocs.map((d) =>
    docToApi(d as unknown as Record<string, unknown>),
  ) as unknown as { id: string; current_version_id?: string | null }[];
  await attachActiveVersionPaths(docsTyped);

  res.json({
    ...projectToApi(data as unknown as Record<string, unknown>, userId),
    documents: docsTyped,
    folders: folderData.map((f) => folderToApi(f as unknown as Record<string, unknown>)),
  });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  db.delete(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .run();
  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const rawDocs = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(asc(documents.createdAt))
    .all();
  const docsTyped = rawDocs.map((d) =>
    docToApi(d as unknown as Record<string, unknown>),
  ) as unknown as { id: string; current_version_id?: string | null }[];
  await attachActiveVersionPaths(docsTyped);
  res.json(docsTyped);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;

    const access = await checkProjectAccess(projectId, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const [doc] = db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .limit(1)
      .all();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.projectId === projectId) return void res.json(docToApi(doc as unknown as Record<string, unknown>));

    if (doc.projectId === null) {
      // Standalone → assign project_id
      const [updated] = db
        .update(documents)
        .set({ projectId, updatedAt: new Date().toISOString() })
        .where(eq(documents.id, documentId))
        .returning()
        .all();
      if (!updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      return void res.json(docToApi(updated as unknown as Record<string, unknown>));
    } else {
      // Belongs to another project → duplicate record AND copy storage
      const [copy] = db
        .insert(documents)
        .values({
          projectId,
          userId,
          filename: doc.filename,
          fileType: doc.fileType,
          sizeBytes: doc.sizeBytes,
          pageCount: doc.pageCount,
          structureTree: doc.structureTree,
          status: doc.status,
        })
        .returning()
        .all();
      if (!copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      let copyVersionRowId: string | null = null;
      if (doc.currentVersionId) {
        const [srcV] = db
          .select({
            storagePath: documentVersions.storagePath,
            pdfStoragePath: documentVersions.pdfStoragePath,
            versionNumber: documentVersions.versionNumber,
            displayName: documentVersions.displayName,
            source: documentVersions.source,
          })
          .from(documentVersions)
          .where(eq(documentVersions.id, doc.currentVersionId))
          .limit(1)
          .all();
        if (srcV?.storagePath) {
          const srcBytes = await downloadFile(srcV.storagePath);
          if (!srcBytes) {
            return void res
              .status(500)
              .json({ detail: "Failed to read source document bytes" });
          }
          const newKey = storageKey(userId, copy.id, doc.filename);
          const contentType =
            doc.fileType === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          await uploadFile(newKey, srcBytes, contentType);

          let newPdfPath: string | null = null;
          if (srcV.pdfStoragePath) {
            if (srcV.pdfStoragePath === srcV.storagePath) {
              newPdfPath = newKey;
            } else {
              const pdfBytes = await downloadFile(srcV.pdfStoragePath);
              if (pdfBytes) {
                const newPdfKey = convertedPdfKey(userId, copy.id);
                await uploadFile(newPdfKey, pdfBytes, "application/pdf");
                newPdfPath = newPdfKey;
              }
            }
          }

          const [newV] = db
            .insert(documentVersions)
            .values({
              documentId: copy.id,
              storagePath: newKey,
              pdfStoragePath: newPdfPath,
              source: srcV.source ?? "upload",
              versionNumber: srcV.versionNumber ?? 1,
              displayName: srcV.displayName ?? doc.filename,
            })
            .returning()
            .all();
          copyVersionRowId = newV?.id ?? null;
          if (copyVersionRowId) {
            db.update(documents)
              .set({ currentVersionId: copyVersionRowId })
              .where(eq(documents.id, copy.id))
              .run();
          }
        }
      }
      return void res.status(201).json(docToApi(copy as unknown as Record<string, unknown>));
    }
  },
);

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;

    const access = await checkProjectAccess(projectId, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId);
  },
);

// GET /projects/:projectId/chats
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const data = db
    .select()
    .from(chats)
    .where(eq(chats.projectId, projectId))
    .orderBy(desc(chats.createdAt))
    .all();
  res.json(data.map((c) => ({
    id: c.id,
    project_id: c.projectId ?? null,
    user_id: c.userId,
    title: c.title ?? null,
    created_at: c.createdAt,
  })));
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const [parent] = db
      .select({ id: projectSubfolders.id })
      .from(projectSubfolders)
      .where(and(eq(projectSubfolders.id, parent_folder_id), eq(projectSubfolders.projectId, projectId)))
      .limit(1)
      .all();
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const [data] = db
    .insert(projectSubfolders)
    .values({
      projectId,
      userId,
      name: name.trim(),
      parentFolderId: parent_folder_id ?? null,
    })
    .returning()
    .all();
  if (!data) return void res.status(500).json({ detail: "Failed to create folder" });
  res.status(201).json(folderToApi(data as unknown as Record<string, unknown>));
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        const [p] = db
          .select({ parentFolderId: projectSubfolders.parentFolderId })
          .from(projectSubfolders)
          .where(eq(projectSubfolders.id, cur))
          .limit(1)
          .all();
        cur = p?.parentFolderId ?? null;
      }
    }
    updates.parentFolderId = body.parent_folder_id ?? null;
  }

  const [data] = db
    .update(projectSubfolders)
    .set(updates)
    .where(and(eq(projectSubfolders.id, folderId), eq(projectSubfolders.projectId, projectId)))
    .returning()
    .all();
  if (!data) return void res.status(404).json({ detail: "Folder not found" });
  res.json(folderToApi(data as unknown as Record<string, unknown>));
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Move direct documents to root before cascade-deleting subfolders
  db.update(documents)
    .set({ folderId: null })
    .where(eq(documents.folderId, folderId))
    .run();

  db.delete(projectSubfolders)
    .where(and(eq(projectSubfolders.id, folderId), eq(projectSubfolders.projectId, projectId)))
    .run();
  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const [data] = db
    .update(documents)
    .set({ folderId: folder_id ?? null, updatedAt: new Date().toISOString() })
    .where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
    .returning()
    .all();
  if (!data) return void res.status(404).json({ detail: "Document not found" });
  res.json(docToApi(data as unknown as Record<string, unknown>));
});

export async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_TYPES.has(suffix))
    return void res
      .status(400)
      .json({
        detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
      });

  const content = file.buffer;
  const [doc] = db
    .insert(documents)
    .values({
      projectId,
      userId,
      filename,
      fileType: suffix,
      sizeBytes: content.byteLength,
      status: "processing",
    })
    .returning()
    .all();
  if (!doc)
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });

  try {
    const docId = doc.id;
    const key = storageKey(userId, docId, filename);
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const tree = await extractStructureTree(rawBuf, suffix, filename);
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(content);
        const pdfKey = convertedPdfKey(userId, docId);
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[upload] DOCX→PDF conversion failed for ${filename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    const [versionRow] = db
      .insert(documentVersions)
      .values({
        documentId: docId,
        storagePath: key,
        pdfStoragePath,
        source: "upload",
        versionNumber: 1,
        displayName: filename,
      })
      .returning()
      .all();
    if (!versionRow) {
      throw new Error("Failed to record upload version");
    }

    db.update(documents)
      .set({
        currentVersionId: versionRow.id,
        sizeBytes: content.byteLength,
        pageCount,
        structureTree: tree ?? null,
        status: "ready",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(documents.id, docId))
      .run();

    const [updated] = db
      .select()
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1)
      .all();
    const responseDoc = updated
      ? {
          ...docToApi(updated as unknown as Record<string, unknown>),
          storage_path: key,
          pdf_storage_path: pdfStoragePath,
        }
      : null;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    db.update(documents)
      .set({ status: "error" })
      .where(eq(documents.id, doc.id))
      .run();
    return void res
      .status(500)
      .json({ detail: `Document processing failed: ${String(e)}` });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  filename: string,
): Promise<unknown[] | null> {
  try {
    if (fileType === "pdf") {
      const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
      );
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length) {
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      }
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines
        .slice(0, 30)
        .map((line, i) => ({
          id: `h1-${i}`,
          title: line.slice(0, 100),
          level: 1,
          page_number: null,
          children: [],
        }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
