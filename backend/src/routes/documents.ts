import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { documents, documentVersions, documentEdits } from "../schema";
import { eq, and, inArray, desc, isNull } from "drizzle-orm";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";

export const documentsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

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

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const rawDocs = db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.projectId)))
    .orderBy(desc(documents.createdAt))
    .all();
  const docs = rawDocs.map((d) =>
    docToApi(d as unknown as Record<string, unknown>),
  ) as unknown as { id: string; current_version_id?: string | null }[];
  await attachLatestVersionNumbers(docs);
  await attachActiveVersionPaths(docs);
  res.json(docs);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    await handleDocumentUpload(req, res, userId, null);
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;

  const [doc] = db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
    .limit(1)
    .all();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });

  // Fan out and delete each version's bytes before dropping rows
  const versions = db
    .select({
      storagePath: documentVersions.storagePath,
      pdfStoragePath: documentVersions.pdfStoragePath,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .all();
  await Promise.all(
    versions.flatMap((v) =>
      [v.storagePath, v.pdfStoragePath]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  db.delete(documents).where(eq(documents.id, documentId)).run();
  res.status(204).send();
});

// GET /single-documents/:documentId/display
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;

  const [doc] = db
    .select({
      id: documents.id,
      filename: documents.filename,
      fileType: documents.fileType,
      userId: documents.userId,
      projectId: documents.projectId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .all();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(
    { user_id: doc.userId, project_id: doc.projectId ?? null },
    userId,
    userEmail,
  );
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = doc.fileType ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";

  const servePath =
    isDocx && active.pdf_storage_path
      ? active.pdf_storage_path
      : active.storage_path;
  const raw = await downloadFile(servePath);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });

  if (fileType === "pdf" || (isDocx && active.pdf_storage_path)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename),
    );
    res.send(Buffer.from(raw));
  } else {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename),
    );
    res.send(Buffer.from(raw));
  }
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const rawDocs = db
    .select({
      id: documents.id,
      filename: documents.filename,
      fileType: documents.fileType,
      currentVersionId: documents.currentVersionId,
      userId: documents.userId,
      projectId: documents.projectId,
    })
    .from(documents)
    .where(inArray(documents.id, document_ids))
    .all();

  const accessChecks = await Promise.all(
    rawDocs.map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        { user_id: d.userId, project_id: d.projectId ?? null },
        userId,
        userEmail,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string; filename: string });
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(doc.filename, Buffer.from(raw));
    }),
  );

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

