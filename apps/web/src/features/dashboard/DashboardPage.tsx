import { useQuery } from "@tanstack/react-query";
import { Card, Col, Empty, Row, Spin, Statistic, Table } from "antd";
import { useParams } from "react-router-dom";
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatUsd, wsApi } from "../../api/endpoints.js";
import { OnboardingWizard } from "../onboarding/OnboardingWizard.js";
import { chartPalette, chartPrimary } from "../../app/theme.js";
import { PageHeader } from "../../components/PageHeader.js";

export function DashboardPage() {
  const { ws = "" } = useParams();
  const summary = useQuery({
    queryKey: [ws, "analytics", "summary"],
    queryFn: () => wsApi.summary(ws),
    refetchInterval: 60_000,
  });
  const credentials = useQuery({ queryKey: [ws, "credentials"], queryFn: () => wsApi.credentials(ws), retry: false });
  const keys = useQuery({ queryKey: [ws, "keys"], queryFn: () => wsApi.keys(ws) });

  if (summary.isLoading || keys.isLoading) {
    return <Spin style={{ display: "block", marginTop: 80 }} size="large" />;
  }

  // Empty workspace → onboarding wizard. Admins start at step 0; members
  // without credential access start at the key step.
  const hasTraffic = (summary.data?.requests ?? 0) > 0;
  if (!hasTraffic) {
    const hasCredential = (credentials.data?.data.length ?? 0) > 0;
    const hasKey = (keys.data?.data.length ?? 0) > 0;
    const step = hasKey ? 3 : hasCredential ? 1 : 0;
    return <OnboardingWizard ws={ws} initialStep={step} />;
  }

  const s = summary.data!;
  const providerData = s.byProvider.map((p) => ({ name: p.provider, value: Number(p.costUsd) }));
  const dayData = s.byDay.map((d) => ({ date: d.date.slice(5), cost: Number(d.costUsd) }));

  return (
    <div>
      <PageHeader eyebrow="Overview" title={`Last ${s.rangeDays} days`} />
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}><Card><Statistic title="Spend" value={formatUsd(s.costUsd, true)} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="Requests" value={s.requests} /></Card></Col>
        <Col xs={12} lg={6}>
          <Card><Statistic title="Tokens (in / out)" value={`${compact(s.inputTokens)} / ${compact(s.outputTokens)}`} /></Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card><Statistic title="Error rate" value={(s.errorRate * 100).toFixed(1)} suffix="%" /></Card>
        </Col>

        <Col xs={24} lg={16}>
          <Card title="Spend over time" styles={{ body: { height: 280 } }}>
            {dayData.length === 0 ? <Empty /> : (
              <ResponsiveContainer>
                <AreaChart data={dayData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} />
                  <YAxis tickFormatter={(v: number) => formatUsd(v, true)} width={70} tickLine={false} />
                  <Tooltip formatter={(v) => formatUsd(Number(v))} />
                  <Area dataKey="cost" stroke={chartPrimary} fill={chartPrimary} fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="Spend by provider" styles={{ body: { height: 280 } }}>
            {providerData.length === 0 ? <Empty /> : (
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={providerData} dataKey="value" nameKey="name" innerRadius={55} label={(e) => e.name}>
                    {providerData.map((_, i) => (
                      <Cell key={i} fill={chartPalette[i % chartPalette.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => formatUsd(Number(v))} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>

        <Col xs={24}>
          <Card title="Top models by cost">
            <Table
              size="small"
              rowKey={(r) => `${r.provider}/${r.model}`}
              pagination={false}
              dataSource={s.byModel}
              columns={[
                { title: "Model", dataIndex: "model" },
                { title: "Provider", dataIndex: "provider" },
                { title: "Requests", dataIndex: "requests", align: "right" },
                {
                  title: "Cost", dataIndex: "costUsd", align: "right",
                  render: (v: string) => formatUsd(v),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
