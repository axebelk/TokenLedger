import { Layout, Menu, Space, Typography, Button, Tag } from "antd";
import {
  ApiOutlined, AppstoreOutlined, BarChartOutlined, DashboardOutlined,
  KeyOutlined, TableOutlined, TeamOutlined, UsergroupAddOutlined,
} from "@ant-design/icons";
import { Link, Outlet, useLocation, useParams } from "react-router-dom";
import { useAuth } from "../providers/auth-context.js";

const { Sider, Header, Content } = Layout;

export function AppShell() {
  const { ws } = useParams<{ ws: string }>();
  const { user, memberships, logout } = useAuth();
  const location = useLocation();

  const current = memberships.find((m) => m.workspace.slug === ws);
  const section = location.pathname.split("/")[2] ?? "dashboard";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="dark" width={210}>
        <div style={{ padding: 16 }}>
          <Typography.Text strong style={{ color: "white", fontSize: 16 }}>
            TokenTrail
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[section]}
          items={[
            { key: "dashboard", icon: <DashboardOutlined />, label: <Link to={`/${ws}`}>Dashboard</Link> },
            { key: "analytics", icon: <BarChartOutlined />, label: <Link to={`/${ws}/analytics`}>Analytics</Link> },
            { key: "usage", icon: <TableOutlined />, label: <Link to={`/${ws}/usage`}>Usage</Link> },
            { key: "keys", icon: <KeyOutlined />, label: <Link to={`/${ws}/keys`}>Virtual Keys</Link> },
            { key: "projects", icon: <AppstoreOutlined />, label: <Link to={`/${ws}/projects`}>Projects</Link> },
            { key: "teams", icon: <UsergroupAddOutlined />, label: <Link to={`/${ws}/teams`}>Teams</Link> },
            { key: "providers", icon: <ApiOutlined />, label: <Link to={`/${ws}/providers`}>Providers</Link> },
            { key: "members", icon: <TeamOutlined />, label: <Link to={`/${ws}/members`}>Members</Link> },
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "white", display: "flex", alignItems: "center",
            justifyContent: "space-between", paddingInline: 24,
          }}
        >
          <Space>
            <Typography.Text strong>{current?.workspace.name ?? ws}</Typography.Text>
            {current && <Tag>{current.role}</Tag>}
          </Space>
          <Space>
            <Typography.Text type="secondary">{user?.email}</Typography.Text>
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
