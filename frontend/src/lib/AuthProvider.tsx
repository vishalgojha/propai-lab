"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { getUser, getSession, onAuthStateChange, signOut } from "@/lib/auth";
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

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      try {
        const [sessionData, userData] = await Promise.all([
          withTimeout(getSession(), 15000, "session"),
          withTimeout(getUser(), 15000, "session"),
        ]);
        if (mounted) {
          setSession(sessionData);
          setUser(userData);
          setError(null);
          if (!userData) {
            setActiveTenantId(null);
          }
          if (userData) {
            try {
              const me = await getAuthMe();
              if (mounted) {
                setActiveTenantId(me.active_tenant || null);
              }
            } catch {
              // Keep the last known tenant if the auth-me call fails.
            }
          }
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
      const [sessionData, userData] = await Promise.all([
        withTimeout(getSession(), 15000, "session"),
        withTimeout(getUser(), 15000, "session"),
      ]);
      setSession(sessionData);
      setUser(userData);
      setError(null);
      if (!userData) {
        setActiveTenantId(null);
        return;
      }
      try {
        const me = await getAuthMe();
        setActiveTenantId(me.active_tenant || null);
      } catch {
        // leave tenant untouched if auth-me fails during refresh
      }
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
