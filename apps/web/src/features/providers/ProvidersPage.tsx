import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Drawer, Form, Input, Popconfirm, Select, Space, Table, Tag, message,
} from "antd";
import { EditOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import {
  ACTIVE_PROVIDERS, ALL_PROVIDERS, wsApi, type Credential, type Provider,
} from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";

export function ProvidersPage() {
  const { ws = "" } = useParams();
  const queryClient = useQueryClient();
  const credentials = useQuery({ queryKey: [ws, "credentials"], queryFn: () => wsApi.credentials(ws) });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [ws, "credentials"] });

  const test = useMutation({
    mutationFn: (id: string) => wsApi.testCredential(ws, id),
    onSuccess: (result) => {
      if (result.ok === true) void message.success("Connection OK");
      else if (result.ok === false) void message.error(result.message ?? `Failed (${result.httpStatus})`);
      else void message.info(result.message ?? "No live probe for this provider yet");
    },
  });
  const toggle = useMutation({
    mutationFn: (c: Credential) =>
      wsApi.updateCredential(ws, c.id, { status: c.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => wsApi.deleteCredential(ws, id),
    onSuccess: () => { void message.success("Credential deleted"); void invalidate(); },
    onError: (err) => void message.error(err instanceof ApiError ? err.message : "Delete failed"),
  });

  return (
    <Card
      title="Provider credentials"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          Add credential
        </Button>
      }
    >
      <Table<Credential>
        rowKey="id"
        loading={credentials.isLoading}
        dataSource={credentials.data?.data ?? []}
        columns={[
          {
            title: "Provider", dataIndex: "provider",
            render: (p: Provider) => (
              <Space>
                <Tag color="blue">{p}</Tag>
                {!ACTIVE_PROVIDERS.includes(p) && <Tag color="orange">gateway support in Phase 2</Tag>}
              </Space>
            ),
          },
          { title: "Name", dataIndex: "name" },
          {
            title: "Secret", dataIndex: "secretLast4",
            render: (v: string | null) => (v ? `••••${v}` : "—"),
          },
          { title: "Base URL", dataIndex: "baseUrl", render: (v: string | null) => v ?? "—" },
          {
            title: "Status", dataIndex: "status",
            render: (status: string, c) => (
              <Space>
                <Tag color={status === "ACTIVE" ? "green" : "default"}>{status}</Tag>
                {c.isDefault && <Tag color="blue">default</Tag>}
              </Space>
            ),
          },
          {
            title: "",
            width: 260,
            render: (_, credential) => (
              <Space>
                <Button
                  size="small"
                  icon={<ThunderboltOutlined />}
                  loading={test.isPending && test.variables === credential.id}
                  onClick={() => test.mutate(credential.id)}
                >
                  Test
                </Button>
                <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(credential)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  loading={toggle.isPending && toggle.variables?.id === credential.id}
                  onClick={() => toggle.mutate(credential)}
                >
                  {credential.status === "ACTIVE" ? "Disable" : "Enable"}
                </Button>
                <Popconfirm
                  title="Delete this credential?"
                  description="Historical usage is kept. The provider key is removed from the vault."
                  onConfirm={() => remove.mutate(credential.id)}
                >
                  <Button size="small" danger>Delete</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <AddCredentialDrawer ws={ws} open={open} onClose={() => setOpen(false)} onSaved={() => {
        void queryClient.invalidateQueries({ queryKey: [ws, "credentials"] });
        setOpen(false);
      }} />
      <EditCredentialDrawer
        ws={ws}
        credential={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void invalidate();
          setEditing(null);
        }}
      />
    </Card>
  );
}

function AddCredentialDrawer({
  ws, open, onClose, onSaved,
}: { ws: string; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState<Provider>("ANTHROPIC");
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  const create = useMutation({
    mutationFn: (values: { name: string; secret?: string; baseUrl?: string }) =>
      wsApi.createCredential(ws, { provider, ...values }),
    onSuccess: () => {
      form.resetFields();
      setError(null);
      onSaved();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to save"),
  });

  return (
    <Drawer title="Add provider credential" open={open} onClose={onClose} width={420}>
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ name: "Default" }}
        onFinish={(values: { name: string; secret?: string; baseUrl?: string }) => create.mutate(values)}
      >
        <Form.Item label="Provider" required>
          <Select
            value={provider}
            onChange={setProvider}
            options={ALL_PROVIDERS.map((p) => ({
              value: p,
              label: ACTIVE_PROVIDERS.includes(p) ? p : `${p} (Phase 2)`,
            }))}
          />
        </Form.Item>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        {provider === "OLLAMA" ? (
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, type: "url" }]}>
            <Input placeholder="http://localhost:11434" />
          </Form.Item>
        ) : (
          <>
            <Form.Item name="secret" label="API key" rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item name="baseUrl" label="Base URL override (optional)" rules={[{ type: "url" }]}>
              <Input />
            </Form.Item>
          </>
        )}
        <Button type="primary" htmlType="submit" loading={create.isPending} block>
          Save
        </Button>
      </Form>
    </Drawer>
  );
}

function EditCredentialDrawer({
  ws, credential, onClose, onSaved,
}: { ws: string; credential: Credential | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  // Re-seed the form whenever a different credential is opened for editing.
  useEffect(() => {
    if (credential) {
      form.setFieldsValue({ name: credential.name, baseUrl: credential.baseUrl ?? undefined, secret: undefined });
      setError(null);
    }
  }, [credential, form]);

  const update = useMutation({
    mutationFn: (values: { name: string; secret?: string; baseUrl?: string }) =>
      wsApi.updateCredential(ws, credential!.id, {
        name: values.name,
        ...(values.baseUrl ? { baseUrl: values.baseUrl } : credential!.provider === "OLLAMA" ? {} : { baseUrl: null }),
        ...(values.secret ? { secret: values.secret } : {}),
      }),
    onSuccess: () => {
      form.resetFields();
      setError(null);
      onSaved();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to save"),
  });

  if (!credential) return null;

  return (
    <Drawer title={`Edit ${credential.provider} credential`} open={credential !== null} onClose={onClose} width={420}>
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Form
        form={form}
        layout="vertical"
        onFinish={(values: { name: string; secret?: string; baseUrl?: string }) => update.mutate(values)}
      >
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        {credential.provider === "OLLAMA" ? (
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, type: "url" }]}>
            <Input placeholder="http://localhost:11434" />
          </Form.Item>
        ) : (
          <>
            <Form.Item
              name="secret"
              label="API key"
              extra={`Leave blank to keep the current key (••••${credential.secretLast4 ?? "????"})`}
            >
              <Input.Password placeholder="Enter a new key to rotate it" />
            </Form.Item>
            <Form.Item name="baseUrl" label="Base URL override (optional)" rules={[{ type: "url" }]}>
              <Input />
            </Form.Item>
          </>
        )}
        <Button type="primary" htmlType="submit" loading={update.isPending} block>
          Save changes
        </Button>
      </Form>
    </Drawer>
  );
}
