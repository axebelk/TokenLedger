import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Input, Table } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { adminApi, formatUsd, type PlatformWorkspace } from "../../api/endpoints.js";
import { PageHeader } from "../../components/PageHeader.js";

/** Every workspace (tenant) on this deployment, searchable. */
export function PlatformTenants() {
  const workspaces = useQuery({ queryKey: ["admin", "workspaces"], queryFn: () => adminApi.workspaces() });
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const all = workspaces.data?.data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((w) => w.name.toLowerCase().includes(needle) || w.slug.toLowerCase().includes(needle));
  }, [workspaces.data, q]);

  return (
    <div>
      <PageHeader
        eyebrow="Platform"
        title="Tenants"
        extra={
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Search tenants"
            style={{ width: 240 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        }
      />
      <Card>
        <Table<PlatformWorkspace>
          rowKey="id"
          loading={workspaces.isLoading}
          dataSource={rows}
          columns={[
            {
              title: "Workspace", dataIndex: "name",
              render: (name: string, w) => <Link to={`/${w.slug}`}>{name}</Link>,
            },
            { title: "Slug", dataIndex: "slug" },
            { title: "Members", dataIndex: "members", align: "right" },
            { title: "Projects", dataIndex: "projects", align: "right" },
            {
              title: "Requests (30d)", dataIndex: "requests30d", align: "right",
              sorter: (a, b) => a.requests30d - b.requests30d,
              render: (v: number) => v.toLocaleString(),
            },
            {
              title: "Spend (30d)", dataIndex: "costUsd30d", align: "right",
              defaultSortOrder: "descend",
              sorter: (a, b) => Number(a.costUsd30d) - Number(b.costUsd30d),
              render: (v: string) => formatUsd(v),
            },
            { title: "Created", dataIndex: "createdAt", render: (v: string) => dayjs(v).format("MMM D, YYYY") },
          ]}
        />
      </Card>
    </div>
  );
}
