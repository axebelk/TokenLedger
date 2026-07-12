import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import { ALL_PROVIDERS, membersApi, wsApi, type Provider, type VirtualKey } from "../../api/endpoints.js";
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
                <Popconfirm
                  title="Revoke this key?"
                  description="Requests using it will fail within 5 seconds."
                  onConfirm={() => revoke.mutate(key.id)}
                >
                  <Button danger size="small">Revoke</Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      <IssueKeyModal ws={ws} open={issueOpen} onClose={() => setIssueOpen(false)} />
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
  // Only offer providers that are actually configured (have an active credential).
  const configuredProviders = [
    ...new Set((credentials.data?.data ?? []).filter((c) => c.status === "ACTIVE").map((c) => c.provider)),
  ];
  const providerOptions = configuredProviders.length > 0 ? configuredProviders : ALL_PROVIDERS;
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [form] = Form.useForm();

  const issue = useMutation({
    mutationFn: (values: { projectId: string; name: string; userId?: string; providerAllowlist?: Provider[] }) =>
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
            name="providerAllowlist"
            label="Restrict to providers (optional)"
            extra="Leave empty to allow every configured provider; otherwise the key only works for the selected ones."
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="All configured providers"
              options={providerOptions.map((p) => ({ value: p, label: p }))}
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
