import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

export interface MockProvider {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/**
 * Minimal Anthropic-shaped upstream. Behavior is driven by the request body:
 *   { fail: true }    → 429 error JSON
 *   { stream: true }  → SSE with usage in message_start / message_delta
 *   otherwise         → JSON completion with a usage block
 */
export async function startMockProvider(): Promise<MockProvider> {
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        /* empty body */
      }

      if (parsed.fail === true) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "Slow down" } }));
        return;
      }

      const model = String(parsed.model ?? "claude-sonnet-4-5");

      if (parsed.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { model, usage: { input_tokens: 25, cache_read_input_tokens: 10 } },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello" },
          })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            usage: { output_tokens: 123 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ];
        for (const frame of frames) res.write(frame);
        res.end();
        return;
      }

      // Universal usage object: Anthropic, OpenAI and Ollama fields coexist so
      // one mock serves every adapter (each reads only its own fields).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_mock",
          type: "message",
          model,
          done: true,
          content: [{ type: "text", text: "Hello from mock" }],
          choices: [{ message: { role: "assistant", content: "Hello from mock" } }],
          prompt_eval_count: 1000,
          eval_count: 500,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            prompt_tokens: 1000,
            completion_tokens: 500,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
