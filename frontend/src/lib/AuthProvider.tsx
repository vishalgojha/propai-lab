"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { clearInvalidLocalSession, getUser, getSession, onAuthStateChange, signOut } from "@/lib/auth";
import { getAuthMe, setActiveTenantId } from "@/lib/api";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function isUnauthorizedAuthError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  return "status" in error && (error as { status?: unknown }).status === 401;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`${label} request timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const syncActiveTenant = async (currentUser: User | null) => {
    if (!currentUser) {
      setActiveTenantId(null);
      return;
    }
    // Never send a tenant selected by a previously signed-in account.
    setActiveTenantId(null);
    try {
      const me = await getAuthMe();
      setActiveTenantId(me.active_tenant || null);
    } catch {
      // Keep the last known tenant if the auth-me call fails.
    }
  };

  useEffect(() => {
    let mounted = true;

    const clearUnauthorizedSession = async (error: unknown) => {
      if (!isUnauthorizedAuthError(error)) return;
      try {
        await clearInvalidLocalSession();
      } catch {
        // The local storage cleanup is best-effort. Do not retain a user
        // object after the auth server has rejected its token.
      }
      if (!mounted) return;
      setSession(null);
      setUser(null);
      setActiveTenantId(null);
      setError(null);
    };

    const initAuth = async () => {
      try {
        const sessionData = await withTimeout(getSession(), 5000, "session");
        if (mounted) {
          setSession(sessionData);
          setUser(sessionData?.user ?? null);
          setError(null);
          setLoading(false);
          void syncActiveTenant(sessionData?.user ?? null);
          void withTimeout(getUser(), 10000, "user")
            .then((userData) => {
              if (!mounted) return;
              setUser(userData ?? sessionData?.user ?? null);
              void syncActiveTenant(userData ?? sessionData?.user ?? null);
            })
            .catch((error) => {
              // A transport failure can be transient, but an explicit 401 is
              // definitive: keeping the cached user lets protected routes
              // render in an inconsistent state.
              void clearUnauthorizedSession(error);
            });
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Unable to verify your session right now.");
        }
      }
      if (mounted) setLoading(false);
    };

    initAuth();

    const { data: listener } = onAuthStateChange((event, session) => {
      if (mounted) {
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) setError(null);
        if (event === "SIGNED_OUT") {
          setUser(null);
          setSession(null);
          setActiveTenantId(null);
          setError(null);
        }
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const refresh = async () => {
    try {
      const sessionData = await withTimeout(getSession(), 5000, "session");
      setSession(sessionData);
      setUser(sessionData?.user ?? null);
      setError(null);
      void syncActiveTenant(sessionData?.user ?? null);
      void withTimeout(getUser(), 10000, "user")
        .then((userData) => {
          setUser(userData ?? sessionData?.user ?? null);
          void syncActiveTenant(userData ?? sessionData?.user ?? null);
        })
        .catch(async (error) => {
          if (!isUnauthorizedAuthError(error)) return;
          try {
            await clearInvalidLocalSession();
          } catch {
            // Best-effort local cleanup; state is cleared below either way.
          }
          setSession(null);
          setUser(null);
          setActiveTenantId(null);
          setError(null);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify your session right now.");
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setUser(null);
    setSession(null);
    setActiveTenantId(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, error, signOut: handleSignOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
