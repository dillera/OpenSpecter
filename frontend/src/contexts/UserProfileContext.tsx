"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getProfile, patchProfile } from "@/app/lib/openSpecterApi";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    claudeApiKey: string | null;
    geminiApiKey: string | null;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini",
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const CREDIT_LIMIT = 999999;

const fallbackProfile = (): UserProfile => {
    const resetDate = new Date();
    resetDate.setDate(resetDate.getDate() + 30);
    return {
        displayName: null,
        organisation: null,
        messageCreditsUsed: 0,
        creditsResetDate: resetDate.toISOString(),
        creditsRemaining: CREDIT_LIMIT,
        tier: "Free",
        tabularModel: "gemini-3-flash-preview",
        claudeApiKey: null,
        geminiApiKey: null,
    };
};

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            const data = await getProfile();

            let creditsUsed = data.message_credits_used;
            let resetDate = data.credits_reset_date;
            let creditsRemaining = CREDIT_LIMIT - creditsUsed;

            // Reset credits if the period has expired
            if (resetDate && new Date() > new Date(resetDate)) {
                const newResetDate = new Date();
                newResetDate.setDate(newResetDate.getDate() + 30);
                resetDate = newResetDate.toISOString();
                creditsUsed = 0;
                creditsRemaining = CREDIT_LIMIT;
                // Background update — don't await
                patchProfile({
                    message_credits_used: 0,
                    credits_reset_date: resetDate,
                }).catch((e) => console.error("Failed to auto-reset credits", e));
            }

            setProfile({
                displayName: data.display_name,
                organisation: data.organisation,
                messageCreditsUsed: creditsUsed,
                creditsResetDate: resetDate,
                creditsRemaining,
                tier: data.tier || "Free",
                tabularModel: data.tabular_model || "gemini-3-flash-preview",
                claudeApiKey: data.claude_api_key,
                geminiApiKey: data.gemini_api_key,
            });
        } catch {
            setProfile(fallbackProfile());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            try {
                await patchProfile({ display_name: displayName });
                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            try {
                await patchProfile({ organisation });
                setProfile((prev) => (prev ? { ...prev, organisation } : null));
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateModelPreference = useCallback(
        async (field: "tabularModel", value: string): Promise<boolean> => {
            try {
                await patchProfile({ tabular_model: value });
                setProfile((prev) => (prev ? { ...prev, [field]: value } : null));
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini",
            value: string | null,
        ): Promise<boolean> => {
            const patchKey =
                provider === "claude" ? "claude_api_key" : "gemini_api_key";
            const stateKey =
                provider === "claude" ? "claudeApiKey" : "geminiApiKey";
            const normalized = value?.trim() ? value.trim() : null;
            try {
                await patchProfile({ [patchKey]: normalized });
                setProfile((prev) =>
                    prev ? { ...prev, [stateKey]: normalized } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const reloadProfile = useCallback(async () => {
        await loadProfile();
    }, [loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!profile || profile.creditsRemaining <= 0) return false;
        const newCreditsUsed = profile.messageCreditsUsed + 1;
        try {
            await patchProfile({ message_credits_used: newCreditsUsed });
            setProfile((prev) =>
                prev
                    ? {
                          ...prev,
                          messageCreditsUsed: newCreditsUsed,
                          creditsRemaining: CREDIT_LIMIT - newCreditsUsed,
                      }
                    : null,
            );
            return true;
        } catch {
            return false;
        }
    }, [profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
