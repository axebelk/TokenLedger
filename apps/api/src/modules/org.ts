import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@tokentrail/shared";
import type { PrismaClient } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]{2,50}$/).optional(),
  teamId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  teamId: z.string().uuid().nullable().optional(), // null detaches the owning team
  description: z.string().max(500).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

interface OrgModuleOptions {
  prisma: PrismaClient;
  authenticate: preHandlerHookHandler;
}

export function registerOrgModule(app: FastifyInstance, opts: OrgModuleOptions): void {
  const { prisma, authenticate } = opts;
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];
  const admin = [authenticate, makeWorkspaceGuard(prisma, "ADMIN")];

  app.get("/workspaces", { preHandler: [authenticate] }, async (request) => {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: request.user!.id, workspace: { deletedAt: null } },
      include: { workspace: { select: { id: true, name: true, slug: true, createdAt: true } } },
    });
    return { data: memberships.map((m) => ({ ...m.workspace, role: m.role })) };
  });

  app.get("/workspaces/:ws", { preHandler: member }, async (request) => {
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: request.wsCtx!.workspaceId },
      select: { id: true, name: true, slug: true, settings: true, createdAt: true },
    });
    return { ...workspace, role: request.wsCtx!.role };
  });

  app.get("/workspaces/:ws/projects", { preHandler: member }, async (request) => {
    const query = z
      .object({ status: z.enum(["ACTIVE", "ARCHIVED"]).default("ACTIVE") })
      .parse(request.query ?? {});
    const projects = await prisma.project.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId, status: query.status },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, slug: true, teamId: true, description: true,
        tags: true, status: true, createdAt: true,
      },
    });
    return { data: projects };
  });

  app.post("/workspaces/:ws/projects", { preHandler: admin }, async (request, reply) => {
    const body = createProjectSchema.parse(request.body);
    const workspaceId = request.wsCtx!.workspaceId;

    if (body.teamId) {
      const team = await prisma.team.findFirst({ where: { id: body.teamId, workspaceId } });
      if (!team) throw new NotFoundError("Team", body.teamId);
    }
    const slug = body.slug ?? slugify(body.name);
    const existing = await prisma.project.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
    if (existing) throw new ValidationError(`A project with slug '${slug}' already exists`);

    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: body.name,
        slug,
        teamId: body.teamId ?? null,
        description: body.description ?? null,
        tags: body.tags,
      },
    });
    return reply.status(201).send(project);
  });

  app.patch("/workspaces/:ws/projects/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const body = updateProjectSchema.parse(request.body);

    const project = await prisma.project.findFirst({ where: { id, workspaceId } });
    if (!project) throw new NotFoundError("Project", id);
    if (body.teamId) {
      const team = await prisma.team.findFirst({ where: { id: body.teamId, workspaceId } });
      if (!team) throw new NotFoundError("Team", body.teamId);
    }

    return prisma.project.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      select: {
        id: true, name: true, slug: true, teamId: true, description: true,
        tags: true, status: true, createdAt: true,
      },
    });
  });

  app.delete("/workspaces/:ws/projects/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const project = await prisma.project.findFirst({ where: { id, workspaceId } });
    if (!project) throw new NotFoundError("Project", id);

    const usageCount = await prisma.usageEvent.count({ where: { projectId: id } });
    if (usageCount > 0) {
      throw new ValidationError(
        "This project has recorded usage — archive it instead of deleting, to preserve the history",
      );
    }
    // Members cascade; keys have no usage (guarded above) so remove them first.
    await prisma.$transaction([
      prisma.virtualKey.deleteMany({ where: { projectId: id } }),
      prisma.project.delete({ where: { id } }),
    ]);
    return { ok: true };
  });
}

function slugify(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "project"
  );
}
