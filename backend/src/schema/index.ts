import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// User profiles
// ---------------------------------------------------------------------------

export const userProfiles = sqliteTable("user_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().unique(),
  displayName: text("display_name"),
  organisation: text("organisation"),
  tier: text("tier").notNull().default("Free"),
  messageCreditsUsed: integer("message_credits_used").notNull().default(0),
  creditsResetDate: text("credits_reset_date").notNull().default(sql`(datetime('now', '+30 days'))`),
  tabularModel: text("tabular_model").notNull().default("gemini-3-flash-preview"),
  claudeApiKey: text("claude_api_key"),
  geminiApiKey: text("gemini_api_key"),
  legalDataHunterApiKey: text("legal_data_hunter_api_key"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  cmNumber: text("cm_number"),
  visibility: text("visibility").notNull().default("private"),
  // JSON array of email strings
  sharedWith: text("shared_with", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const projectSubfolders = sqliteTable("project_subfolders", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  parentFolderId: text("parent_folder_id"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  filename: text("filename").notNull(),
  fileType: text("file_type"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  pageCount: integer("page_count"),
  structureTree: text("structure_tree", { mode: "json" }),
  status: text("status").notNull().default("pending"),
  folderId: text("folder_id"),
  currentVersionId: text("current_version_id"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const documentVersions = sqliteTable("document_versions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  storagePath: text("storage_path").notNull(),
  pdfStoragePath: text("pdf_storage_path"),
  source: text("source").notNull().default("upload"),
  versionNumber: integer("version_number"),
  displayName: text("display_name"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const documentEdits = sqliteTable("document_edits", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  chatMessageId: text("chat_message_id"),
  versionId: text("version_id").notNull(),
  changeId: text("change_id").notNull(),
  delWId: text("del_w_id"),
  insWId: text("ins_w_id"),
  deletedText: text("deleted_text").notNull().default(""),
  insertedText: text("inserted_text").notNull().default(""),
  contextBefore: text("context_before"),
  contextAfter: text("context_after"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  resolvedAt: text("resolved_at"),
});

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id"),
  title: text("title").notNull(),
  type: text("type").notNull(),
  promptMd: text("prompt_md"),
  columnsConfig: text("columns_config", { mode: "json" }),
  practice: text("practice"),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const hiddenWorkflows = sqliteTable(
  "hidden_workflows",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (t) => [unique().on(t.userId, t.workflowId)],
);

export const workflowShares = sqliteTable(
  "workflow_shares",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    sharedByUserId: text("shared_by_user_id").notNull(),
    sharedWithEmail: text("shared_with_email").notNull(),
    allowEdit: integer("allow_edit", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (t) => [unique().on(t.workflowId, t.sharedWithEmail)],
);

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  title: text("title"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content", { mode: "json" }),
  files: text("files", { mode: "json" }),
  workflow: text("workflow", { mode: "json" }),
  annotations: text("annotations", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// Activity events
// ---------------------------------------------------------------------------

export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull(),
  projectId: text("project_id"),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  title: text("title").notNull(),
  metadata: text("metadata", { mode: "json" }).notNull().default(sql`'{}'`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// Tabular reviews
// ---------------------------------------------------------------------------

export const tabularReviews = sqliteTable("tabular_reviews", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  title: text("title"),
  columnsConfig: text("columns_config", { mode: "json" }),
  workflowId: text("workflow_id"),
  practice: text("practice"),
  // JSON array of email strings
  sharedWith: text("shared_with", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const tabularCells = sqliteTable("tabular_cells", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  reviewId: text("review_id").notNull().references(() => tabularReviews.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  columnIndex: integer("column_index").notNull(),
  content: text("content"),
  citations: text("citations", { mode: "json" }),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const tabularReviewChats = sqliteTable("tabular_review_chats", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  reviewId: text("review_id").notNull().references(() => tabularReviews.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  title: text("title"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const tabularReviewChatMessages = sqliteTable("tabular_review_chat_messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  chatId: text("chat_id").notNull().references(() => tabularReviewChats.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content", { mode: "json" }),
  annotations: text("annotations", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
