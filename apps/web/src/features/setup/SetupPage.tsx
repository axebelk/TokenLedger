import { useState } from "react";
import { Alert, Card, Segmented, Space, Tag, Typography } from "antd";
import { ApiOutlined } from "@ant-design/icons";
import { Link, useParams } from "react-router-dom";
import { CopyField } from "../../components/CopyField.js";

const KEY = "tt_live_YOUR_KEY";

/** Connect-your-agent guide: shows the gateway base URL + SDK snippets so a
 *  developer can route any AI SDK through TokenTrail. */
export function SetupPage() {
  const { ws = "" } = useParams();
  const origin = window.location.origin;
  const [tab, setTab] = useState("Anthropic");

  const snippets: Record<string, { lang: string; code: string; note?: string }> = {
    Anthropic: {
      lang: "bash",
      code: [
        "# Set two env vars — no code changes to your app.",
        `export ANTHROPIC_BASE_URL=${origin}/gw/anthropic`,
        `export ANTHROPIC_API_KEY=${KEY}`,
      ].join("\n"),
    },
    OpenAI: {
      lang: "bash",
      code: [
        `export OPENAI_BASE_URL=${origin}/gw/openai/v1`,
        `export OPENAI_API_KEY=${KEY}`,
      ].join("\n"),
    },
    "OpenAI-compatible": {
      lang: "bash",
      note: "DeepSeek, OpenRouter, Minimax and Ollama all speak the OpenAI API. Point the OpenAI SDK at their gateway route.",
      code: [
        `# DeepSeek`,
        `export OPENAI_BASE_URL=${origin}/gw/deepseek/v1`,
        `# OpenRouter`,
        `export OPENAI_BASE_URL=${origin}/gw/openrouter/api/v1`,
        `# Ollama`,
        `export OPENAI_BASE_URL=${origin}/gw/ollama/v1`,
        ``,
        `export OPENAI_API_KEY=${KEY}`,
      ].join("\n"),
    },
    Unified: {
      lang: "bash",
      note: "One endpoint for every provider — put the provider in the model name.",
      code: [
        `curl ${origin}/gw/v1/chat/completions \\`,
        `  -H "Authorization: Bearer ${KEY}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `    "model": "anthropic/claude-sonnet-4-5",`,
        `    "messages": [{"role": "user", "content": "Hello"}]`,
        `  }'`,
      ].join("\n"),
    },
    cURL: {
      lang: "bash",
      code: [
        `curl ${origin}/gw/anthropic/v1/messages \\`,
        `  -H "x-api-key: ${KEY}" \\`,
        `  -H "anthropic-version: 2023-06-01" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '{`,
        `    "model": "claude-sonnet-4-5",`,
        `    "max_tokens": 128,`,
        `    "messages": [{"role": "user", "content": "Hello"}]`,
        `  }'`,
      ].join("\n"),
    },
  };

  const current = snippets[tab]!;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <Card>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          <ApiOutlined /> Connect your agent
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 720 }}>
          Point any AI SDK at TokenTrail instead of the provider. Change a base URL and use a{" "}
          virtual key — every request is then attributed, priced, and shown in your dashboard.
          Your real provider keys never leave the server.
        </Typography.Paragraph>

        <Space direction="vertical" style={{ width: "100%", maxWidth: 720 }} size="middle">
          <div>
            <Typography.Text strong>Step 1 — Your gateway URL</Typography.Text>
            <CopyField value={`${origin}/gw`} />
          </div>
          <div>
            <Typography.Text strong>Step 2 — Get a virtual key</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ margin: "4px 0 8px" }}>
              Issue one on the <Link to={`/${ws}/keys`}>Virtual Keys</Link> page (assign it to the
              right member), then paste it below in place of <Typography.Text code>{KEY}</Typography.Text>.
            </Typography.Paragraph>
          </div>
          <div>
            <Typography.Text strong>Step 3 — Wire up your SDK</Typography.Text>
          </div>
        </Space>
      </Card>

      <Card
        title={
          <Segmented
            options={Object.keys(snippets)}
            value={tab}
            onChange={(v) => setTab(String(v))}
          />
        }
      >
        {current.note && <Alert type="info" showIcon message={current.note} style={{ marginBottom: 12 }} />}
        <pre
          style={{
            background: "#0f1115", color: "#e6e6e6", padding: 16, borderRadius: 8,
            fontSize: 13, overflowX: "auto", margin: 0,
          }}
        >
          {current.code}
        </pre>
      </Card>

      <Card size="small">
        <Space wrap>
          <Tag color="blue">Native routes</Tag>
          <Typography.Text type="secondary">
            /gw/anthropic · /gw/openai · /gw/gemini · /gw/minimax · /gw/openrouter · /gw/deepseek · /gw/ollama
          </Typography.Text>
        </Space>
        <br />
        <Space wrap style={{ marginTop: 8 }}>
          <Tag color="purple">Unified</Tag>
          <Typography.Text type="secondary">
            POST /gw/v1/chat/completions with model "&lt;provider&gt;/&lt;model&gt;"
          </Typography.Text>
        </Space>
      </Card>
    </Space>
  );
}
