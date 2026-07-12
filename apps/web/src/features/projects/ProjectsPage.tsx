import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Form, Input, Modal, Popconfirm, Segmented, Space, Table, Tag, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import { wsApi, type Project } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";

export function ProjectsPage() {
  const { ws = "" } = useParams();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"ACTIVE" | "ARCHIVED">("ACTIVE");
  const projects = useQuery({
    queryKey: [ws, "projects", status],
    queryFn: () => wsApi.projectsByStatus(ws, status),
  });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [ws, "projects"] });

  const create = useMutation({
    mutationFn: (values: { name: string; description?: string }) => wsApi.createProject(ws, values),
    onSuccess: () => { void invalidate(); form.resetFields(); setOpen(false); },
  });
  const setProjectStatus = useMutation({
    mutationFn: (v: { id: string; status: "ACTIVE" | "ARCHIVED" }) =>
      wsApi.updateProject(ws, v.id, { status: v.status }),
    onSuccess: () => { void message.success("Updated"); void invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => wsApi.deleteProject(ws, id),
    onSuccess: () => { void message.success("Project deleted"); void invalidate(); },
    onError: (err) => void message.error(err instanceof ApiError ? err.message : "Delete failed"),
  });

  return (
    <Card
      title="Projects"
      extra={
        <Space>
          <Segmented
            options={[{ label: "Active", value: "ACTIVE" }, { label: "Archived", value: "ARCHIVED" }]}
            value={status}
            onChange={(v) => setStatus(v as "ACTIVE" | "ARCHIVED")}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            New project
          </Button>
        </Space>
      }
    >
      <Table<Project>
        rowKey="id"
        loading={projects.isLoading}
        dataSource={projects.data?.data ?? []}
        columns={[
          { title: "Name", dataIndex: "name" },
          { title: "Slug", dataIndex: "slug", render: (v: string) => <Tag>{v}</Tag> },
          { title: "Description", dataIndex: "description" },
          {
            title: "Created", dataIndex: "createdAt",
            render: (v: string) => dayjs(v).format("MMM D, YYYY"),
          },
          {
            title: "",
            width: 220,
            render: (_, project) => (
              <Space>
                {project.status === "ACTIVE" ? (
                  <Popconfirm
                    title="Archive this project?"
                    description="Its keys stop being usable and it's hidden from active views. History is kept."
                    onConfirm={() => setProjectStatus.mutate({ id: project.id, status: "ARCHIVED" })}
                  >
                    <Button size="small">Archive</Button>
                  </Popconfirm>
                ) : (
                  <Button size="small" onClick={() => setProjectStatus.mutate({ id: project.id, status: "ACTIVE" })}>
                    Unarchive
                  </Button>
                )}
                <Popconfirm
                  title="Delete this project?"
                  description="Only possible if it has no recorded usage. Otherwise archive it."
                  onConfirm={() => remove.mutate(project.id)}
                >
                  <Button size="small" danger>Delete</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title="New project" open={open} onCancel={() => setOpen(false)} footer={null}>
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: { name: string; description?: string }) => create.mutate(values)}
        >
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="checkout-bot" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>
            Create
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}
