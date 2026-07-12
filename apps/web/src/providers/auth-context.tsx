import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { setAccessToken, setSessionLostHandler, tryRefresh } from "../api/client.js";
import { authApi, type Membership, type User } from "../api/endpoints.js";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  user: User | null;
  isSuperAdmin: boolean;
  memberships: Membership[];
  login(email: string, password: string): Promise<void>;
  register(body: { email: string; password: string; name: string; workspaceName?: string }): Promise<string>;
  logout(): Promise<void>;
  reloadMemberships(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [memberships, setMemberships] = useState<Membership[]>([]);

  const becomeAnonymous = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setIsSuperAdmin(false);
    setMemberships([]);
    setStatus("anonymous");
  }, []);

  const loadMe = useCallback(async () => {
    const me = await authApi.me();
    setUser(me.user);
    setIsSuperAdmin(me.isSuperAdmin);
    setMemberships(me.memberships);
    setStatus("authenticated");
  }, []);

  // Bootstrap: the httpOnly refresh cookie is the only durable credential.
  useEffect(() => {
    setSessionLostHandler(becomeAnonymous);
    tryRefresh()
      .then((r) => (r ? loadMe() : becomeAnonymous()))
      .catch(becomeAnonymous);
  }, [becomeAnonymous, loadMe]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      isSuperAdmin,
      memberships,
      async login(email, password) {
        const res = await authApi.login({ email, password });
        setAccessToken(res.accessToken);
        await loadMe();
      },
      async register(body) {
        const res = await authApi.register(body);
        setAccessToken(res.accessToken);
        await loadMe();
        return res.workspace.slug;
      },
      async logout() {
        await authApi.logout().catch(() => {});
        becomeAnonymous();
      },
      reloadMemberships: loadMe,
    }),
    [status, user, isSuperAdmin, memberships, loadMe, becomeAnonymous],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
