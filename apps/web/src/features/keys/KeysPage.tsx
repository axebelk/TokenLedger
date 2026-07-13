import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography,
} from "antd";
import { EditOutlined, PlusOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import { membersApi, wsApi, type VirtualKey } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import { CopyField } from "../../components/CopyField.js";

export function KeysPage() {
  const { ws = "" } = useParams();
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: [ws, "keys"], queryFn: () => wsApi.keys(ws) });
  const members = useQuery({ queryKey: [ws, "members"], queryFn: () => membersApi.list(ws), retry: false });
  const memberName = useMemo(
    () => new Map((members.data?.data ?? []).map((m) => [m.id, m.name])),
    [members.data],
  );
  const [issueOpen, setIssueOpen] = useState(false);
  const [editing, setEditing] = useState<VirtualKey | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => wsApi.revokeKey(ws, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws, "keys"] }),
  });

  return (
    <Card
      title="Virtual keys"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setIssueOpen(true)}>
          Issue key
        </Button>
      }
    >
      <Table<VirtualKey>
        rowKey="id"
        loading={keys.isLoading}
        dataSource={keys.data?.data ?? []}
        columns={[
          { title: "Name", dataIndex: "name" },
          {
            title: "Assigned to", dataIndex: "userId",
            render: (userId: string) => memberName.get(userId) ?? "—",
          },
          {
            title: "Key", dataIndex: "keyLast4",
            render: (last4: string) => <Typography.Text code>tt_live_…{last4}</Typography.Text>,
          },
          {
            title: "Status", dataIndex: "status",
            render: (status: VirtualKey["status"]) => (
              <Tag color={status === "ACTIVE" ? "green" : status === "REVOKED" ? "red" : "orange"}>
                {status}
              </Tag>
            ),
          },
          {
            title: "Last used", dataIndex: "lastUsedAt",
            render: (v: string | null) => (v ? dayjs(v).format("MMM D, HH:mm") : "never"),
          },
          {
            title: "Created", dataIndex: "createdAt",
            render: (v: string) => dayjs(v).format("MMM D, YYYY"),
          },
          {
            title: "",
            render: (_, key) =>
              key.status === "ACTIVE" && (
                <Space>
                  <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(key)}>
                    Edit
                  </Button>
                  <Popconfirm
                    title="Revoke this key?"
                    description="Requests using it will fail within 5 seconds."
                    onConfirm={() => revoke.mutate(key.id)}
                  >
                    <Button danger size="small">Revoke</Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />
      <IssueKeyModal ws={ws} open={issueOpen} onClose={() => setIssueOpen(false)} />
      <EditKeyModal
        ws={ws}
        vkey={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: [ws, "keys"] });
          setEditing(null);
        }}
      />
    </Card>
  );
}

