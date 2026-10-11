import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, type Clinic, type User } from "./lib/api";

interface Session {
  user: User;
  clinic: Clinic;
}

interface AuthState {
  /** undefined: still asking the server. null: nobody is logged in. */
  session: Session | null | undefined;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState>({ session: undefined, refresh: async () => {}, logout: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSession(await api.get<Session>("/api/auth/me"));
    } catch (err) {
      // Only "not logged in" means there is no session; a network failure must not log anyone out.
      if (err instanceof ApiError && err.status === 401) setSession(null);
      else setSession((s) => (s === undefined ? null : s));
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout").catch(() => {});
    setSession(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <AuthContext.Provider value={{ session, refresh, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/** The logged-in user and clinic. Only for pages rendered inside the staff area, where a session exists. */
export function useSession(): Session {
  const { session } = useAuth();
  if (!session) throw new Error("useSession outside the staff area");
  return session;
}
