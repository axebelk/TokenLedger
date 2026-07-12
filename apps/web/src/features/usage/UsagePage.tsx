import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Card, Space, Table, Tag, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import { formatUsd, wsApi, type UsageEvent } from "../../api/endpoints.js";
import { ExportsDrawer } from "./ExportsDrawer.js";

export function UsagePage() {
  const { ws = "" } = useParams();
  const [exportsOpen, setExportsOpen] = useState(false);
  const events = useInfiniteQuery({
    queryKey: [ws, "usage", "events"],
    queryFn: ({ pageParam }) => wsApi.events(ws, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });

  const rows = events.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Card
      title="Usage events"
      extra={
        <Space>
          <Typography.Text type="secondary">last 90 days · auto-refreshes</Typography.Text>
          <Button icon={<DownloadOutlined />} onClick={() => setExportsOpen(true)}>
            Export
          </Button>
        </Space>
      }
    >
      <Table<UsageEvent>
        rowKey="id"
        size="small"
        loading={events.isLoading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 900 }}
        columns={[
          {
            title: "Time", dataIndex: "occurredAt", width: 150,
            render: (v: string) => dayjs(v).format("MMM D, HH:mm:ss"),
          },
          { title: "Project", dataIndex: ["project", "name"], width: 140 },
          { title: "User", dataIndex: ["user", "name"], width: 120 },
          {
            title: "Model", dataIndex: "model",
            render: (model: string, e) => (
              <span>
                <Tag>{e.provider}</Tag>
                <Typography.Text code>{model}</Typography.Text>
                {e.streamed && <Tag color="blue">stream</Tag>}
              </span>
            ),
          },
          {
            title: "Status", dataIndex: "httpStatus", width: 90,
            render: (code: number, e) => (
              <Tag color={e.status === "OK" ? "green" : "red"}>{code}</Tag>
            ),
          },
          {
            title: "Tokens in/out", width: 120, align: "right",
            render: (_, e) => `${e.inputTokens} / ${e.outputTokens}`,
          },
          {
            title: "Latency", dataIndex: "latencyMs", width: 90, align: "right",
            render: (v: number) => `${v} ms`,
          },
          {
            title: "Cost", dataIndex: "costUsd", width: 110, align: "right",
            render: (v: string, e) => (
              <span>
                {formatUsd(v)}
                {e.costBasis !== "ACTUAL" && (
                  <Tag style={{ marginLeft: 4 }} color="orange">{e.costBasis.toLowerCase()}</Tag>
                )}
              </span>
            ),
          },
        ]}
      />
      {events.hasNextPage && (
        <Button
          style={{ marginTop: 16 }}
          loading={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      <ExportsDrawer ws={ws} open={exportsOpen} onClose={() => setExportsOpen(false)} />
    </Card>
  );
}
