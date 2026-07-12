import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  ConflictError, NotFoundError, UnauthorizedError, ValidationError,
} from "@tokentrail/shared";
import { hashPassword, mintInviteToken, sha256Hex } from "@tokentrail/auth";
import type { PrismaClient } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";
import { inviteEmail, type Mailer } from "../lib/mailer.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"), // OWNER is never invitable
});

const acceptSchema = z.object({
  // Required when the invited email has no account yet:
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(200).optional(),
});

interface InvitationsModuleOptions {
  prisma: PrismaClient;
  authenticate: preHandlerHookHandler;
  mailer: Mailer;
  publicBaseUrl: string;
}

export function registerInvitationsModule(app: FastifyInstance, opts: InvitationsModuleOptions): void {
  const { prisma, authenticate, mailer, publicBaseUrl } = opts;
  const admin = [authenticate, makeWorkspaceGuard(prisma, "ADMIN")];
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];

  app.get("/workspaces/:ws/members", { preHandler: member }, async (request) => {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, name: true, email: true, status: true } } },
    });
    return { data: members.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt })) };
  });

  app.get("/workspaces/:ws/invitations", { preHandler: admin }, async (request) => {
    const invitations = await prisma.invitation.findMany({
      where: {
        workspaceId: request.wsCtx!.workspaceId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    return { data: invitations };
  });

  app.post("/workspaces/:ws/invitations", { preHandler: admin }, async (request, reply) => {
    const body = inviteSchema.parse(request.body);
    const workspaceId = request.wsCtx!.workspaceId;

    const existingMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId, user: { email: body.email } },
    });
    if (existingMember) throw new ConflictError("This user is already a workspace member");

    const pending = await prisma.invitation.findFirst({
      where: { workspaceId, email: body.email, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    if (pending) throw new ConflictError("An invitation for this email is already pending");

    const minted = mintInviteToken();
    const [invitation, workspace, inviter] = await Promise.all([
      prisma.invitation.create({
        data: {
          workspaceId,
          email: body.email,
          role: body.role,
          tokenHash: minted.hash,
          invitedById: request.user!.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
        select: { id: true, email: true, role: true, expiresAt: true },
      }),
      prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: request.user!.id }, select: { name: true } }),
    ]);

    const acceptUrl = `${publicBaseUrl}/invite/${minted.token}`;
    const mail = inviteEmail({ workspaceName: workspace.name, inviterName: inviter.name, acceptUrl });
    mailer.send(body.email, mail.subject, mail.html, mail.text).catch((err) => {
      request.log.error({ err }, "invitation email failed to send");
    });

    // Return the accept link so an admin can copy/share it directly — essential
    // when SMTP isn't configured. This is the only time the token is exposed.
    return reply.status(201).send({ ...invitation, acceptUrl });
  });

  // Re-issue a shareable link for a still-pending invitation. Because the token
  // is stored only as a hash, the original link is unrecoverable — so we mint a
  // fresh token (invalidating any previously shared link) and return the new URL.
  app.post("/workspaces/:ws/invitations/:id/link", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const invitation = await prisma.invitation.findFirst({
      where: { id, workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true },
    });
    if (!invitation) throw new NotFoundError("Invitation", id);

    const minted = mintInviteToken();
    await prisma.invitation.update({ where: { id }, data: { tokenHash: minted.hash } });
    const acceptUrl = `${publicBaseUrl}/invite/${minted.token}`;
    return { ...invitation, acceptUrl };
  });

  app.delete("/workspaces/:ws/invitations/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const deleted = await prisma.invitation.deleteMany({
      where: { id, workspaceId: request.wsCtx!.workspaceId, acceptedAt: null },
    });
    if (deleted.count === 0) throw new NotFoundError("Invitation", id);
    return { ok: true };
  });

  // ── Public accept flow (token-authenticated) ─────────────────────────────

  app.get("/auth/invitations/:token", async (request) => {
    const invitation = await findValidInvitation(prisma, (request.params as { token: string }).token);
    const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });
    return {
      email: invitation.email,
      role: invitation.role,
      workspace: invitation.workspace,
      accountExists: existingUser !== null,
    };
  });

  app.post("/auth/invitations/:token/accept", async (request, reply) => {
    const body = acceptSchema.parse(request.body ?? {});
    const invitation = await findValidInvitation(prisma, (request.params as { token: string }).token);

    let user = await prisma.user.findUnique({ where: { email: invitation.email } });
    if (!user) {
      if (!body.name || !body.password) {
        throw new ValidationError("name and password are required to create your account");
      }
      user = await prisma.user.create({
        data: {
          email: invitation.email,
          name: body.name,
          passwordHash: await hashPassword(body.password),
        },
      });
    }

    await prisma.$transaction([
      prisma.workspaceMember.create({
        data: { workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role },
      }),
      prisma.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
    ]);

    return reply.status(200).send({
      ok: true,
      workspace: invitation.workspace,
      accountCreated: body.name !== undefined,
    });
  });
}

async function findValidInvitation(prisma: PrismaClient, token: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { workspace: { select: { id: true, name: true, slug: true } } },
  });
  if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() < Date.now()) {
    throw new UnauthorizedError("This invitation is invalid or has expired");
  }
  return invitation;
}
