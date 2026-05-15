import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { userProfiles } from "../schema";
import { eq } from "drizzle-orm";

export const userRouter = Router();

function ensureProfile(userId: string) {
  db.insert(userProfiles).values({ userId }).onConflictDoNothing().run();
  return db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1).all()[0];
}

// GET /user/profile
userRouter.get("/profile", requireAuth, (_req, res) => {
  const userId = res.locals.userId as string;
  const p = ensureProfile(userId);
  res.json({
    display_name: p.displayName,
    organisation: p.organisation,
    tier: p.tier,
    message_credits_used: p.messageCreditsUsed,
    credits_reset_date: p.creditsResetDate,
    tabular_model: p.tabularModel,
    claude_api_key: p.claudeApiKey,
    gemini_api_key: p.geminiApiKey,
  });
});

// POST /user/profile — ensure profile row exists (called after signup)
userRouter.post("/profile", requireAuth, (_req, res) => {
  const userId = res.locals.userId as string;
  ensureProfile(userId);
  res.json({ ok: true });
});

// PATCH /user/profile — update allowed profile fields
userRouter.patch("/profile", requireAuth, (req, res) => {
  const userId = res.locals.userId as string;

  const fieldMap: Record<string, string> = {
    display_name: "displayName",
    organisation: "organisation",
    tabular_model: "tabularModel",
    claude_api_key: "claudeApiKey",
    gemini_api_key: "geminiApiKey",
    message_credits_used: "messageCreditsUsed",
    credits_reset_date: "creditsResetDate",
  };

  const updates: Record<string, unknown> = {};
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in req.body) updates[camelKey] = req.body[snakeKey];
  }

  if (Object.keys(updates).length === 0) {
    return void res.status(400).json({ detail: "No valid fields to update" });
  }

  updates.updatedAt = new Date().toISOString();
  db.update(userProfiles).set(updates).where(eq(userProfiles.userId, userId)).run();
  res.json({ ok: true });
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;

  db.delete(userProfiles).where(eq(userProfiles.userId, userId)).run();

  const admin = createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SECRET_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
