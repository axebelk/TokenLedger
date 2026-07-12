import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, Button, Card, Form, Input, Layout, Typography } from "antd";
import { useAuth } from "../../providers/auth-context.js";
import { ApiError } from "../../api/client.js";

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Layout className="tt-auth">
      <div className="tt-auth__panel">
        <div className="tt-auth__head">
          <div className="tt-auth__brand">
            <span className="tt-auth__brand-mark" />
            TokenTrail
          </div>
          <div className="tt-auth__sub">AI cost governance &amp; usage analytics</div>
        </div>
        <Card className="tt-auth__card">
          <Typography.Text type="secondary" className="tt-eyebrow">
            {title}
          </Typography.Text>
          <div className="tt-auth__form">{children}</div>
        </Card>
      </div>
    </Layout>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthShell title="Sign in to your workspace">
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Form
        layout="vertical"
        onFinish={async (values: { email: string; password: string }) => {
          setBusy(true);
          setError(null);
          try {
            await login(values.email, values.password);
            navigate("/");
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Login failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
          <Input autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="Password" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>
          Sign in
        </Button>
      </Form>
      <Typography.Paragraph style={{ marginTop: 16, textAlign: "center" }}>
        New here? <Link to="/register">Create an account</Link>
      </Typography.Paragraph>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthShell title="Create your account and workspace">
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Form
        layout="vertical"
        onFinish={async (values: { name: string; email: string; password: string; workspaceName?: string }) => {
          setBusy(true);
          setError(null);
          try {
            const slug = await register(values);
            navigate(`/${slug}`);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Registration failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form.Item name="name" label="Your name" rules={[{ required: true }]}>
          <Input autoComplete="name" />
        </Form.Item>
        <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
          <Input autoComplete="email" />
        </Form.Item>
        <Form.Item
          name="password"
          label="Password"
          rules={[{ required: true, min: 8, message: "At least 8 characters" }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="workspaceName" label="Workspace name (optional)">
          <Input placeholder="Acme Engineering" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>
          Create account
        </Button>
      </Form>
      <Typography.Paragraph style={{ marginTop: 16, textAlign: "center" }}>
        Already registered? <Link to="/login">Sign in</Link>
      </Typography.Paragraph>
    </AuthShell>
  );
}
