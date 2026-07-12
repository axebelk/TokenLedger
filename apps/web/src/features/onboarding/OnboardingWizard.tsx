import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Button, Card, Form, Input, Result, Select, Space, Spin, Steps, Typography,
} from "antd";
import { CheckCircleTwoTone } from "@ant-design/icons";
import {
  ACTIVE_PROVIDERS, wsApi, type Provider, type VirtualKey,
} from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import { CopyField } from "../../components/CopyField.js";

/**
 * First-run wizard: provider credential → project → virtual key → first
 * request. Shown by the dashboard while the workspace is empty (J1 journey —
 * docs/01 §5).
 */
export function OnboardingWizard({ ws, initialStep }: { ws: string; initialStep: number }) {
  const [step, setStep] = useState(initialStep);
  const [issued, setIssued] = useState<(VirtualKey & { key: string }) | null>(null);

  return (
    <Card>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Get your first request tracked
      </Typography.Title>
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 32 }}
        items={[
          { title: "Connect a provider" },
          { title: "Create a project" },
          { title: "Issue a key" },
          { title: "First request" },
        ]}
      />
      {step === 0 && <CredentialStep ws={ws} onDone={() => setStep(1)} />}
      {step === 1 && <ProjectStep ws={ws} onDone={() => setStep(2)} />}
      {step === 2 && (
        <KeyStep
          ws={ws}
          onDone={(key) => {
            setIssued(key);
            setStep(3);
          }}
        />
      )}
      {step === 3 && <FirstRequestStep ws={ws} issued={issued} />}
    </Card>
  );
}

function useApiErrorText() {
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    wrap: <T,>(promise: Promise<T>): Promise<T> => {
      setError(null);
      return promise.catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Something went wrong");
        throw err;
      });
    },
  };
}

function CredentialStep({ ws, onDone }: { ws: string; onDone: () => void }) {
  const { error, wrap } = useApiErrorText();
  const [provider, setProvider] = useState<Provider>("ANTHROPIC");
  const mutation = useMutation({
    mutationFn: (values: { name: string; secret?: string; baseUrl?: string }) =>
      wrap(wsApi.createCredential(ws, { provider, isDefault: true, ...values })),
    onSuccess: onDone,
  });

  return (
    <Space direction="vertical" style={{ width: "100%", maxWidth: 480 }}>
      {error && <Alert type="error" message={error} />}
      <Form
        layout="vertical"
        initialValues={{ name: "Default" }}
        onFinish={(values: { name: string; secret?: string; baseUrl?: string }) =>
          mutation.mutate(values)
        }
      >
        <Form.Item label="Provider" required>
          <Select
            value={provider}
            onChange={setProvider}
            options={ACTIVE_PROVIDERS.map((p) => ({ value: p, label: p }))}
          />
        </Form.Item>
        <Form.Item name="name" label="Credential name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        {provider === "OLLAMA" ? (
          <Form.Item
            name="baseUrl"
            label="Ollama base URL"
            rules={[{ required: true, type: "url" }]}
          >
            <Input placeholder="http://localhost:11434" />
          </Form.Item>
        ) : (
          <Form.Item name="secret" label="API key" rules={[{ required: true }]}>
            <Input.Password placeholder={provider === "ANTHROPIC" ? "sk-ant-…" : "sk-…"} />
          </Form.Item>
        )}
        <Button type="primary" htmlType="submit" loading={mutation.isPending}>
          Save credential
        </Button>
      </Form>
    </Space>
  );
}

function ProjectStep({ ws, onDone }: { ws: string; onDone: () => void }) {
  const { error, wrap } = useApiErrorText();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (values: { name: string }) => wrap(wsApi.createProject(ws, values)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws, "projects"] });
      onDone();
    },
  });

  return (
    <Space direction="vertical" style={{ width: "100%", maxWidth: 480 }}>
      {error && <Alert type="error" message={error} />}
      <Typography.Paragraph type="secondary">
        Projects are the unit of cost attribution — one per app, service, or experiment.
      </Typography.Paragraph>
      <Form layout="vertical" onFinish={(values: { name: string }) => mutation.mutate(values)}>
        <Form.Item name="name" label="Project name" rules={[{ required: true }]}>
          <Input placeholder="checkout-bot" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={mutation.isPending}>
          Create project
        </Button>
      </Form>
    </Space>
  );
}

function KeyStep({ ws, onDone }: { ws: string; onDone: (key: VirtualKey & { key: string }) => void }) {
  const { error, wrap } = useApiErrorText();
  const projects = useQuery({ queryKey: [ws, "projects"], queryFn: () => wsApi.projects(ws) });
  const mutation = useMutation({
    mutationFn: (values: { projectId: string; name: string }) => wrap(wsApi.issueKey(ws, values)),
    onSuccess: onDone,
  });

  if (projects.isLoading) return <Spin />;

  return (
    <Space direction="vertical" style={{ width: "100%", maxWidth: 480 }}>
      {error && <Alert type="error" message={error} />}
      <Form
        layout="vertical"
        initialValues={{ projectId: projects.data?.data[0]?.id, name: "dev key" }}
        onFinish={(values: { projectId: string; name: string }) => mutation.mutate(values)}
      >
        <Form.Item name="projectId" label="Project" rules={[{ required: true }]}>
          <Select
            options={(projects.data?.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
        </Form.Item>
        <Form.Item name="name" label="Key name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={mutation.isPending}>
          Issue key
        </Button>
      </Form>
    </Space>
  );
}

function FirstRequestStep({ ws, issued }: { ws: string; issued: (VirtualKey & { key: string }) | null }) {
  const events = useQuery({
    queryKey: [ws, "usage", "first-request-poll"],
    queryFn: () => wsApi.events(ws),
    refetchInterval: (query) => ((query.state.data?.data.length ?? 0) > 0 ? false : 3000),
  });
  const arrived = (events.data?.data.length ?? 0) > 0;
  const origin = window.location.origin;

  if (arrived) {
    return (
      <Result
        icon={<CheckCircleTwoTone twoToneColor="#52c41a" />}
        title="First request tracked!"
        subTitle="Your dashboard is live. Every request through the gateway is now attributed and priced."
        extra={
          <Button type="primary" onClick={() => window.location.reload()}>
            Open dashboard
          </Button>
        }
      />
    );
  }

  return (
    <Space direction="vertical" style={{ width: "100%", maxWidth: 640 }} size="large">
      {issued && (
        <Alert
          type="warning"
          message="Copy your key now — it will not be shown again."
          description={<CopyField value={issued.key} />}
        />
      )}
      <div>
        <Typography.Text strong>Point your SDK at the gateway:</Typography.Text>
        <pre style={{ background: "#f6f6f6", padding: 12, borderRadius: 6, fontSize: 12, overflowX: "auto" }}>
          {[
            `# Anthropic SDK`,
            `export ANTHROPIC_BASE_URL=${origin}/gw/anthropic`,
            `export ANTHROPIC_API_KEY=${issued?.key ?? "tt_live_…"}`,
            ``,
            `# OpenAI SDK`,
            `export OPENAI_BASE_URL=${origin}/gw/openai/v1`,
            `export OPENAI_API_KEY=${issued?.key ?? "tt_live_…"}`,
          ].join("\n")}
        </pre>
      </div>
      <Space>
        <Spin size="small" />
        <Typography.Text type="secondary">Waiting for your first request…</Typography.Text>
      </Space>
    </Space>
  );
}
