import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, hasMinimumRole } from "@tokentrail/shared";
import type { PrismaClient } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]{2,50}$/).optional(),
  description: z.string().max(500).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});

const memberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["LEAD", "MEMBER"]).default("MEMBER"),
});

interface TeamsModuleOptions {
  prisma: PrismaClient;
  authenticate: preHandlerHookHandler;
}

export function registerTeamsModule(app: FastifyInstance, opts: TeamsModuleOptions): void {
  const { prisma, authenticate } = opts;
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];
  const admin = [authenticate, makeWorkspaceGuard(prisma, "ADMIN")];

  /** Team management is allowed for workspace ADMINs and the team's own LEADs. */
  async function assertCanManageTeam(request: { wsCtx?: { workspaceId: string; role: string }; user?: { id: string } }, teamId: string) {
    if (hasMinimumRole(request.wsCtx!.role as never, "ADMIN")) return;
    const lead = await prisma.teamMember.findFirst({
      where: { teamId, userId: request.user!.id, role: "LEAD" },
    });
    if (!lead) throw new ForbiddenError("Only workspace admins or team leads can manage this team");
  }

  async function loadTeam(workspaceId: string, teamId: string) {
    const team = await prisma.team.findFirst({ where: { id: teamId, workspaceId } });
    if (!team) throw new NotFoundError("Team", teamId);
    return team;
  }

  app.get("/workspaces/:ws/teams", { preHandler: member }, async (request) => {
    const teams = await prisma.team.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { members: true, projects: true } } },
    });
    return {
      data: teams.map((t) => ({
        id: t.id, name: t.name, slug: t.slug, description: t.description,
        memberCount: t._count.members, projectCount: t._count.projects, createdAt: t.createdAt,
      })),
    };
  });

  app.post("/workspaces/:ws/teams", { preHandler: admin }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const workspaceId = request.wsCtx!.workspaceId;
    const slug = body.slug ?? slugify(body.name);
    const existing = await prisma.team.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } });
    if (existing) throw new ConflictError(`A team with slug '${slug}' already exists`);

    const team = await prisma.team.create({
      data: { workspaceId, name: body.name, slug, description: body.description ?? null },
    });
    return reply.status(201).send(team);
  });

  app.get("/workspaces/:ws/teams/:teamId", { preHandler: member }, async (request) => {
    const { teamId } = request.params as { teamId: string };
    await loadTeam(request.wsCtx!.workspaceId, teamId);
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        },
        projects: {
          where: { status: "ACTIVE" },
          select: { id: true, name: true, slug: true, status: true },
          orderBy: { name: "asc" },
        },
      },
    });
    return {
      id: team.id, name: team.name, slug: team.slug, description: team.description, createdAt: team.createdAt,
      members: team.members.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt })),
      projects: team.projects,
    };
  });

  app.patch("/workspaces/:ws/teams/:teamId", { preHandler: member }, async (request) => {
    const { teamId } = request.params as { teamId: string };
    await loadTeam(request.wsCtx!.workspaceId, teamId);
    await assertCanManageTeam(request, teamId);
    const body = updateSchema.parse(request.body);
    return prisma.team.update({
      where: { id: teamId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
    });
  });

  app.delete("/workspaces/:ws/teams/:teamId", { preHandler: admin }, async (request) => {
    const { teamId } = request.params as { teamId: string };
    await loadTeam(request.wsCtx!.workspaceId, teamId);
    // Project.team is onDelete: SetNull — projects survive, just lose the owner.
    await prisma.team.delete({ where: { id: teamId } });
    return { ok: true };
  });

  // ── Members ────────────────────────────────────────────────────────────────

  app.post("/workspaces/:ws/teams/:teamId/members", { preHandler: member }, async (request, reply) => {
    const { teamId } = request.params as { teamId: string };
    await loadTeam(request.wsCtx!.workspaceId, teamId);
    await assertCanManageTeam(request, teamId);
    const body = memberSchema.parse(request.body);

    // A team member must already belong to the workspace.
    const inWorkspace = await prisma.workspaceMember.findFirst({
      where: { workspaceId: request.wsCtx!.workspaceId, userId: body.userId },
    });
    if (!inWorkspace) throw new NotFoundError("Workspace member", body.userId);

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: body.userId } },
    });
    if (existing) throw new ConflictError("User is already a member of this team");

    const created = await prisma.teamMember.create({
      data: { teamId, userId: body.userId, role: body.role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return reply.status(201).send({ ...created.user, role: created.role, joinedAt: created.createdAt });
  });

  app.patch("/workspaces/:ws/teams/:teamId/members/:userId", { preHandler: member }, async (request) => {
    const { teamId, userId } = request.params as { teamId: string; userId: string };
    await loadTeam(request.wsCtx!.workspaceId, teamId);
    await assertCanManageTeam(request, teamId);
    const { role } = z.object({ role: z.enum(["LEAD", "MEMBER"]) }).parse(request.body);

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!existing) throw new NotFoundError("Team member", userId);
    await prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { role } });
    return { ok: true, role };
  });

  app.delete("/workspaces/:ws/teams/:teamId/members/:userId", { preHandler: member }, async (request) => {
    const { teamId, userId } = request.params as { teamId: string; userId: string };
    await loadTeam(request.wsCtx!.workspaceId, teamId);
    await assertCanManageTeam(request, teamId);
    const deleted = await prisma.teamMember.deleteMany({ where: { teamId, userId } });
    if (deleted.count === 0) throw new NotFoundError("Team member", userId);
    return { ok: true };
  });
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "team";
}
