import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Form, Input, Modal, Popconfirm, Table, Tag, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router-dom";
import dayjs from "dayjs";
import { wsApi, type Team } from "../../api/endpoints.js";

export function TeamsPage() {
  const { ws = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: [ws, "teams"], queryFn: () => wsApi.teams(ws) });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const create = useMutation({
    mutationFn: (body: { name: string; description?: string }) => wsApi.createTeam(ws, body),
    onSuccess: (team) => {
      void queryClient.invalidateQueries({ queryKey: [ws, "teams"] });
      form.resetFields();
      setOpen(false);
      navigate(`/${ws}/teams/${team.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => wsApi.deleteTeam(ws, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [ws, "teams"] }),
  });

  return (
    <Card
      title="Teams"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          New team
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        Teams group projects for cost attribution — see who consumes budget by team in Analytics.
      </Typography.Paragraph>
      <Table<Team>
        rowKey="id"
        loading={teams.isLoading}
        dataSource={teams.data?.data ?? []}
        columns={[
          {
            title: "Name", dataIndex: "name",
            render: (name: string, t) => <Link to={`/${ws}/teams/${t.id}`}>{name}</Link>,
          },
          { title: "Description", dataIndex: "description" },
          { title: "Members", dataIndex: "memberCount", align: "right", render: (n: number) => <Tag>{n}</Tag> },
          { title: "Projects", dataIndex: "projectCount", align: "right", render: (n: number) => <Tag>{n}</Tag> },
          { title: "Created", dataIndex: "createdAt", render: (v: string) => dayjs(v).format("MMM D, YYYY") },
          {
            title: "",
            render: (_, team) => (
              <Popconfirm
                title="Delete this team?"
                description="Projects keep their history but lose their team owner."
                onConfirm={() => remove.mutate(team.id)}
              >
                <Button danger size="small">Delete</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Modal title="New team" open={open} onCancel={() => setOpen(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={(v: { name: string; description?: string }) => create.mutate(v)}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="Platform" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>
            Create team
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}
