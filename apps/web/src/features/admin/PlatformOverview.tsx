import { useQuery } from "@tanstack/react-query";
import { Card, Col, Row, Statistic, Table } from "antd";
import { Link } from "react-router-dom";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { adminApi, formatUsd, type PlatformWorkspace } from "../../api/endpoints.js";
import { chartPrimary } from "../../app/theme.js";
import { PageHeader } from "../../components/PageHeader.js";

/** Fleet-wide summary: headline stats, 30-day spend trend, biggest tenants. */
export function PlatformOverview() {
  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: () => adminApi.stats() });
  const series = useQuery({ queryKey: ["admin", "timeseries"], queryFn: () => adminApi.timeseries() });
  const workspaces = useQuery({ queryKey: ["admin", "workspaces"], queryFn: () => adminApi.workspaces() });

  const trend = (series.data?.data ?? []).map((d) => ({ date: d.date.slice(5), cost: Number(d.costUsd) }));
  const topTenants = [...(workspaces.data?.data ?? [])]
    .sort((a, b) => Number(b.costUsd30d) - Number(a.costUsd30d))
    .slice(0, 5);

  return (
    <div>
      <PageHeader eyebrow="Platform" title="Overview" />
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={6}><Card><Statistic title="Workspaces" value={stats.data?.workspaces ?? 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="Users" value={stats.data?.users ?? 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="Active keys" value={stats.data?.activeKeys ?? 0} /></Card></Col>
        <Col xs={12} lg={6}>
          <Card><Statistic title="Spend (30d)" value={formatUsd(stats.data?.costUsd30d ?? "0", true)} /></Card>
        </Col>

        <Col xs={24} lg={16}>
          <Card title="Fleet spend over time" styles={{ body: { height: 260 } }}>
            <ResponsiveContainer>
              <AreaChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickLine={false} />
                <YAxis tickFormatter={(v: number) => formatUsd(v, true)} width={70} tickLine={false} />
                <Tooltip formatter={(v) => formatUsd(Number(v))} />
                <Area dataKey="cost" stroke={chartPrimary} fill={chartPrimary} fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="Top tenants by spend" styles={{ body: { paddingTop: 0 } }}>
            <Table<PlatformWorkspace>
              rowKey="id"
              size="small"
              pagination={false}
              showHeader={false}
              loading={workspaces.isLoading}
              dataSource={topTenants}
              columns={[
                { title: "Workspace", dataIndex: "name", render: (name: string, w) => <Link to={`/${w.slug}`}>{name}</Link> },
                { title: "Spend", dataIndex: "costUsd30d", align: "right", render: (v: string) => formatUsd(v) },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
