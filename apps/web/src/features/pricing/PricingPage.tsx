import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography, message,
} from "antd";
import { DeleteOutlined, DollarOutlined, PlusOutlined, WarningOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import {
  ALL_PROVIDERS, pricingApi, type CatalogPrice, type PriceOverride, type PriceOverrideInput, type Provider,
} from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import { useAuth } from "../../providers/auth-context.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatUsd } from "../../api/endpoints.js";

const PROVIDER_COLORS: Record<Provider, string> = {
  ANTHROPIC: "magenta",
  OPENAI: "green",
  GEMINI: "blue",
  MINIMAX: "orange",
  OPENROUTER: "purple",
  DEEPSEEK: "cyan",
  OLLAMA: "default",
};

export function PricingPage() {
  const { ws = "" } = useParams();
  const auth = useAuth();
  const viewerRole =
    auth.memberships.find((m) => m.workspace.slug === ws)?.role ?? "VIEWER";
  const isAdmin = viewerRole === "ADMIN" || viewerRole === "OWNER";

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <PageHeader
        eyebrow="Settings"
        title="Pricing"
      />
      {!isAdmin && (
        <Alert
          type="info"
          showIcon
          message="You're a Viewer — overrides are read-only."
        />
      )}
      <Card>
        <Tabs
          defaultActiveKey="overrides"
          items={[
            {
              key: "overrides",
              label: "Workspace overrides",
              children: <OverridesTab ws={ws} isAdmin={isAdmin} />,
            },
            {
              key: "catalog",
              label: "Global catalog",
              children: <CatalogTab />,
            },
            {
              key: "unpriced",
              label: "Unpriced traffic",
              children: <UnpricedTab ws={ws} isAdmin={isAdmin} />,
            },
          ]}
        />
      </Card>
    </Space>
  );
}

function OverridesTab({ ws, isAdmin }: { ws: string; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const overrides = useQuery({
    queryKey: [ws, "pricing", "overrides"],
    queryFn: () => pricingApi.overrides(ws),
  });
  const [editing, setEditing] = useState<PriceOverride | "new" | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => pricingApi.deleteOverride(ws, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws, "pricing", "overrides"] }),
    onError: (err) => void message.error(err instanceof ApiError ? err.message : "Couldn't delete override"),
  });

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing("new")}>
            New override
          </Button>
        )}
        <Typography.Text type="secondary">
          Overrides beat the global catalog (matcher precedence: exact &gt; longest prefix).
        </Typography.Text>
      </Space>
      <Table<PriceOverride>
        rowKey="id"
        loading={overrides.isLoading}
        dataSource={overrides.data?.data ?? []}
        pagination={false}
        locale={{ emptyText: <Empty description="No overrides yet — the global catalog applies." /> }}
        columns={[
          {
            title: "Provider", dataIndex: "provider",
            render: (v: Provider) => <Tag color={PROVIDER_COLORS[v] ?? "default"}>{v}</Tag>,
          },
          { title: "Pattern", dataIndex: "modelPattern" },
          {
            title: "Input / MTok",
            dataIndex: "inputPerMtok",
            render: (v: string) => formatUsd(v, false),
          },
          {
            title: "Output / MTok",
            dataIndex: "outputPerMtok",
            render: (v: string) => formatUsd(v, false),
          },
          {
            title: "",
            key: "actions",
            align: "right",
            render: (_, row) =>
              isAdmin ? (
                <Space>
                  <Button size="small" onClick={() => setEditing(row)}>Edit</Button>
                  <Popconfirm
                    title={`Delete override for ${row.provider}/${row.modelPattern}?`}
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove.mutate(row.id)}
                  >
                    <Button danger size="small" icon={<DeleteOutlined />}>Delete</Button>
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]}
      />
      <OverrideEditor
        ws={ws}
        existing={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

function OverrideEditor({
  ws, existing, onClose,
}: { ws: string; existing: PriceOverride | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PriceOverrideInput>();
  const create = useMutation({
    mutationFn: (v: PriceOverrideInput) => pricingApi.createOverride(ws, v),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws, "pricing", "overrides"] });
      void message.success("Override created");
      onClose();
    },
    onError: (err) => void message.error(err instanceof ApiError ? err.message : "Couldn't create override"),
  });
  const update = useMutation({
    mutationFn: (v: Partial<PriceOverrideInput>) => {
      if (!existing) throw new Error("unreachable");
      return pricingApi.updateOverride(ws, existing.id, v);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws, "pricing", "overrides"] });
      void message.success("Override updated");
      onClose();
    },
    onError: (err) => void message.error(err instanceof ApiError ? err.message : "Couldn't update override"),
  });

  return (
    <Modal
      open={existing !== null}
      title={existing ? `Edit override — ${existing.provider}/${existing.modelPattern}` : "New price override"}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={
          existing
            ? {
                provider: existing.provider,
                modelPattern: existing.modelPattern,
                inputPerMtok: existing.inputPerMtok,
                outputPerMtok: existing.outputPerMtok,
                cacheReadPerMtok: existing.cacheReadPerMtok,
                cacheWritePerMtok: existing.cacheWritePerMtok,
              }
            : { provider: "ANTHROPIC", inputPerMtok: "0", outputPerMtok: "0" }
        }
        onFinish={(values) => {
          if (existing) update.mutate(values);
          else create.mutate(values);
        }}
      >
        <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
          <Select
            options={ALL_PROVIDERS.map((p) => ({ value: p, label: p }))}
            disabled={!!existing} // re-keying requires /transfer (OWNER-only); keep simple here
          />
        </Form.Item>
        <Form.Item
          name="modelPattern"
          label="Model pattern"
          rules={[{ required: true }]}
          extra="Exact id (claude-sonnet-5-20251001) or trailing-* prefix (claude-sonnet-5*)"
        >
          <Input placeholder="claude-sonnet-5*" disabled={!!existing} />
        </Form.Item>
        <Form.Item
          name="inputPerMtok"
          label="Input USD per 1M tokens"
          rules={[{ required: true }]}
          normalize={(v) => (typeof v === "number" ? v.toString() : v)}
        >
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} addonBefore={<DollarOutlined />} />
        </Form.Item>
        <Form.Item
          name="outputPerMtok"
          label="Output USD per 1M tokens"
          rules={[{ required: true }]}
          normalize={(v) => (typeof v === "number" ? v.toString() : v)}
        >
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} addonBefore={<DollarOutlined />} />
        </Form.Item>
        <Form.Item
          name="cacheReadPerMtok"
          label="Cache-read USD per 1M tokens"
          normalize={(v) => (typeof v === "number" ? v.toString() : v)}
        >
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} addonBefore={<DollarOutlined />} />
        </Form.Item>
        <Form.Item
          name="cacheWritePerMtok"
          label="Cache-write USD per 1M tokens"
          normalize={(v) => (typeof v === "number" ? v.toString() : v)}
        >
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} addonBefore={<DollarOutlined />} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={create.isPending || update.isPending} block>
          {existing ? "Save" : "Create override"}
        </Button>
      </Form>
    </Modal>
  );
}

