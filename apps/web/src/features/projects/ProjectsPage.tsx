import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Form, Input, Modal, Table, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import dayjs from "dayjs";
import { wsApi, type Project } from "../../api/endpoints.js";

export function ProjectsPage() {
  const { ws = "" } = useParams();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: [ws, "projects"], queryFn: () => wsApi.projects(ws) });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const create = useMutation({
    mutationFn: (values: { name: string; description?: string }) => wsApi.createProject(ws, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws, "projects"] });
      form.resetFields();
      setOpen(false);
    },
  });

  return (
    <Card
      title="Projects"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          New project
        </Button>
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
