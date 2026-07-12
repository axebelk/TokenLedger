import { Layout, Menu, Space, Typography, Button, Tag } from "antd";
import {
  ApiOutlined, AppstoreOutlined, BarChartOutlined, DashboardOutlined, GlobalOutlined,
  KeyOutlined, RocketOutlined, TableOutlined, TeamOutlined, UsergroupAddOutlined,
} from "@ant-design/icons";
import { Link, Outlet, useLocation, useParams } from "react-router-dom";
import { useAuth } from "../providers/auth-context.js";

const { Sider, Header, Content } = Layout;

export function AppShell() {
  const { ws } = useParams<{ ws: string }>();
  const { user, isSuperAdmin, memberships, logout } = useAuth();
  const location = useLocation();

  const current = memberships.find((m) => m.workspace.slug === ws);
  const section = location.pathname.split("/")[2] ?? "dashboard";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="light" width={224} className="tt-sider">
        <div className="tt-brand">
          <span className="tt-brand__mark" />
          <span className="tt-brand__word">TokenTrail</span>
        </div>
        <Menu
          theme="light"
          mode="inline"
          className="tt-sider__menu"
          selectedKeys={[section]}
          items={[
            { key: "dashboard", icon: <DashboardOutlined />, label: <Link to={`/${ws}`}>Dashboard</Link> },
            { key: "setup", icon: <RocketOutlined />, label: <Link to={`/${ws}/setup`}>Connect</Link> },
            { type: "divider", className: "tt-menu-divider" },
            { key: "analytics", icon: <BarChartOutlined />, label: <Link to={`/${ws}/analytics`}>Analytics</Link> },
            { key: "usage", icon: <TableOutlined />, label: <Link to={`/${ws}/usage`}>Usage</Link> },
            { type: "divider", className: "tt-menu-divider" },
            { key: "keys", icon: <KeyOutlined />, label: <Link to={`/${ws}/keys`}>Virtual Keys</Link> },
            { key: "projects", icon: <AppstoreOutlined />, label: <Link to={`/${ws}/projects`}>Projects</Link> },
            { key: "teams", icon: <UsergroupAddOutlined />, label: <Link to={`/${ws}/teams`}>Teams</Link> },
            { key: "providers", icon: <ApiOutlined />, label: <Link to={`/${ws}/providers`}>Providers</Link> },
            { key: "members", icon: <TeamOutlined />, label: <Link to={`/${ws}/members`}>Members</Link> },
          ]}
        />
      </Sider>
      <Layout>
        <Header className="tt-topbar">
          <Space size={10}>
            <Typography.Text strong className="tt-topbar__title">
              {current?.workspace.name ?? ws}
            </Typography.Text>
            {current && <Tag color="default">{current.role}</Tag>}
          </Space>
          <Space size={12}>
            {isSuperAdmin && (
              <Link to="/admin">
                <Button size="small" icon={<GlobalOutlined />}>Platform</Button>
              </Link>
            )}
            <Typography.Text type="secondary" className="tt-topbar__email">{user?.email}</Typography.Text>
            <Button size="small" onClick={() => void logout()}>
              Sign out
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