function IssueKeyModal({ ws, open, onClose }: { ws: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: [ws, "projects"],
    queryFn: () => wsApi.projects(ws),
    enabled: open,
  });
  const members = useQuery({
    queryKey: [ws, "members"],
    queryFn: () => membersApi.list(ws),
    enabled: open,
    retry: false, // members without admin access can only issue to themselves
  });
  const credentials = useQuery({
    queryKey: [ws, "credentials"],
    queryFn: () => wsApi.credentials(ws),
    enabled: open,
    retry: false,
  });
  // Active credentials only — each is its own option so a workspace with
  // several credentials for the same provider (e.g. multiple Anthropic
  // accounts) can still be told apart by name, not just provider.
  const credentialOptions = (credentials.data?.data ?? [])
    .filter((c) => c.status === "ACTIVE")
    .map((c) => ({ value: c.id, label: `${c.provider} · ${c.name}` }));
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [form] = Form.useForm();

  const issue = useMutation({
    mutationFn: (values: { projectId: string; name: string; userId?: string; credentialAllowlist?: string[] }) =>
      wsApi.issueKey(ws, values),
    onSuccess: (created) => {
      setIssuedKey(created.key);
      void queryClient.invalidateQueries({ queryKey: [ws, "keys"] });
    },
  });

  const close = () => {
    setIssuedKey(null);
    setAcknowledged(false);
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title={issuedKey ? "Key issued" : "Issue a virtual key"}
      open={open}
      onCancel={() => {
        if (!issuedKey || acknowledged) close();
      }}
      footer={null}
      closable={!issuedKey || acknowledged}
      maskClosable={false}
    >
      {issuedKey ? (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert type="warning" message="Copy this key now — it will not be shown again." />
          <CopyField value={issuedKey} />
          <Checkbox checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)}>
            I've stored this key somewhere safe
          </Checkbox>
          <Button type="primary" disabled={!acknowledged} onClick={close} block>
            Done
          </Button>
        </Space>
      ) : (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: { projectId: string; name: string; userId?: string }) =>
            issue.mutate(values)
          }
        >
          <Form.Item name="projectId" label="Project" rules={[{ required: true }]}>
            <Select
              loading={projects.isLoading}
              options={(projects.data?.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              placeholder="Which project is this key for?"
            />
          </Form.Item>
          <Form.Item
            name="userId"
            label="Assign to member"
            extra="The key's usage is attributed to this member. Defaults to you; admins can assign to anyone."
          >
            <Select
              allowClear
              loading={members.isLoading}
              placeholder="Yourself"
              showSearch
              optionFilterProp="label"
              options={(members.data?.data ?? []).map((m) => ({
                value: m.id,
                label: `${m.name} (${m.email})`,
              }))}
              notFoundContent={members.isError ? "Only admins can assign to others" : undefined}
            />
          </Form.Item>
          <Form.Item
            name="credentialAllowlist"
            label="Restrict to credentials (optional)"
            extra="Leave empty to use the workspace's default credential per provider. Pick specific ones if you have several credentials for the same provider (e.g. multiple Anthropic accounts) and this key must always use a particular one."
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Workspace default per provider"
              loading={credentials.isLoading}
              options={credentialOptions}
            />
          </Form.Item>
          <Form.Item name="name" label="Key name" rules={[{ required: true }]}>
            <Input placeholder="laptop dev key" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={issue.isPending} block>
            Issue key
          </Button>
        </Form>
      )}
    </Modal>
  );
}

function EditKeyModal({
  ws, vkey, onClose, onSaved,
}: { ws: string; vkey: VirtualKey | null; onClose: () => void; onSaved: () => void }) {
  const credentials = useQuery({
    queryKey: [ws, "credentials"],
    queryFn: () => wsApi.credentials(ws),
    enabled: vkey !== null,
    retry: false,
  });
  const credentialOptions = (credentials.data?.data ?? [])
    .filter((c) => c.status === "ACTIVE")
    .map((c) => ({ value: c.id, label: `${c.provider} · ${c.name}` }));
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  // Re-seed the form whenever a different key is opened for editing.
  useEffect(() => {
    if (vkey) {
      form.setFieldsValue({
        name: vkey.name,
        credentialAllowlist: vkey.credentialAllowlist,
        rpmLimit: vkey.rpmLimit,
        expiresAt: vkey.expiresAt ? dayjs(vkey.expiresAt) : undefined,
      });
      setError(null);
    }
  }, [vkey, form]);

  const update = useMutation({
    mutationFn: (values: {
      name: string; credentialAllowlist?: string[];
      rpmLimit?: number | null; expiresAt?: dayjs.Dayjs | null;
    }) =>
      wsApi.updateKey(ws, vkey!.id, {
        name: values.name,
        credentialAllowlist: values.credentialAllowlist ?? [],
        rpmLimit: values.rpmLimit ?? null,
        expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to save"),
  });

  if (!vkey) return null;

  return (
    <Modal title="Edit virtual key" open={vkey !== null} onCancel={onClose} footer={null}>
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Form
        form={form}
        layout="vertical"
        onFinish={(values: {
          name: string; credentialAllowlist?: string[];
          rpmLimit?: number | null; expiresAt?: dayjs.Dayjs | null;
        }) => update.mutate(values)}
      >
        <Form.Item name="name" label="Key name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="credentialAllowlist"
          label="Restrict to credentials (optional)"
          extra="Leave empty to use the workspace's default credential per provider."
        >
          <Select
            mode="multiple"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Workspace default per provider"
            loading={credentials.isLoading}
            options={credentialOptions}
          />
        </Form.Item>
        <Form.Item name="rpmLimit" label="Rate limit (requests/minute, optional)">
          <InputNumber min={1} style={{ width: "100%" }} placeholder="No limit" />
        </Form.Item>
        <Form.Item name="expiresAt" label="Expires (optional)">
          <DatePicker showTime style={{ width: "100%" }} placeholder="Never" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={update.isPending} block>
          Save changes
        </Button>
      </Form>
    </Modal>
  );
}
