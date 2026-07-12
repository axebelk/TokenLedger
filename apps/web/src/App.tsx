import { Navigate, Outlet, Route, Routes, useParams } from "react-router-dom";
import { Spin } from "antd";
import { AuthProvider, useAuth } from "./providers/auth-context.js";
import { LoginPage, RegisterPage } from "./features/auth/AuthPages.js";
import { AppShell } from "./app/AppShell.js";
import { DashboardPage } from "./features/dashboard/DashboardPage.js";
import { AnalyticsPage } from "./features/analytics/AnalyticsPage.js";
import { UsagePage } from "./features/usage/UsagePage.js";
import { KeysPage } from "./features/keys/KeysPage.js";
import { ProjectsPage } from "./features/projects/ProjectsPage.js";
import { TeamsPage } from "./features/teams/TeamsPage.js";
import { TeamDetailPage } from "./features/teams/TeamDetailPage.js";
import { ProvidersPage } from "./features/providers/ProvidersPage.js";
import { MembersPage } from "./features/members/MembersPage.js";
import { AcceptInvitePage } from "./features/members/AcceptInvitePage.js";
import { SetupPage } from "./features/setup/SetupPage.js";
import { PlatformPage } from "./features/admin/PlatformPage.js";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/invite/:token" element={<AcceptInvitePage />} />
        <Route path="/" element={<HomeRedirect />} />
        {/* Standalone (no workspace shell): the platform view spans all tenants. */}
        <Route element={<RequireAuthBare />}>
          <Route path="/admin" element={<PlatformPage />} />
        </Route>
        <Route element={<RequireAuth />}>
          <Route path="/:ws" element={<RequireWorkspace />}>
            <Route index element={<DashboardPage />} />
            <Route path="setup" element={<SetupPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="keys" element={<KeysPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="teams" element={<TeamsPage />} />
            <Route path="teams/:teamId" element={<TeamDetailPage />} />
            <Route path="providers" element={<ProvidersPage />} />
            <Route path="members" element={<MembersPage />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}

function CenteredSpin() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Spin size="large" />
    </div>
  );
}

/** Auth gate that renders the child route directly (no workspace shell). */
function RequireAuthBare() {
  const { status } = useAuth();
  if (status === "loading") return <CenteredSpin />;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RequireAuth() {
  const { status } = useAuth();
  if (status === "loading") return <CenteredSpin />;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  return <AppShell />;
}

/** Unknown workspace slugs bounce home instead of rendering an empty shell. */
function RequireWorkspace() {
  const { ws } = useParams<{ ws: string }>();
  const { memberships, status } = useAuth();
  if (status === "loading") return <CenteredSpin />;
  const known = memberships.some((m) => m.workspace.slug === ws);
  if (!known) return <Navigate to="/" replace />;
  return <Outlet />;
}

function HomeRedirect() {
  const { status, memberships } = useAuth();
  if (status === "loading") return <CenteredSpin />;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  const first = memberships[0]?.workspace.slug;
  return first ? <Navigate to={`/${first}`} replace /> : <Navigate to="/register" replace />;
}
