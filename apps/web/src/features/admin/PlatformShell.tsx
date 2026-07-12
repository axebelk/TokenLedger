import { Button, Layout, Menu, Space, Typography } from "antd";
import {
  ApartmentOutlined, ArrowLeftOutlined, BarChartOutlined, DashboardOutlined,
} from "@ant-design/icons";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../providers/auth-context.js";

const { Sider, Header, Content } = Layout;

/**
 * Super-admin console shell — a platform-scoped chrome that spans all tenants,
 * distinct from the workspace AppShell. Nav: Overview / Tenants / Reports.
 */
export function PlatformShell() {
  const { user, memberships, logout } = useAuth();
  const location = useLocation();
  // /admin → overview, /admin/tenants → tenants, /admin/reports → reports
  const section = location.pathname.split("/")[2] ?? "overview";
  const backSlug = memberships[0]?.workspace.slug;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="light" width={224} className="tt-sider">
        <div className="tt-brand">
          <span className="tt-brand__mark" />
          <span className="tt-brand__word">TokenTrail</span>
          <span className="tt-brand__badge">PLATFORM</span>
        </div>
        <Menu
          theme="light"
          mode="inline"
          className="tt-sider__menu"
          selectedKeys={[section]}
          items={[
            { key: "overview", icon: <DashboardOutlined />, label: <Link to="/admin">Overview</Link> },
            { key: "tenants", icon: <ApartmentOutlined />, label: <Link to="/admin/tenants">Tenants</Link> },
            { key: "reports", icon: <BarChartOutlined />, label: <Link to="/admin/reports">Reports</Link> },
          ]}
        />
      </Sider>
      <Layout>
        <Header className="tt-topbar">
          <Space size={10}>
            <Typography.Text strong className="tt-topbar__title">Platform admin</Typography.Text>
          </Space>
          <Space size={12}>
            {backSlug && (
              <Link to={`/${backSlug}`}>
                <Button size="small" icon={<ArrowLeftOutlined />}>Back to workspace</Button>
              </Link>
            )}
            <Typography.Text type="secondary" className="tt-topbar__email">{user?.email}</Typography.Text>
            <Button size="small" onClick={() => void logout()}>Sign out</Button>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