// GET /single-documents/:documentId/url
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const [doc] = db
    .select({
      id: documents.id,
      filename: documents.filename,
      userId: documents.userId,
      projectId: documents.projectId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .all();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(
    { user_id: doc.userId, project_id: doc.projectId ?? null },
    userId,
    userEmail,
  );
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(
    active.storage_path,
    3600,
    downloadFilename,
  );
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const [doc] = db
    .select({
      id: documents.id,
      filename: documents.filename,
      userId: documents.userId,
      projectId: documents.projectId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .all();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(
    { user_id: doc.userId, project_id: doc.projectId ?? null },
    userId,
    userEmail,
  );
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      resolveDownloadFilename(
        doc.filename,
        active.display_name,
        active.version_number,
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

// GET /single-documents/:documentId/versions
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;

  const [doc] = db
    .select({
      id: documents.id,
      currentVersionId: documents.currentVersionId,
      userId: documents.userId,
      projectId: documents.projectId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .all();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(
    { user_id: doc.userId, project_id: doc.projectId ?? null },
    userId,
    userEmail,
  );
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const rows = db
    .select({
      id: documentVersions.id,
      version_number: documentVersions.versionNumber,
      source: documentVersions.source,
      created_at: documentVersions.createdAt,
      display_name: documentVersions.displayName,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(documentVersions.createdAt)
    .all();

  res.json({
    current_version_id: doc.currentVersionId ?? null,
    versions: rows,
  });
});

// POST /single-documents/:documentId/versions
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const [doc] = db
      .select({
        id: documents.id,
        filename: documents.filename,
        fileType: documents.fileType,
        userId: documents.userId,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
      .all();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(
      { user_id: doc.userId, project_id: doc.projectId ?? null },
      userId,
      userEmail,
    );
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const suffix = file.originalname.includes(".")
      ? file.originalname.split(".").pop()!.toLowerCase()
      : "";
    if (doc.fileType && suffix && doc.fileType !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.fileType}).`,
      });
    }

    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      file.originalname,
    );
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    try {
      await uploadFile(
        key,
        file.buffer.buffer.slice(
          file.buffer.byteOffset,
          file.buffer.byteOffset + file.buffer.byteLength,
        ) as ArrayBuffer,
        contentType,
      );
    } catch (e) {
      console.error("[versions/upload] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
    }

    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(file.buffer);
        const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
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
          `[versions/upload] DOCX→PDF conversion failed for ${file.originalname}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Per-document sequential version_number
    const maxRows = db
      .select({ versionNumber: documentVersions.versionNumber })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          inArray(documentVersions.source, ["upload", "user_upload", "assistant_edit"]),
        ),
      )
      .orderBy(desc(documentVersions.versionNumber))
      .limit(1)
      .all();
    const nextVersionNumber = ((maxRows[0]?.versionNumber as number | null) ?? 1) + 1;

    const defaultDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : file.originalname;

    const [versionRow] = db
      .insert(documentVersions)
      .values({
        documentId,
        storagePath: key,
        pdfStoragePath,
        source: "user_upload",
        versionNumber: nextVersionNumber,
        displayName: defaultDisplayName,
      })
      .returning()
      .all();
    if (!versionRow) {
      console.error("[versions/upload] insert failed");
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }

    const documentsUpdate: Record<string, unknown> = {
      currentVersionId: versionRow.id,
    };
    const providedDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = doc.filename?.match(/\.[a-z0-9]{1,6}$/i)?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      documentsUpdate.filename = `${providedDisplayName}${ext}`;
    }
    db.update(documents)
      .set(documentsUpdate)
      .where(eq(documents.id, documentId))
      .run();

    res.status(201).json({
      id: versionRow.id,
      version_number: versionRow.versionNumber,
      source: versionRow.source,
      created_at: versionRow.createdAt,
      display_name: versionRow.displayName,
    });
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;

    const [doc] = db
      .select({
        id: documents.id,
        userId: documents.userId,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
      .all();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(
      { user_id: doc.userId, project_id: doc.projectId ?? null },
      userId,
      userEmail,
    );
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const [updated] = db
      .update(documentVersions)
      .set({ displayName })
      .where(and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId)))
      .returning()
      .all();
    if (!updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json({
      id: updated.id,
      version_number: updated.versionNumber,
      source: updated.source,
      created_at: updated.createdAt,
      display_name: updated.displayName,
    });
  },
);

// GET /single-documents/:documentId/tracked-change-ids
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;

    const [doc] = db
      .select({
        id: documents.id,
        userId: documents.userId,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
      .all();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(
      { user_id: doc.userId, project_id: doc.projectId ?? null },
      userId,
      userEmail,
    );
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;

  console.log(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const [edit] = db
    .select({
      id: documentEdits.id,
      documentId: documentEdits.documentId,
      changeId: documentEdits.changeId,
      delWId: documentEdits.delWId,
      insWId: documentEdits.insWId,
      status: documentEdits.status,
    })
    .from(documentEdits)
    .where(and(eq(documentEdits.id, editId), eq(documentEdits.documentId, documentId)))
    .limit(1)
    .all();
  console.log(`[edit-resolution] fetched edit row`, { edit });
  if (!edit) {
    console.log(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }

  if (edit.status !== "pending") {
    console.log(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const [doc] = db
      .select({
        currentVersionId: documents.currentVersionId,
        filename: documents.filename,
        userId: documents.userId,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
      .all();
    if (!doc) {
      console.log(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(
      { user_id: doc.userId, project_id: doc.projectId ?? null },
      userId,
      userEmail,
    );
    if (!accessResolved.ok) {
      console.log(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.currentVersionId ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            doc.filename ?? "document.docx",
          )
        : null,
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning already-resolved payload`, payload);
    return void res.status(200).json(payload);
  }

  const [doc] = db
    .select({
      id: documents.id,
      currentVersionId: documents.currentVersionId,
      userId: documents.userId,
      projectId: documents.projectId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .all();
  console.log(`[edit-resolution] fetched doc`, { doc });
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(
    { user_id: doc.userId, project_id: doc.projectId ?? null },
    userId,
    userEmail,
  );
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId);
  const latestPath = active?.storage_path ?? null;
  console.log(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.currentVersionId,
  });
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  console.log(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.delWId, edit.insWId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  console.log(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.changeId,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  if (!found) {
    console.log(
      `[edit-resolution] change_id not found in docx — updating status only`,
    );
    db.update(documentEdits)
      .set({
        status: mode === "accept" ? "accepted" : "rejected",
        resolvedAt: new Date().toISOString(),
      })
      .where(eq(documentEdits.id, editId))
      .run();
    console.log(`[edit-resolution] status-only update done`);
    const [filenameRow] = db
      .select({ filename: documents.filename })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
      .all();
    const payload = {
      ok: true,
      version_id: doc.currentVersionId,
      download_url: buildDownloadUrl(
        latestPath,
        filenameRow?.filename ?? "document.docx",
      ),
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning not-found payload`, payload);
    return void res.status(200).json(payload);
  }

  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;
  console.log(`[edit-resolution] overwriting bytes in place`, {
    latestPath,
    byteLength: ab.byteLength,
  });
  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  db.update(documentEdits)
    .set({
      status: mode === "accept" ? "accepted" : "rejected",
      resolvedAt: new Date().toISOString(),
    })
    .where(eq(documentEdits.id, editId))
    .run();
  console.log(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
  });

  const remainingPendingRows = db
    .select({ id: documentEdits.id })
    .from(documentEdits)
    .where(and(eq(documentEdits.documentId, documentId), eq(documentEdits.status, "pending")))
    .all();
  const remainingPending = remainingPendingRows.length;
  console.log(`[edit-resolution] remaining pending count`, { remainingPending });

  const [filenameRow] = db
    .select({ filename: documents.filename })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .all();
  const payload = {
    ok: true,
    version_id: doc.currentVersionId,
    download_url: buildDownloadUrl(
      latestPath,
      filenameRow?.filename ?? "document.docx",
    ),
    remaining_pending: remainingPending,
  };
  console.log(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

async function handleDocumentUpload(
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
  _filename: string,
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
      if (outline?.length)
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
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
