import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { documents, documentVersions } from "../schema";
import { eq } from "drizzle-orm";
import { buildContentDisposition, downloadFile } from "../lib/storage";
import { verifyDownload } from "../lib/downloadTokens";
import { ensureDocAccess } from "../lib/access";

export const downloadsRouter = Router();

function contentTypeFor(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".docx"))
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".xlsx"))
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return "application/octet-stream";
}

// GET /download/:token
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const info = verifyDownload(req.params.token);
    if (!info)
        return void res.status(404).json({ detail: "Invalid link" });

    const [version] = db
        .select({ id: documentVersions.id, documentId: documentVersions.documentId })
        .from(documentVersions)
        .where(eq(documentVersions.storagePath, info.path))
        .limit(1)
        .all();

    if (!version)
        return void res.status(404).json({ detail: "File not found" });

    const [doc] = db
        .select({ id: documents.id, userId: documents.userId, projectId: documents.projectId })
        .from(documents)
        .where(eq(documents.id, version.documentId))
        .limit(1)
        .all();
    if (!doc)
        return void res.status(404).json({ detail: "File not found" });

    const access = await ensureDocAccess(
        { user_id: doc.userId, project_id: doc.projectId ?? null },
        userId,
        userEmail,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "File not found" });

    const raw = await downloadFile(info.path);
    if (!raw)
        return void res.status(404).json({ detail: "File not found" });

    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", info.filename),
    );
    res.send(Buffer.from(raw));
});
