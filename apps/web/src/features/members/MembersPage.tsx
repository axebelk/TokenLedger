import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography,
} from "antd";
import { UserAddOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import { membersApi, type Invitation, type Member } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";

const ROLE_COLORS: Record<string, string> = {
  OWNER: "gold", ADMIN: "geekblue", MEMBER: "default", VIEWER: "purple",
};

export function MembersPage() {
  const { ws = "" } = useParams();
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: [ws, "members"], queryFn: () => membersApi.list(ws) });
  const invitations = useQuery({
    queryKey: [ws, "invitations"],
    queryFn: () => membersApi.invitations(ws),
    retry: false, // non-admins get 403; don't hammer
  });
  const [inviteOpen, setInviteOpen] = useState(false);

  const revoke = useMutation({
    mutationFn: (id: string) => membersApi.revokeInvite(ws, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws, "invitations"] }),
  });

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <Card
        title="Members"
        extra={
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setInviteOpen(true)}>
            Invite
          </Button>
        }
      >
        <Table<Member>
          rowKey="id"
          loading={members.isLoading}
          dataSource={members.data?.data ?? []}
          pagination={false}
          columns={[
            { title: "Name", dataIndex: "name" },
            { title: "Email", dataIndex: "email" },
            {
              title: "Role", dataIndex: "role",
              render: (role: string) => <Tag color={ROLE_COLORS[role] ?? "default"}>{role}</Tag>,
            },
            {
              title: "Joined", dataIndex: "joinedAt",
              render: (v: string) => dayjs(v).format("MMM D, YYYY"),
            },
          ]}
        />
      </Card>

      {(invitations.data?.data.length ?? 0) > 0 && (
        <Card title="Pending invitations">
          <Table<Invitation>
            rowKey="id"
            dataSource={invitations.data?.data ?? []}
            pagination={false}
            columns={[
              { title: "Email", dataIndex: "email" },
              { title: "Role", dataIndex: "role", render: (r: string) => <Tag>{r}</Tag> },
              {
                title: "Expires", dataIndex: "expiresAt",
                render: (v: string) => dayjs(v).format("MMM D, YYYY"),
              },
              {
                title: "",
                render: (_, invite) => (
                  <Popconfirm title="Revoke this invitation?" onConfirm={() => revoke.mutate(invite.id)}>
                    <Button danger size="small">Revoke</Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      )}

      <InviteModal
        ws={ws}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => {
          void queryClient.invalidateQueries({ queryKey: [ws, "invitations"] });
          setInviteOpen(false);
        }}
      />
    </Space>
  );
}

function InviteModal({
  ws, open, onClose, onInvited,
}: { ws: string; open: boolean; onClose: () => void; onInvited: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();
  const invite = useMutation({
    mutationFn: (values: { email: string; role: string }) => membersApi.invite(ws, values),
    onSuccess: () => {
      form.resetFields();
      setError(null);
      onInvited();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to send invite"),
  });

  return (
    <Modal title="Invite a teammate" open={open} onCancel={onClose} footer={null}>
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ role: "MEMBER" }}
        onFinish={(values: { email: string; role: string }) => invite.mutate(values)}
      >
        <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
          <Input placeholder="teammate@company.com" />
        </Form.Item>
        <Form.Item name="role" label="Role" rules={[{ required: true }]}>
          <Select
            options={[
              { value: "ADMIN", label: "Admin — manage everything but billing" },
              { value: "MEMBER", label: "Member — issue keys, see own usage" },
              { value: "VIEWER", label: "Viewer — read-only analytics" },
            ]}
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={invite.isPending} block>
          Send invitation
        </Button>
      </Form>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
        They'll receive an email with an accept link, valid for 7 days.
      </Typography.Paragraph>
    </Modal>
  );
}
