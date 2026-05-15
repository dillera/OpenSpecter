import { db } from "./db";
import { userProfiles } from "../schema";
import { eq } from "drizzle-orm";
import {
  resolveModel,
  DEFAULT_TITLE_MODEL,
  DEFAULT_TABULAR_MODEL,
  type UserApiKeys,
} from "./llm";

export type UserModelSettings = {
  title_model: string;
  tabular_model: string;
  api_keys: UserApiKeys;
};

function resolveTitleModel(apiKeys: UserApiKeys): string {
  if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
  if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
  return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(userId: string): Promise<UserModelSettings> {
  const [data] = db
    .select({
      tabularModel: userProfiles.tabularModel,
      claudeApiKey: userProfiles.claudeApiKey,
      geminiApiKey: userProfiles.geminiApiKey,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
    .all();

  const api_keys: UserApiKeys = {
    claude: data?.claudeApiKey ?? null,
    gemini: data?.geminiApiKey ?? null,
  };

  return {
    title_model: resolveTitleModel(api_keys),
    tabular_model: resolveModel(data?.tabularModel, DEFAULT_TABULAR_MODEL),
    api_keys,
  };
}

export async function getUserApiKeys(userId: string): Promise<UserApiKeys> {
  const [data] = db
    .select({
      claudeApiKey: userProfiles.claudeApiKey,
      geminiApiKey: userProfiles.geminiApiKey,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
    .all();
  return {
    claude: data?.claudeApiKey ?? null,
    gemini: data?.geminiApiKey ?? null,
  };
}