function CatalogTab() {
  const catalog = useQuery({
    queryKey: ["pricing", "catalog"],
    queryFn: () => pricingApi.catalog(),
  });
  const [provider, setProvider] = useState<Provider | undefined>();

  const rows = (catalog.data?.data ?? []).filter((r) => !provider || r.provider === provider);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="Filter by provider"
          style={{ width: 220 }}
          value={provider}
          onChange={setProvider}
          options={ALL_PROVIDERS.map((p) => ({ value: p, label: p }))}
        />
        <Typography.Text type="secondary">
          Catalog rows are managed by the seed/sync jobs. To change a price across all
          workspaces, edit packages/db/src/seed/pricing.ts and re-run db:seed.
        </Typography.Text>
      </Space>
      <Table<CatalogPrice>
        rowKey="id"
        loading={catalog.isLoading}
        dataSource={rows}
        pagination={false}
        size="small"
        columns={[
          {
            title: "Provider", dataIndex: "provider",
            render: (v: Provider) => <Tag color={PROVIDER_COLORS[v] ?? "default"}>{v}</Tag>,
          },
          { title: "Pattern", dataIndex: "modelPattern" },
          {
            title: "In / MTok",
            dataIndex: "inputPerMtok",
            render: (v: string) => formatUsd(v, false),
          },
          {
            title: "Out / MTok",
            dataIndex: "outputPerMtok",
            render: (v: string) => formatUsd(v, false),
          },
          {
            title: "CR / MTok",
            dataIndex: "cacheReadPerMtok",
            render: (v: string) => formatUsd(v, false),
          },
          {
            title: "Source",
            dataIndex: "source",
            render: (v: string) => <Tag>{v}</Tag>,
          },
        ]}
      />
    </>
  );
}

function UnpricedTab({ ws, isAdmin }: { ws: string; isAdmin: boolean }) {
  const unpriced = useQuery({
    queryKey: [ws, "pricing", "unpriced"],
    queryFn: () => pricingApi.unpriced(ws),
    enabled: isAdmin, // ADMIN-only on the server too; skip the roundtrip for VIEWERs
    retry: false,
  });

  if (!isAdmin) {
    return (
      <Alert
        type="warning"
        showIcon
        icon={<WarningOutlined />}
        message="Only workspace admins can see unpriced traffic — it can leak cost-attribution gaps."
      />
    );
  }

  const rows = unpriced.data?.data ?? [];

  return (
    <>
      <Alert
        type="info"
        showIcon
        message="Models seen in the last 30 days with no matched price. Either add an override here or seed the global catalog."
        style={{ marginBottom: 12 }}
      />
      <Table
        rowKey={(r) => `${r.provider}/${r.model}`}
        loading={unpriced.isLoading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: <Empty description="All priced — no traffic is going unpriced." /> }}
        columns={[
          {
            title: "Provider", dataIndex: "provider",
            render: (v: Provider) => <Tag color={PROVIDER_COLORS[v] ?? "default"}>{v}</Tag>,
          },
          { title: "Model", dataIndex: "model" },
          { title: "Requests (30d)", dataIndex: "requests" },
          {
            title: "Lost attribution",
            dataIndex: "costLostUsd",
            render: (v: string) => <Typography.Text type="secondary">{formatUsd(v, false)}</Typography.Text>,
          },
        ]}
      />
    </>
  );
}
