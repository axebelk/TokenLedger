import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Card, Form, Input, Layout, Result, Spin, Typography } from "antd";
import { inviteApi } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import { useAuth } from "../../providers/auth-context.js";

export function AcceptInvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const { status, reloadMemberships } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => inviteApi.inspect(token),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: (body: { name?: string; password?: string }) => inviteApi.accept(token, body),
    onSuccess: async (result) => {
      if (status === "authenticated") {
        await reloadMemberships();
        navigate(`/${result.workspace.slug}`);
      } else {
        navigate(`/login?next=/${result.workspace.slug}`);
      }
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not accept invitation"),
  });

  return (
    <Layout style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Card style={{ width: 420 }}>
        {invite.isLoading && <Spin style={{ display: "block" }} />}
        {invite.isError && (
          <Result
            status="warning"
            title="Invitation not valid"
            subTitle="This invitation link is invalid, expired, or already used."
          />
        )}
        {invite.data && (
          <>
            <Typography.Title level={4} style={{ marginTop: 0 }}>
              Join {invite.data.workspace.name}
            </Typography.Title>
            <Typography.Paragraph type="secondary">
              You've been invited as <b>{invite.data.role}</b> ({invite.data.email}).
            </Typography.Paragraph>
            {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
            {invite.data.accountExists ? (
              <Button
                type="primary"
                block
                loading={accept.isPending}
                onClick={() => accept.mutate({})}
              >
                Accept invitation
              </Button>
            ) : (
              <Form
                layout="vertical"
                onFinish={(values: { name: string; password: string }) => accept.mutate(values)}
              >
                <Form.Item name="name" label="Your name" rules={[{ required: true }]}>
                  <Input autoComplete="name" />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="Choose a password"
                  rules={[{ required: true, min: 8 }]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={accept.isPending}>
                  Create account & join
                </Button>
              </Form>
            )}
          </>
        )}
      </Card>
    </Layout>
  );
}
