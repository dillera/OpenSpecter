import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { chats, chatMessages, documents, documentEdits, documentVersions, projects } from "../schema";
import { eq, and, inArray, asc, desc, or } from "drizzle-orm";
import {
    buildDocContext,
    buildMessages,
    enrichWithPriorEvents,
    buildWorkflowStore,
    extractAnnotations,
    runLLMStream,
    type ChatMessage,
} from "../lib/chatTools";
import { completeText } from "../lib/llm";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { activityEventExists, logActivityEvent, titleFromPrompt, updateActivityTitle } from "../lib/activity";

export const chatRouter = Router();

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;

    const ownProjects = db.select({ id: projects.id }).from(projects).where(eq(projects.userId, userId)).all();
    const ownProjectIds = ownProjects.map((p) => p.id);

    const data = ownProjectIds.length > 0
        ? db.select().from(chats).where(or(eq(chats.userId, userId), inArray(chats.projectId, ownProjectIds))).orderBy(desc(chats.createdAt)).all()
        : db.select().from(chats).where(eq(chats.userId, userId)).orderBy(desc(chats.createdAt)).all();

    res.json(data);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const projectId: string | null = req.body.project_id ?? null;

    const [data] = db.insert(chats).values({ userId, projectId: projectId ?? null }).returning({ id: chats.id }).all();
    if (!data) return void res.status(500).json({ detail: "Failed to create chat" });

    await logActivityEvent({
        userId,
        eventType: "assistant_chat_created",
        title: "New assistant chat",
        entityType: "chat",
        entityId: data.id,
        projectId,
        metadata: { source: "chat_create" },
    });

    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;

    const [chat] = db.select().from(chats).where(eq(chats.id, chatId)).limit(1).all();
    if (!chat)
        return void res.status(404).json({ detail: "Chat not found" });
    // Owner of the chat OR a member of the chat's project can view it.
    let canView = chat.userId === userId;
    if (!canView && chat.projectId) {
        const access = await checkProjectAccess(
            chat.projectId,
            userId,
            userEmail,
        );
        canView = access.ok;
    }
    if (!canView)
        return void res.status(404).json({ detail: "Chat not found" });

    const messages = db.select().from(chatMessages).where(eq(chatMessages.chatId, chatId)).orderBy(asc(chatMessages.createdAt)).all();

    const hydrated = await hydrateEditStatuses(messages as Record<string, unknown>[]);
    res.json({ chat, messages: hydrated });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string")
                versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        collectFromAnnList(m.annotations);
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const rows = db.select({ id: documentEdits.id, status: documentEdits.status }).from(documentEdits).where(inArray(documentEdits.id, Array.from(editIds))).all();
        for (const r of rows) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status as "pending" | "accepted" | "rejected");
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const vrows = db.select({ id: documentVersions.id, versionNumber: documentVersions.versionNumber }).from(documentVersions).where(inArray(documentVersions.id, Array.from(versionIds))).all();
        for (const r of vrows) {
            versionNumberById.set(r.id, r.versionNumber ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        next.annotations = patchAnnList(m.annotations);
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const title = (req.body.title ?? "").trim();
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const [data] = db.update(chats).set({ title }).where(and(eq(chats.id, chatId), eq(chats.userId, userId))).returning({ id: chats.id, title: chats.title }).all();

    if (!data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    db.delete(chats).where(and(eq(chats.id, chatId), eq(chats.userId, userId))).run();
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message: string = (req.body.message ?? "").trim();
    if (!message)
        return void res.status(400).json({ detail: "message is required" });

    const [chat] = db.select({ id: chats.id, userId: chats.userId, projectId: chats.projectId }).from(chats).where(eq(chats.id, chatId)).limit(1).all();

    if (!chat)
        return void res.status(404).json({ detail: "Chat not found" });
    let canTitle = chat.userId === userId;
    if (!canTitle && chat.projectId) {
        const access = await checkProjectAccess(
            chat.projectId,
            userId,
            userEmail,
        );
        canTitle = access.ok;
    }
    if (!canTitle)
        return void res.status(404).json({ detail: "Chat not found" });

    try {
        const { title_model, api_keys } = await getUserModelSettings(userId);
        const titleText = await completeText({
            model: title_model,
            user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
            maxTokens: 64,
            apiKeys: api_keys,
        });
        const title = titleText.trim() || message.slice(0, 60);

        db.update(chats).set({ title }).where(and(eq(chats.id, chatId), eq(chats.userId, userId))).run();

        await updateActivityTitle({
            userId,
            entityType: "chat",
            entityId: chatId,
            title,
        });

        res.json({ title });
    } catch (err) {
        console.error("[generate-title]", err);
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { messages, chat_id, project_id, model } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        project_id?: string;
        model?: string;
    };

    console.log("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;
    let createdChat = false;

    if (chatId) {
        // Either chat owner OR a member of the chat's project can post.
        const [existing] = db.select({ id: chats.id, title: chats.title, userId: chats.userId, projectId: chats.projectId }).from(chats).where(eq(chats.id, chatId)).limit(1).all();
        let canUse = !!existing && existing.userId === userId;
        if (!canUse && existing?.projectId) {
            const access = await checkProjectAccess(
                existing.projectId,
                userId,
                userEmail,
            );
            canUse = access.ok;
        }
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title ?? null;
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        if (project_id) {
            const access = await checkProjectAccess(
                project_id,
                userId,
                userEmail,
            );
            if (!access.ok)
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
        }
        const [newChat] = db.insert(chats).values({ userId, projectId: project_id ?? null }).returning({ id: chats.id, title: chats.title }).all();
        if (!newChat) {
            console.error("[chat/stream] failed to create chat");
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id;
        chatTitle = newChat.title ?? null;
        createdChat = true;
    }

    console.log("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
        db.insert(chatMessages).values({
            chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        }).run();

        if (createdChat) {
            const hasExistingActivity = await activityEventExists({
                userId,
                eventType: "assistant_chat_created",
                entityType: "chat",
                entityId: chatId,
            });
            if (!hasExistingActivity) {
                await logActivityEvent({
                    userId,
                    eventType: "assistant_chat_created",
                    title: titleFromPrompt(lastUser.content, "New assistant chat"),
                    entityType: "chat",
                    entityId: chatId,
                    projectId: project_id ?? null,
                    metadata: {
                        model: model ?? null,
                        file_count: lastUser.files?.length ?? 0,
                    },
                });
            }
        } else if (chatId) {
            const hasExistingActivity = await activityEventExists({
                userId,
                eventType: "assistant_chat_created",
                entityType: "chat",
                entityId: chatId,
            });
            if (!hasExistingActivity) {
                await logActivityEvent({
                    userId,
                    eventType: "assistant_chat_created",
                    title: titleFromPrompt(lastUser.content, "New assistant chat"),
                    entityType: "chat",
                    entityId: chatId,
                    projectId: project_id ?? null,
                    metadata: {
                        model: model ?? null,
                        file_count: lastUser.files?.length ?? 0,
                        source: "first_message_existing_chat",
                    },
                });
            }
        }

        if (lastUser.workflow?.id) {
            await logActivityEvent({
                userId,
                eventType: "workflow_used",
                title: lastUser.workflow.title || "Workflow used",
                entityType: "workflow",
                entityId: lastUser.workflow.id,
                projectId: project_id ?? null,
                metadata: {
                    chat_id: chatId,
                    model: model ?? null,
                },
            });
        }
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        chatId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        docIndex,
    );
    const apiMessages = buildMessages(enrichedMessages, docAvailability);

    const workflowStore = await buildWorkflowStore(userId, userEmail);

    console.log("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    const apiKeys = await getUserApiKeys(userId);

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            write,
            workflowStore,
            model,
            apiKeys,
            projectId: project_id ?? null,
        });

        console.log("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        const annotations = extractAnnotations(fullText, docIndex, events);
        db.insert(chatMessages).values({
            chatId,
            role: "assistant",
            content: events.length ? events : null,
            annotations: annotations.length ? annotations : null,
        }).run();

        if (!chatTitle && lastUser?.content) {
            db.update(chats).set({ title: lastUser.content.slice(0, 120) }).where(eq(chats.id, chatId)).run();
        }
    } catch (err) {
        console.error("[chat/stream] error:", err);
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});
