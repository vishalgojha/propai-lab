"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { getUser, getSession, onAuthStateChange, signOut } from "@/lib/auth";
import { getAuthMe, setActiveTenantId } from "@/lib/api";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      const [sessionData, userData] = await Promise.all([getSession(), getUser()]);
      if (mounted) {
        setSession(sessionData);
        setUser(userData);
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
        setLoading(false);
      }
    };

    initAuth();

    const { data: listener } = onAuthStateChange((event, session) => {
      if (mounted) {
        setSession(session);
        setUser(session?.user ?? null);
        if (event === "SIGNED_OUT") {
          setUser(null);
          setSession(null);
          setActiveTenantId(null);
        }
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const refresh = async () => {
    const [sessionData, userData] = await Promise.all([getSession(), getUser()]);
    setSession(sessionData);
    setUser(userData);
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
  };

  const handleSignOut = async () => {
    await signOut();
    setUser(null);
    setSession(null);
    setActiveTenantId(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut: handleSignOut, refresh }}>
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
