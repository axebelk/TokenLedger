import { useQuery } from "@tanstack/react-query";
import { Button, Card, Col, Row, Table } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { adminApi, formatUsd, type PlatformWorkspace } from "../../api/endpoints.js";
import { chartPalette, chartPrimary } from "../../app/theme.js";
import { PageHeader } from "../../components/PageHeader.js";

const csv = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function downloadCsv(rows: (string | number)[][], name: string) {
  const blob = new Blob([rows.map((r) => r.map(csv).join(",")).join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Cross-tenant reporting: fleet spend trend + a per-tenant 30-day breakdown. */
export function PlatformReports() {
  const series = useQuery({ queryKey: ["admin", "timeseries"], queryFn: () => adminApi.timeseries() });
  const workspaces = useQuery({ queryKey: ["admin", "workspaces"], queryFn: () => adminApi.workspaces() });

  const trend = (series.data?.data ?? []).map((d) => ({
    date: d.date.slice(5), cost: Number(d.costUsd), requests: d.requests,
  }));
  const tenants = [...(workspaces.data?.data ?? [])].sort((a, b) => Number(b.costUsd30d) - Number(a.costUsd30d));

  const exportReport = () => {
    const header = ["Workspace", "Slug", "Members", "Projects", "Requests30d", "SpendUSD30d"];
    const body = tenants.map((w) => [w.name, w.slug, w.members, w.projects, w.requests30d, Number(w.costUsd30d).toFixed(6)]);
    const stamp = dayjs().format("YYYY-MM-DD_HHmm");
    downloadCsv([header, ...body], `tokentrail-tenants_${stamp}.csv`);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Platform"
        title="Reports"
        extra={
          <Button icon={<DownloadOutlined />} onClick={exportReport} disabled={!tenants.length}>
            Export tenant CSV
          </Button>
        }
      />
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="Fleet spend (30d)" styles={{ body: { height: 240 } }}>
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
        <Col xs={24} lg={12}>
          <Card title="Fleet requests (30d)" styles={{ body: { height: 240 } }}>
            <ResponsiveContainer>
              <BarChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickLine={false} />
                <YAxis width={50} tickLine={false} />
                <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                <Bar dataKey="requests" fill={chartPalette[1]} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      <Card title="Per-tenant usage (30 days)">
        <Table<PlatformWorkspace>
          rowKey="id"
          loading={workspaces.isLoading}
          dataSource={tenants}
          columns={[
            { title: "Workspace", dataIndex: "name" },
            { title: "Members", dataIndex: "members", align: "right" },
            { title: "Projects", dataIndex: "projects", align: "right" },
            { title: "Requests", dataIndex: "requests30d", align: "right", render: (v: number) => v.toLocaleString() },
            {
              title: "Spend", dataIndex: "costUsd30d", align: "right",
              render: (v: string) => formatUsd(v),
            },
          ]}
        />
      </Card>
    </div>
  );
}
