import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { LinkOutlined, UserAddOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import { membersApi, type Invitation, type Member } from "../../api/endpoints.js";
import { useAuth } from "../../providers/auth-context.js";
import { ApiError } from "../../api/client.js";
import { CopyField } from "../../components/CopyField.js";
import { PageHeader } from "../../components/PageHeader.js";

const ROLE_COLORS: Record<string, string> = {
  OWNER: "gold", ADMIN: "geekblue", MEMBER: "default", VIEWER: "purple",
};

function mutationError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function MembersPage() {
  const { ws = "" } = useParams();
  const queryClient = useQueryClient();
  const auth = useAuth();
  // We only know roles per-workspace from the /auth/me memberships list — derive
  // whether the *current viewer* is an ADMIN here so the row actions can hide.
  const viewerRole =
    auth.memberships.find((m) => m.workspace.slug === ws)?.role ?? "VIEWER";
  const isViewerAdmin = viewerRole === "ADMIN" || viewerRole === "OWNER";
  const viewerUserId = auth.user?.id;

  const members = useQuery({ queryKey: [ws, "members"], queryFn: () => membersApi.list(ws) });
  const invitations = useQuery({
    queryKey: [ws, "invitations"],
    queryFn: () => membersApi.invitations(ws),
    retry: false, // non-admins get 403; don't hammer
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  // Link shown after re-issuing a share link for a pending invite.
  const [reissued, setReissued] = useState<{ email: string; url: string } | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => membersApi.revokeInvite(ws, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws, "invitations"] }),
  });

  // Re-issue a fresh link and copy it straight to the clipboard. If the browser
  // blocks the async clipboard write (lost user-gesture), fall back to a modal
  // with a manual copy field.
  const getLink = useMutation({
    mutationFn: (id: string) => membersApi.inviteLink(ws, id),
    onSuccess: async (res) => {
      try {
        await navigator.clipboard.writeText(res.acceptUrl);
        void message.success(`Invite link copied for ${res.email}`);
      } catch {
        setReissued({ email: res.email, url: res.acceptUrl });
      }
    },
    onError: () => void message.error("Couldn't generate invite link"),
  });

  const updateRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      membersApi.updateMember(ws, userId, { role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws, "members"] });
    },
    onError: (err) => void message.error(mutationError(err, "Couldn't update role")),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => membersApi.removeMember(ws, userId),
    onSuccess: () => {
      // If the viewer removed themselves from the current workspace, their
      // memberships list changes — reload it so the sidebar/redirects react.
      void queryClient.invalidateQueries({ queryKey: [ws, "members"] });
      return auth.reloadMemberships();
    },
    onError: (err) => void message.error(mutationError(err, "Couldn't remove member")),
  });

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <PageHeader
        eyebrow="Workspace"
        title="Members"
        extra={
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setInviteOpen(true)}>
            Invite
          </Button>
        }
      />
      <Card>
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
              render: (role: string, row) => {
                if (!isViewerAdmin || role === "OWNER" || row.id === viewerUserId) {
                  // Owners manage themselves via /transfer (Phase 2); for now, render-only.
                  return <Tag color={ROLE_COLORS[role] ?? "default"}>{role}</Tag>;
                }
                const editing = updateRole.isPending && updateRole.variables?.userId === row.id;
                return (
                  <Select
                    value={role}
                    loading={editing}
                    disabled={editing}
                    style={{ width: 140 }}
                    options={[
                      { value: "ADMIN", label: <Tag color="geekblue">ADMIN</Tag> },
                      { value: "MEMBER", label: <Tag>MEMBER</Tag> },
                      { value: "VIEWER", label: <Tag color="purple">VIEWER</Tag> },
                    ]}
                    onChange={(next) => updateRole.mutate({ userId: row.id, role: next })}
                  />
                );
              },
            },
            {
              title: "Joined", dataIndex: "joinedAt",
              render: (v: string) => dayjs(v).format("MMM D, YYYY"),
            },
            {
              title: "",
              key: "actions",
              align: "right",
              render: (_, row) => {
                // Allow self-leave for everyone; allow remove-other only for admins,
                // and never touch an OWNER (server enforces the last-OWNER rule).
                if (row.id !== viewerUserId && !isViewerAdmin) return null;
                if (row.role === "OWNER") {
                  return (
                    <Tooltip title="OWNER is permanent — transfer ownership to demote">
                      <Button size="small" disabled>Remove</Button>
                    </Tooltip>
                  );
                }
                const label = row.id === viewerUserId ? "Leave workspace" : "Remove";
                return (
                  <Popconfirm
                    title={
                      row.id === viewerUserId
                        ? "Leave this workspace?"
                        : `Remove ${row.name} from the workspace?`
                    }
                    description={
                      row.id === viewerUserId
                        ? "You'll need a fresh invite to rejoin."
                        : "Their projects and keys remain; they just lose access."
                    }
                    okText="Confirm"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => removeMember.mutate(row.id)}
                  >
                    <Button danger size="small" loading={removeMember.isPending && removeMember.variables === row.id}>
                      {label}
                    </Button>
                  </Popconfirm>
                );
              },
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
                align: "right",
                render: (_, invite) => (
                  <Space>
                    <Button
                      size="small"
                      icon={<LinkOutlined />}
                      loading={getLink.isPending && getLink.variables === invite.id}
                      onClick={() => getLink.mutate(invite.id)}
                    >
                      Copy invite link
                    </Button>
                    <Popconfirm title="Revoke this invitation?" onConfirm={() => revoke.mutate(invite.id)}>
                      <Button danger size="small">Revoke</Button>
                    </Popconfirm>
                  </Space>
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
          // Keep the modal open so the copyable link stays visible; the modal's
          // own Done / Invite-another buttons handle closing.
          void queryClient.invalidateQueries({ queryKey: [ws, "invitations"] });
        }}
      />

      <Modal
        title="Invitation link"
        open={reissued !== null}
        onCancel={() => setReissued(null)}
        footer={<Button onClick={() => setReissued(null)}>Done</Button>}
      >
        {reissued && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message={`Fresh link for ${reissued.email}`}
              description="A new link was generated — any previously shared link for this invite no longer works. Valid for the remainder of the 7-day window."
            />
            <CopyField value={reissued.url} />
          </Space>
        )}
      </Modal>
    </Space>
  );
}

function InviteModal({
  ws, open, onClose, onInvited,
}: { ws: string; open: boolean; onClose: () => void; onInvited: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [form] = Form.useForm();
  const invite = useMutation({
    mutationFn: (values: { email: string; role: string }) => membersApi.invite(ws, values),
    onSuccess: (created, values) => {
      form.resetFields();
      setError(null);
      setLink({ email: values.email, url: created.acceptUrl });
      onInvited();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to send invite"),
  });

  const close = () => {
    setLink(null);
    setError(null);
    onClose();
  };

  return (
    <Modal title="Invite a teammate" open={open} onCancel={close} footer={null}>
      {link ? (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="success"
            message={`Invitation created for ${link.email}`}
            description="Share this link with them — it works even without email, and is valid for 7 days."
          />
          <CopyField value={link.url} />
          <Button type="primary" block onClick={() => setLink(null)}>
            Invite another
          </Button>
          <Button block onClick={close}>Done</Button>
        </Space>
      ) : (
        <>
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
            An email is sent if SMTP is configured; either way you'll get a copyable invite link next.
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  );
}
