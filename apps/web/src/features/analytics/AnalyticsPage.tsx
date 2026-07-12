import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Card, Col, DatePicker, Empty, Row, Segmented, Select, Space, Spin, Table, Typography,
} from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  formatUsd, wsApi,
  type Dimension, type Granularity, type Metric, type Provider,
} from "../../api/endpoints.js";
import { chartPalette, chartPrimary } from "../../app/theme.js";
import { PageHeader } from "../../components/PageHeader.js";

const { RangePicker } = DatePicker;

const METRICS: { value: Metric; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
  { value: "errors", label: "Errors" },
];
const GRANULARITIES: Granularity[] = ["hour", "day", "week", "month"];
const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "team", label: "Team" },
  { value: "user", label: "User" },
  { value: "provider", label: "Provider" },
  { value: "model", label: "Model" },
];
const PROVIDERS: Provider[] = [
  "ANTHROPIC", "OPENAI", "GEMINI", "MINIMAX", "OPENROUTER", "DEEPSEEK", "OLLAMA",
];
const PALETTE = chartPalette;

export function AnalyticsPage() {
  const { ws = "" } = useParams();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(30, "day"), dayjs()]);
  const [metric, setMetric] = useState<Metric>("requests");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [groupBy, setGroupBy] = useState<Dimension>("user");
  const [provider, setProvider] = useState<Provider | undefined>(undefined);
  const [exporting, setExporting] = useState(false);

  const params = {
    from: range[0].startOf("day").toISOString(),
    to: range[1].endOf("day").toISOString(),
    ...(provider ? { provider } : {}),
  };

  const timeseries = useQuery({
    queryKey: [ws, "analytics", "timeseries", { ...params, metric, granularity, groupBy }],
    queryFn: () => wsApi.timeseries(ws, { ...params, metric, granularity, groupBy }),
    placeholderData: (prev) => prev,
  });
  const breakdown = useQuery({
    queryKey: [ws, "analytics", "breakdown", { ...params, groupBy }],
    queryFn: () => wsApi.breakdown(ws, { ...params, groupBy, limit: 100 }),
    placeholderData: (prev) => prev,
  });

  // Pivot the grouped series into a wide table keyed by bucket for Recharts.
  const { chartData, seriesKeys } = useMemo(() => {
    const series = timeseries.data?.series ?? [];
    const byTime = new Map<string, Record<string, number | string>>();
    const keys: { id: string; name: string }[] = [];
    for (const s of series) {
      const name = s.key.name ?? "total";
      keys.push({ id: name, name });
      for (const p of s.points) {
        const label = fmtBucket(p.t, granularity);
        const row = byTime.get(label) ?? { t: label };
        row[name] = p.v;
        byTime.set(label, row);
      }
    }
    return { chartData: [...byTime.values()], seriesKeys: keys };
  }, [timeseries.data, granularity]);

  const metricFmt = (v: number) => (metric === "cost" ? formatUsd(v, true) : compact(v));

  // Datewise export: one row per (date, dimension) with every metric — the
  // actual "daily report", not the aggregated totals.
  async function handleExport() {
    setExporting(true);
    try {
      const metrics: Metric[] = ["requests", "tokens", "cost", "errors"];
      const responses = await Promise.all(
        metrics.map((m) => wsApi.timeseries(ws, { ...params, metric: m, granularity, groupBy })),
      );
      type Row = { date: string; dim: string; requests: number; tokens: number; cost: number; errors: number };
      const rows = new Map<string, Row>();
      responses.forEach((res, i) => {
        const m = metrics[i]!;
        for (const s of res.series) {
          const dim = s.key.name ?? "total";
          for (const p of s.points) {
            const date = fmtDateKey(p.t, granularity);
            const key = `${date}|${dim}`;
            const row = rows.get(key) ?? { date, dim, requests: 0, tokens: 0, cost: 0, errors: 0 };
            row[m] = p.v;
            rows.set(key, row);
          }
        }
      });
      const sorted = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.dim.localeCompare(b.dim));
      const header = ["Date", cap(groupBy), "Requests", "Tokens", "CostUSD", "Errors"];
      const lines = sorted.map((r) => [r.date, csv(r.dim), r.requests, r.tokens, r.cost.toFixed(6), r.errors].join(","));
      downloadCsv(
        [header.join(","), ...lines].join("\n"),
        `tokentrail-${ws}-by-${groupBy}-daily-${dayjs().format("YYYY-MM-DD_HHmmss")}.csv`,
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      <PageHeader eyebrow="Analytics" title="Usage explorer" />
      <Card size="small">
        <Row gutter={[12, 12]} align="middle">
          <Col>
            <RangePicker
              value={range}
              allowClear={false}
              onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
              presets={[
                { label: "7d", value: [dayjs().subtract(7, "day"), dayjs()] },
                { label: "30d", value: [dayjs().subtract(30, "day"), dayjs()] },
                { label: "90d", value: [dayjs().subtract(90, "day"), dayjs()] },
              ]}
            />
          </Col>
          <Col>
            <Segmented
              options={GRANULARITIES.map((g) => ({ value: g, label: g }))}
              value={granularity}
              onChange={(v) => setGranularity(v as Granularity)}
            />
          </Col>
          <Col>
            <Select<Provider | undefined>
              allowClear
              placeholder="All providers"
              style={{ width: 160 }}
              value={provider}
              onChange={setProvider}
              options={PROVIDERS.map((p) => ({ value: p, label: p }))}
            />
          </Col>
          <Col flex="auto" style={{ textAlign: "right" }}>
            <Button
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={handleExport}
              disabled={!breakdown.data?.rows.length}
            >
              Export CSV
            </Button>
          </Col>
        </Row>
      </Card>

      <Card
        title={
          <Space>
            <Segmented
              options={METRICS}
              value={metric}
              onChange={(v) => setMetric(v as Metric)}
            />
            <Typography.Text type="secondary">by</Typography.Text>
            <Select<Dimension>
              value={groupBy}
              onChange={setGroupBy}
              options={DIMENSIONS}
              style={{ width: 130 }}
            />
          </Space>
        }
        styles={{ body: { height: 340 } }}
      >
        {timeseries.isLoading ? (
          <Spin style={{ display: "block", marginTop: 120 }} />
        ) : chartData.length === 0 ? (
          <Empty style={{ marginTop: 100 }} description="No usage in this range" />
        ) : (
          <ResponsiveContainer>
            {seriesKeys.length > 1 ? (
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" tickLine={false} minTickGap={24} />
                <YAxis tickFormatter={metricFmt} width={72} tickLine={false} />
                <Tooltip formatter={(v) => (metric === "cost" ? formatUsd(Number(v)) : compact(Number(v)))} />
                <Legend />
                {seriesKeys.map((k, i) => (
                  <Line key={k.id} type="monotone" dataKey={k.name} stroke={PALETTE[i % PALETTE.length]} dot={false} strokeWidth={2} />
                ))}
              </LineChart>
            ) : (
              <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" tickLine={false} minTickGap={24} />
                <YAxis tickFormatter={metricFmt} width={72} tickLine={false} />
                <Tooltip formatter={(v) => (metric === "cost" ? formatUsd(Number(v)) : compact(Number(v)))} />
                <Area type="monotone" dataKey={seriesKeys[0]?.name ?? "total"} stroke={PALETTE[0]} fill={PALETTE[0]} fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </Card>

      <Card title={`Breakdown by ${groupBy}`}>
        <Table
          size="small"
          rowKey={(r) => r.key.id}
          loading={breakdown.isLoading}
          dataSource={breakdown.data?.rows ?? []}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[
            { title: cap(groupBy), dataIndex: ["key", "name"] },
            { title: "Requests", dataIndex: "requests", align: "right", sorter: (a, b) => a.requests - b.requests, render: (v: number) => v.toLocaleString() },
            {
              title: "Tokens (in/out)", align: "right",
              render: (_, r) => `${compact(r.inputTokens)} / ${compact(r.outputTokens)}`,
            },
            {
              title: "Error rate", dataIndex: "errorRate", align: "right",
              render: (v: number) => `${(v * 100).toFixed(1)}%`,
            },
            {
              title: "Cost", dataIndex: "costUsd", align: "right",
              defaultSortOrder: "descend", sorter: (a, b) => Number(a.costUsd) - Number(b.costUsd),
              render: (v: string) => formatUsd(v),
            },
            {
              title: "Share", dataIndex: "sharePct", align: "right",
              render: (v: number) => `${v.toFixed(1)}%`,
            },
          ]}
          summary={(rows) => {
            const totalCost = rows.reduce((s, r) => s + Number(r.costUsd), 0);
            const totalReq = rows.reduce((s, r) => s + r.requests, 0);
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}><b>Total</b></Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right"><b>{totalReq.toLocaleString()}</b></Table.Summary.Cell>
                <Table.Summary.Cell index={2} />
                <Table.Summary.Cell index={3} />
                <Table.Summary.Cell index={4} align="right"><b>{formatUsd(totalCost)}</b></Table.Summary.Cell>
                <Table.Summary.Cell index={5} />
              </Table.Summary.Row>
            );
          }}
        />
      </Card>
    </Space>
  );
}

function fmtBucket(iso: string, g: Granularity): string {
  const d = dayjs(iso);
  if (g === "hour") return d.format("MMM D HH:00");
  if (g === "month") return d.format("MMM YYYY");
  return d.format("MMM D");
}
function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Date key for the datewise CSV, per granularity (all UTC-day-based). */
function fmtDateKey(iso: string, g: Granularity): string {
  const d = dayjs(iso);
  if (g === "hour") return d.format("YYYY-MM-DD HH:00");
  if (g === "month") return d.format("YYYY-MM");
  return d.format("YYYY-MM-DD"); // day and week (week = starting date)
}

function downloadCsv(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
