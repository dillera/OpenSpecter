import { db } from "./db";
import { documents, documentVersions } from "../schema";
import { eq, inArray, and, isNotNull, max } from "drizzle-orm";

interface DocRow {
  id: string;
  latest_version_number?: number | null;
  [k: string]: unknown;
}

interface VersionPathRow extends DocRow {
  storage_path?: string | null;
  pdf_storage_path?: string | null;
  current_version_id?: string | null;
  active_version_number?: number | null;
}

export interface ActiveVersion {
  id: string;
  storage_path: string;
  pdf_storage_path: string | null;
  version_number: number | null;
  display_name: string | null;
  source: string | null;
}

export async function loadActiveVersion(
  documentId: string,
  versionId?: string | null,
): Promise<ActiveVersion | null> {
  const [doc] = db
    .select({ currentVersionId: documents.currentVersionId })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .all();

  const targetVersionId =
    (typeof versionId === "string" && versionId) ||
    doc?.currentVersionId ||
    null;
  if (!targetVersionId) return null;

  const [v] = db
    .select({
      id: documentVersions.id,
      documentId: documentVersions.documentId,
      storagePath: documentVersions.storagePath,
      pdfStoragePath: documentVersions.pdfStoragePath,
      versionNumber: documentVersions.versionNumber,
      displayName: documentVersions.displayName,
      source: documentVersions.source,
    })
    .from(documentVersions)
    .where(eq(documentVersions.id, targetVersionId))
    .limit(1)
    .all();

  if (!v || v.documentId !== documentId || !v.storagePath) return null;
  return {
    id: v.id,
    storage_path: v.storagePath,
    pdf_storage_path: v.pdfStoragePath ?? null,
    version_number: v.versionNumber ?? null,
    display_name: v.displayName ?? null,
    source: v.source ?? null,
  };
}

export async function attachActiveVersionPaths<T extends VersionPathRow>(
  docs: T[],
): Promise<T[]> {
  if (docs.length === 0) return docs;
  const versionIds = docs
    .map((d) => d.current_version_id)
    .filter((id): id is string => typeof id === "string");
  if (versionIds.length === 0) {
    for (const d of docs) {
      d.storage_path = null;
      d.pdf_storage_path = null;
    }
    return docs;
  }
  const rows = db
    .select({
      id: documentVersions.id,
      storagePath: documentVersions.storagePath,
      pdfStoragePath: documentVersions.pdfStoragePath,
      versionNumber: documentVersions.versionNumber,
    })
    .from(documentVersions)
    .where(inArray(documentVersions.id, versionIds))
    .all();

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const d of docs) {
    const v = d.current_version_id ? byId.get(d.current_version_id) : null;
    d.storage_path = v?.storagePath ?? null;
    d.pdf_storage_path = v?.pdfStoragePath ?? null;
    d.active_version_number = v?.versionNumber ?? null;
  }
  return docs;
}

export async function attachLatestVersionNumbers<T extends DocRow>(
  docs: T[],
): Promise<T[]> {
  if (docs.length === 0) return docs;
  const ids = docs.map((d) => d.id);

  const rows = db
    .select({
      documentId: documentVersions.documentId,
      versionNumber: documentVersions.versionNumber,
    })
    .from(documentVersions)
    .where(
      and(
        inArray(documentVersions.documentId, ids),
        eq(documentVersions.source, "assistant_edit"),
        isNotNull(documentVersions.versionNumber),
      ),
    )
    .all();

  const latestByDoc = new Map<string, number>();
  for (const r of rows) {
    if (r.versionNumber == null) continue;
    const prev = latestByDoc.get(r.documentId) ?? 0;
    if (r.versionNumber > prev) latestByDoc.set(r.documentId, r.versionNumber);
  }
  for (const d of docs) {
    d.latest_version_number = latestByDoc.get(d.id) ?? null;
  }
  return docs;
}
