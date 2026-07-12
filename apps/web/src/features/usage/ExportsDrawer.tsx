import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Empty, List, Space, Tag, Typography, message } from "antd";
import { DownloadOutlined, FileTextOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { downloadAuthed } from "../../api/client.js";
import { wsApi, type ExportJob } from "../../api/endpoints.js";

const STATUS_COLOR: Record<ExportJob["status"], string> = {
  PENDING: "default", RUNNING: "processing", DONE: "green", FAILED: "red",
};

export function ExportsDrawer({ ws, open, onClose }: { ws: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const exportsQuery = useQuery({
    queryKey: [ws, "exports"],
    queryFn: () => wsApi.exports(ws),
    enabled: open,
    // Poll while any job is still running so status + download appear live.
    refetchInterval: (q) =>
      (q.state.data?.data ?? []).some((j) => j.status === "PENDING" || j.status === "RUNNING") ? 2000 : false,
  });

  const create = useMutation({
    mutationFn: () => wsApi.createExport(ws, { kind: "usage_events" }),
    onSuccess: () => {
      void message.success("Export started");
      void queryClient.invalidateQueries({ queryKey: [ws, "exports"] });
    },
    onError: () => void message.error("Could not start export"),
  });

  return (
    <Drawer
      title="Usage event exports"
      open={open}
      onClose={onClose}
      width={460}
      extra={
        <Button type="primary" loading={create.isPending} onClick={() => create.mutate()}>
          New export
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        Exports run in the background and stream every matching usage event to a CSV file.
        Download links stay valid for 24 hours.
      </Typography.Paragraph>
      {(exportsQuery.data?.data.length ?? 0) === 0 ? (
        <Empty description="No exports yet" />
      ) : (
        <List<ExportJob>
          dataSource={exportsQuery.data?.data ?? []}
          renderItem={(job) => (
            <List.Item
              actions={[
                job.status === "DONE" ? (
                  <Button
                    key="dl"
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={() =>
                      downloadAuthed(
                        wsApi.exportDownloadUrl(ws, job.id),
                        `tokentrail-${ws}-usage-${dayjs(job.createdAt).format("YYYY-MM-DD_HHmmss")}.csv`,
                      ).catch(() => message.error("Download failed"))
                    }
                  >
                    Download
                  </Button>
                ) : null,
              ]}
            >
              <List.Item.Meta
                avatar={<FileTextOutlined style={{ fontSize: 20 }} />}
                title={
                  <Space>
                    <Tag color={STATUS_COLOR[job.status]}>{job.status}</Tag>
                    {job.rowCount != null && <span>{job.rowCount.toLocaleString()} rows</span>}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={0}>
                    <span>{dayjs(job.createdAt).format("MMM D, HH:mm:ss")}</span>
                    {job.status === "FAILED" && job.error && (
                      <Alert type="error" message={job.error} showIcon style={{ marginTop: 4 }} />
                    )}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Drawer>
  );
}
