import { useQuery } from "@tanstack/react-query";
import { Card, Col, Layout, Row, Statistic, Table, Typography, Button } from "antd";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { adminApi, formatUsd, type PlatformWorkspace } from "../../api/endpoints.js";
import { useAuth } from "../../providers/auth-context.js";

const { Header, Content } = Layout;

/** Instance super-admin view — every workspace on this deployment. */
export function PlatformPage() {
  const { isSuperAdmin, user, logout } = useAuth();
  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: () => adminApi.stats(), enabled: isSuperAdmin });
  const workspaces = useQuery({ queryKey: ["admin", "workspaces"], queryFn: () => adminApi.workspaces(), enabled: isSuperAdmin });

  if (!isSuperAdmin) {
    return (
      <Layout style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Typography.Text type="secondary">Super-admin access required.</Typography.Text>
      </Layout>
    );
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ background: "#141414", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography.Text strong style={{ color: "white", fontSize: 16 }}>
          TokenTrail · Platform
        </Typography.Text>
        <span style={{ color: "#aaa" }}>
          {user?.email}
          <Button size="small" style={{ marginLeft: 12 }} onClick={() => void logout()}>Sign out</Button>
        </span>
      </Header>
      <Content style={{ padding: 24 }}>
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} lg={6}><Card><Statistic title="Workspaces" value={stats.data?.workspaces ?? 0} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="Users" value={stats.data?.users ?? 0} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="Active keys" value={stats.data?.activeKeys ?? 0} /></Card></Col>
          <Col xs={12} lg={6}>
            <Card><Statistic title="Spend (30d)" value={formatUsd(stats.data?.costUsd30d ?? "0", true)} /></Card>
          </Col>
        </Row>

        <Card title="All workspaces">
          <Table<PlatformWorkspace>
            rowKey="id"
            loading={workspaces.isLoading}
            dataSource={workspaces.data?.data ?? []}
            columns={[
              {
                title: "Workspace", dataIndex: "name",
                render: (name: string, w) => <Link to={`/${w.slug}`}>{name}</Link>,
              },
              { title: "Slug", dataIndex: "slug" },
              { title: "Members", dataIndex: "members", align: "right" },
              { title: "Projects", dataIndex: "projects", align: "right" },
              { title: "Requests (30d)", dataIndex: "requests30d", align: "right", render: (v: number) => v.toLocaleString() },
              {
                title: "Spend (30d)", dataIndex: "costUsd30d", align: "right",
                sorter: (a, b) => Number(a.costUsd30d) - Number(b.costUsd30d),
                render: (v: string) => formatUsd(v),
              },
              { title: "Created", dataIndex: "createdAt", render: (v: string) => dayjs(v).format("MMM D, YYYY") },
            ]}
          />
        </Card>
      </Content>
    </Layout>
  );
}
