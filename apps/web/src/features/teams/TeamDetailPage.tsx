import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Breadcrumb, Button, Card, Col, Empty, Popconfirm, Row, Select, Space, Spin, Table, Tag, Typography, message,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router-dom";
import { membersApi } from "../../api/endpoints.js";
import { wsApi, type TeamMemberRow } from "../../api/endpoints.js";

export function TeamDetailPage() {
  const { ws = "", teamId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Refresh the detail view AND the Teams list (its member/project counts).
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [ws, "team", teamId] });
    void queryClient.invalidateQueries({ queryKey: [ws, "teams"] });
  };

  const team = useQuery({ queryKey: [ws, "team", teamId], queryFn: () => wsApi.team(ws, teamId) });
  const wsMembers = useQuery({ queryKey: [ws, "members"], queryFn: () => membersApi.list(ws) });
  const projects = useQuery({ queryKey: [ws, "projects"], queryFn: () => wsApi.projects(ws) });

  const [addUserId, setAddUserId] = useState<string | undefined>();
  const [assignId, setAssignId] = useState<string | undefined>();

  const addMember = useMutation({
    mutationFn: (userId: string) => wsApi.addTeamMember(ws, teamId, { userId, role: "MEMBER" }),
    onSuccess: () => { setAddUserId(undefined); void invalidate(); },
    onError: () => void message.error("Could not add member"),
  });
  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: string }) => wsApi.updateTeamMember(ws, teamId, v.userId, v.role),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => wsApi.removeTeamMember(ws, teamId, userId),
    onSuccess: invalidate,
  });
  const assignProject = useMutation({
    mutationFn: (projectId: string) => wsApi.updateProject(ws, projectId, { teamId }),
    onSuccess: () => {
      setAssignId(undefined);
      void queryClient.invalidateQueries({ queryKey: [ws, "projects"] });
      void invalidate();
    },
  });
  const detachProject = useMutation({
    mutationFn: (projectId: string) => wsApi.updateProject(ws, projectId, { teamId: null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ws, "projects"] });
      void invalidate();
    },
  });

  const memberIds = useMemo(() => new Set((team.data?.members ?? []).map((m) => m.id)), [team.data]);
  const addableUsers = (wsMembers.data?.data ?? []).filter((m) => !memberIds.has(m.id));
  const ownedIds = useMemo(() => new Set((team.data?.projects ?? []).map((p) => p.id)), [team.data]);
  const assignableProjects = (projects.data?.data ?? []).filter((p) => !ownedIds.has(p.id) && p.status === "ACTIVE");

  if (team.isLoading) return <Spin style={{ display: "block", marginTop: 80 }} size="large" />;
  if (!team.data) return <Empty description="Team not found" />;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      <Breadcrumb
        items={[
          { title: <Link to={`/${ws}/teams`}>Teams</Link> },
          { title: team.data.name },
        ]}
      />
      <Typography.Title level={4} style={{ margin: 0 }}>
        {team.data.name}
      </Typography.Title>
      {team.data.description && <Typography.Text type="secondary">{team.data.description}</Typography.Text>}

      <Row gutter={16}>
        <Col xs={24} lg={14}>
          <Card
            title="Members"
            extra={
              <Space.Compact>
                <Select
                  style={{ width: 220 }}
                  placeholder="Add workspace member…"
                  value={addUserId}
                  onChange={setAddUserId}
                  showSearch
                  optionFilterProp="label"
                  options={addableUsers.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
                />
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={!addUserId}
                  loading={addMember.isPending}
                  onClick={() => addUserId && addMember.mutate(addUserId)}
                />
              </Space.Compact>
            }
          >
            <Table<TeamMemberRow>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={team.data.members}
              columns={[
                { title: "Name", dataIndex: "name" },
                { title: "Email", dataIndex: "email" },
                {
                  title: "Role", dataIndex: "role", width: 140,
                  render: (role: string, m) => (
                    <Select
                      size="small"
                      value={role}
                      style={{ width: 110 }}
                      onChange={(r) => changeRole.mutate({ userId: m.id, role: r })}
                      options={[
                        { value: "LEAD", label: <Tag color="gold">LEAD</Tag> },
                        { value: "MEMBER", label: <Tag>MEMBER</Tag> },
                      ]}
                    />
                  ),
                },
                {
                  title: "", width: 80,
                  render: (_, m) => (
                    <Popconfirm title="Remove from team?" onConfirm={() => removeMember.mutate(m.id)}>
                      <Button danger size="small" type="text">Remove</Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card
            title="Projects"
            extra={
              <Space.Compact>
                <Select
                  style={{ width: 180 }}
                  placeholder="Assign project…"
                  value={assignId}
                  onChange={setAssignId}
                  showSearch
                  optionFilterProp="label"
                  options={assignableProjects.map((p) => ({ value: p.id, label: p.name }))}
                  notFoundContent="No unassigned projects"
                />
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={!assignId}
                  loading={assignProject.isPending}
                  onClick={() => assignId && assignProject.mutate(assignId)}
                />
              </Space.Compact>
            }
          >
            {team.data.projects.length === 0 ? (
              <Empty description="No projects owned by this team" />
            ) : (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={team.data.projects}
                columns={[
                  { title: "Project", dataIndex: "name" },
                  {
                    title: "", width: 70,
                    render: (_, p) => (
                      <Button size="small" type="text" onClick={() => detachProject.mutate(p.id)}>
                        Detach
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
