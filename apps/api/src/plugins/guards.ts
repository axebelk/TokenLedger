import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  hasMinimumRole,
  type WorkspaceRole,
} from "@tokentrail/shared";
import { verifyAccessToken } from "@tokentrail/auth";
import type { PrismaClient } from "@tokentrail/db";

export interface AuthedUser {
  id: string;
  email: string;
}

export interface WorkspaceContext {
  workspaceId: string;
  slug: string;
  role: WorkspaceRole;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
    wsCtx?: WorkspaceContext;
  }
}

/** preHandler: requires a valid access token; attaches request.user. */
export function makeAuthenticate(jwtSecret: string): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedError();
    const claims = await verifyAccessToken(header.slice("Bearer ".length), jwtSecret);
    if (!claims) throw new UnauthorizedError("Invalid or expired access token");
    request.user = { id: claims.sub, email: claims.email };
  };
}

/**
 * preHandler factory: resolves the :ws param (id or slug), checks membership
 * and minimum role, attaches request.wsCtx. Non-members get 404, not 403 —
 * a workspace's existence is itself tenant data.
 */
export function makeWorkspaceGuard(
  prisma: PrismaClient,
  minRole: WorkspaceRole = "VIEWER",
): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = request.user;
    if (!user) throw new UnauthorizedError();
    const { ws } = request.params as { ws: string };

    const membership = await prisma.workspaceMember.findFirst({
      where: {
        userId: user.id,
        workspace: {
          deletedAt: null,
          // {id: undefined} inside OR would match everything — build the filter explicitly
          ...(isUuid(ws) ? { OR: [{ id: ws }, { slug: ws }] } : { slug: ws }),
        },
      },
      include: { workspace: { select: { id: true, slug: true } } },
    });
    if (!membership) throw new NotFoundError("Workspace", ws);
    if (!hasMinimumRole(membership.role, minRole)) {
      throw new ForbiddenError(`This action requires the ${minRole} role`);
    }
    request.wsCtx = {
      workspaceId: membership.workspace.id,
      slug: membership.workspace.slug,
      role: membership.role,
    };
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
