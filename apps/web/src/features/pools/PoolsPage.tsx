import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip,
  Typography, message,
} from "antd";
import { ClockCircleOutlined, DeleteOutlined, FireOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import {
  ALL_PROVIDERS, formatUsd, wsApi, type Credential, type Pool, type PoolHealth, type PoolMember,
  type PoolStrategy, type Provider,
} from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import { PageHeader } from "../../components/PageHeader.js";

const STRATEGY_COLORS: Record<PoolStrategy, string> = {
  PRIORITY: "blue", ROUND_ROBIN: "green", WEIGHTED: "purple",
};

const HEALTH_COLORS: Record<PoolHealth, string> = {
  HEALTHY: "green", DEGRADED: "orange", DISABLED: "default",
};

function mutationError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function PoolsPage() {
  const { ws = "" } = useParams();
  const queryClient = useQueryClient();
  const pools = useQuery({ queryKey: [ws, "pools"], queryFn: () => wsApi.pools(ws) });
  const credentials = useQuery({ queryKey: [ws, "credentials"], queryFn: () => wsApi.credentials(ws) });
  const [open, setOpen] = useState<Pool | "new" | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [ws, "pools"] });
    void queryClient.invalidateQueries({ queryKey: [ws, "credentials"] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => wsApi.deletePool(ws, id),
    onSuccess: () => {
      void message.success("Pool removed");
      invalidate();
    },
    onError: (err) => void message.error(mutationError(err, "Couldn't delete pool")),
  });

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <PageHeader
        eyebrow="Settings"
        title="Provider pools"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen("new")}>
            New pool
          </Button>
        }
      />
      <Alert
        type="info"
        showIcon
        message={
          <>
            <strong>Provider pools</strong> are the enterprise fail-over mechanism: when
            a credential gets rate-limited (429) or errors (5xx), the gateway
            automatically switches to the next key in the pool. Each pool targets a
            single provider; you can have many pools (e.g. one per cost tier).
          </>
        }
      />
      <Card>
        <Table<Pool>
          rowKey="id"
          loading={pools.isLoading}
          dataSource={pools.data?.data ?? []}
          pagination={false}
          locale={{ emptyText: "No pools yet — all traffic goes to the workspace-default credential." }}
          expandable={{
            expandedRowRender: (pool) => <PoolMemberList ws={ws} pool={pool} credentials={credentials.data?.data ?? []} onChanged={invalidate} />,
          }}
          columns={[
            { title: "Provider", dataIndex: "provider", render: (v: Provider) => <Tag color="blue">{v}</Tag> },
            { title: "Name", dataIndex: "name" },
            {
              title: "Strategy",
              dataIndex: "strategy",
              render: (v: PoolStrategy) => <Tag color={STRATEGY_COLORS[v]}>{v}</Tag>,
            },
            {
              title: "Cooldown",
              dataIndex: "cooldownS",
              render: (v: number) => `${v}s`,
            },
            {
              title: "Members",
              key: "members",
              render: (_, p) => p.members.length,
              align: "right",
            },
            {
              title: "",
              key: "actions",
              align: "right",
              render: (_, p) => (
                <Space>
                  <Button size="small" icon={<ThunderboltOutlined />} onClick={() => setOpen(p)}>
                    Edit
                  </Button>
                  <Popconfirm
                    title={`Delete pool "${p.name}"?`}
                    description="Members are detached but credentials stay."
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove.mutate(p.id)}
                  >
                    <Button danger size="small" icon={<DeleteOutlined />}>Delete</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <PoolEditor
        ws={ws}
        pool={open === "new" ? null : open}
        onClose={() => setOpen(null)}
        onSaved={invalidate}
      />
    </Space>
  );
}

function PoolMemberList({
  ws, pool, credentials, onChanged,
}: { ws: string; pool: Pool; credentials: Credential[]; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: [ws, "pools", pool.id, "status"],
    queryFn: () => wsApi.poolStatus(ws, pool.id),
    refetchInterval: 10_000, // near-realtime cooldown/usage visibility
  });

  const remove = useMutation({
    mutationFn: (memberId: string) => wsApi.removePoolMember(ws, pool.id, memberId),
    onSuccess: () => {
      void message.success("Member removed");
      onChanged();
    },
    onError: (err) => void message.error(mutationError(err, "Couldn't remove member")),
  });

  const updateMember = useMutation({
    mutationFn: ({ memberId, body }: { memberId: string; body: { health?: PoolHealth } }) =>
      wsApi.updatePoolMember(ws, pool.id, memberId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws, "pools", pool.id, "status"] });
      onChanged();
    },
  });

  const liveByMemberId = new Map<string, { coolingDown: boolean; resetsAt: string | null }>(
    (status.data?.members ?? []).map((m) => [m.id, { coolingDown: m.coolingDown, resetsAt: m.resetsAt }]),
  );

  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">Members — live cooldown from the hot path</Typography.Text>
        <Button size="small" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
          Add credential
        </Button>
      </Space>
      <Table<PoolMember>
        rowKey="id"
        size="small"
        loading={status.isLoading}
        pagination={false}
        dataSource={pool.members}
        columns={[
          { title: "Credential", dataIndex: "credentialName" },
          {
            title: "Secret",
            dataIndex: "secretLast4",
            render: (v: string | null) => (v ? `••••${v}` : "—"),
          },
          { title: "Priority", dataIndex: "priority", align: "right", width: 90 },
          {
            title: "Weight",
            dataIndex: "weight",
            align: "right",
            width: 90,
            render: (v: number, m) => (pool.strategy === "WEIGHTED" ? v : <Typography.Text type="secondary">—</Typography.Text>),
          },
          {
            title: "RPM",
            dataIndex: "rpmLimit",
            align: "right",
            width: 80,
            render: (v: number | null) => v ?? "—",
          },
          {
            title: "Health",
            dataIndex: "health",
            render: (v: PoolHealth, m) => {
              const live = liveByMemberId.get(m.id);
              return (
                <Space>
                  <Tag color={HEALTH_COLORS[v]}>{v}</Tag>
                  {live?.coolingDown && (
                    <Tooltip
                      title={
                        <>
                          Cooling down — gateway is routing around this credential.
                          Resets at <strong>{live.resetsAt ? dayjs(live.resetsAt).format("HH:mm:ss") : "?"}</strong>.
                        </>
                      }
                    >
                      <Tag color="red" icon={<ClockCircleOutlined />}>cooldown</Tag>
                    </Tooltip>
                  )}
                </Space>
              );
            },
          },
          {
            title: "",
            key: "actions",
            align: "right",
            render: (_, m) => (
              <Space>
                {m.health !== "DISABLED" ? (
                  <Button
                    size="small"
                    loading={updateMember.isPending && updateMember.variables?.memberId === m.id}
                    onClick={() => updateMember.mutate({ memberId: m.id, body: { health: "DISABLED" } })}
                  >
                    Disable
                  </Button>
                ) : (
                  <Button
                    size="small"
                    loading={updateMember.isPending && updateMember.variables?.memberId === m.id}
                    onClick={() => updateMember.mutate({ memberId: m.id, body: { health: "HEALTHY" } })}
                  >
                    Re-enable
                  </Button>
                )}
                <Popconfirm
                  title="Remove from pool?"
                  description="The credential itself stays in your vault."
                  okText="Remove"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate(m.id)}
                >
                  <Button danger size="small" icon={<DeleteOutlined />}>Remove</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <AddMemberDrawer
        ws={ws}
        pool={pool}
        available={credentials.filter((c) => c.provider === pool.provider && !pool.members.some((m) => m.credentialId === c.id))}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={onChanged}
      />
    </>
  );
}

function AddMemberDrawer({
  ws, pool, available, open, onClose, onAdded,
}: { ws: string; pool: Pool; available: Credential[]; open: boolean; onClose: () => void; onAdded: () => void }) {
  const [form] = Form.useForm<{ credentialId: string; priority: number; weight: number; rpmLimit?: number; tpmLimit?: number }>();
  const create = useMutation({
    mutationFn: (v: { credentialId: string; priority: number; weight: number; rpmLimit?: number; tpmLimit?: number }) =>
      wsApi.addPoolMember(ws, pool.id, v),
    onSuccess: () => {
      form.resetFields();
      void message.success("Credential added");
      onAdded();
      onClose();
    },
    onError: (err) => void message.error(mutationError(err, "Couldn't add member")),
  });

  return (
    <Drawer title={`Add credential to "${pool.name}"`} open={open} onClose={onClose} width={420}>
      {available.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={`No ${pool.provider} credentials left to add — all existing ones are already members.`}
        />
      ) : (
        <Form form={form} layout="vertical" initialValues={{ priority: 0, weight: 1 }} onFinish={(v) => create.mutate(v)}>
          <Form.Item name="credentialId" label="Credential" rules={[{ required: true }]}>
            <Select options={available.map((c) => ({ value: c.id, label: `${c.name} ${c.secretLast4 ? `••••${c.secretLast4}` : ""}` }))} />
          </Form.Item>
          <Form.Item name="priority" label="Priority" extra="Lower number = preferred first" rules={[{ required: true }]}>
            <InputNumber min={0} max={1000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="weight" label="Weight" extra="Used only with WEIGHTED strategy" rules={[{ required: true }]}>
            <InputNumber min={1} max={1000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="rpmLimit" label="Per-member RPM limit (optional)">
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="tpmLimit" label="Per-member TPM limit (optional)">
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block icon={<PlusOutlined />}>
            Add to pool
          </Button>
        </Form>
      )}
    </Drawer>
  );
}

function PoolEditor({
  ws, pool, onClose, onSaved,
}: { ws: string; pool: Pool | null; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm<{
    provider: Provider; name: string; strategy: PoolStrategy; cooldownS: number;
  }>();
  const create = useMutation({
    mutationFn: (v: { provider: Provider; name: string; strategy: PoolStrategy; cooldownS: number }) =>
      wsApi.createPool(ws, v),
    onSuccess: () => {
      void message.success("Pool created");
      onSaved();
      onClose();
    },
    onError: (err) => void message.error(mutationError(err, "Couldn't create pool")),
  });
  const update = useMutation({
    mutationFn: (v: { name?: string; strategy?: PoolStrategy; cooldownS?: number }) => {
      if (!pool) throw new Error("unreachable");
      return wsApi.updatePool(ws, pool.id, v);
    },
    onSuccess: () => {
      void message.success("Pool updated");
      onSaved();
      onClose();
    },
    onError: (err) => void message.error(mutationError(err, "Couldn't update pool")),
  });

  return (
    <Modal
      open={pool !== null}
      title={pool ? `Edit pool — ${pool.name}` : "New provider pool"}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={
          pool
            ? { provider: pool.provider, name: pool.name, strategy: pool.strategy, cooldownS: pool.cooldownS }
            : { provider: "ANTHROPIC", strategy: "ROUND_ROBIN" as const, cooldownS: 60 }
        }
        onFinish={(values) => {
          if (pool) {
            const { provider: _drop, ...rest } = values;
            void _drop;
            update.mutate(rest);
          } else {
            create.mutate(values);
          }
        }}
      >
        <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
          <Select
            options={ALL_PROVIDERS.map((p) => ({ value: p, label: p }))}
            disabled={!!pool}
          />
        </Form.Item>
        <Form.Item name="name" label="Pool name" rules={[{ required: true }]} extra="For your reference — appears in dashboards and event metadata">
          <Input placeholder="e.g. prod, free-tier, partner-X" disabled={!!pool} />
        </Form.Item>
        <Form.Item name="strategy" label="Selection strategy" rules={[{ required: true }]}>
          <Select
            options={[
              { value: "ROUND_ROBIN", label: "Round-robin (default — even load distribution)" },
              { value: "PRIORITY", label: "Priority (fallback order)" },
              { value: "WEIGHTED", label: "Weighted random (cost-tier mixing)" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="cooldownS"
          label="Cooldown window (seconds)"
          extra="How long a credential sits out of rotation after a 429 / 5xx before being trusted again (5–3600)"
          rules={[{ required: true }]}
        >
          <InputNumber min={5} max={3600} style={{ width: "100%" }} suffix="s" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={create.isPending || update.isPending} block icon={<FireOutlined />}>
          {pool ? "Save" : "Create pool"}
        </Button>
      </Form>
    </Modal>
  );
}
