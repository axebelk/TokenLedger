import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ACCESS_TOKEN_TTL_S,
  REFRESH_TOKEN_TTL_S,
  hashPassword,
  mintRefreshToken,
  sha256Hex,
  signAccessToken,
  verifyPassword,
} from "@tokentrail/auth";
import { ConflictError, UnauthorizedError } from "@tokentrail/shared";
import type { PrismaClient } from "@tokentrail/db";
import type { preHandlerHookHandler } from "fastify";

const REFRESH_COOKIE = "tt_refresh";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(100),
  workspaceName: z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

interface AuthModuleOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  authenticate: preHandlerHookHandler;
  secureCookies: boolean;
  superAdmins: Set<string>;
}

export function registerAuthModule(app: FastifyInstance, opts: AuthModuleOptions): void {
  const { prisma, jwtSecret, authenticate, secureCookies, superAdmins } = opts;

  function setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      path: "/api/v1/auth",
      maxAge: REFRESH_TOKEN_TTL_S,
    });
  }

  async function issueSession(
    reply: FastifyReply,
    user: { id: string; email: string },
    familyId: string,
    request: FastifyRequest,
  ) {
    const refresh = mintRefreshToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: refresh.hash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000),
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
    setRefreshCookie(reply, refresh.token);
    return signAccessToken({ sub: user.id, email: user.email }, jwtSecret, ACCESS_TOKEN_TTL_S);
  }

  app.post("/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new ConflictError("An account with this email already exists");

    const passwordHash = await hashPassword(body.password);
    const workspaceName = body.workspaceName ?? `${body.name}'s Workspace`;

    const { user, workspace } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: body.email, passwordHash, name: body.name },
      });
      const workspace = await tx.workspace.create({
        data: { name: workspaceName, slug: await uniqueSlug(tx, workspaceName) },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
      });
      return { user, workspace };
    });

    const accessToken = await issueSession(reply, user, randomUUID(), request);
    return reply.status(201).send({
      accessToken,
      user: publicUser(user),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    // Same error for unknown email and wrong password — no account enumeration.
    if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
      throw new UnauthorizedError("Invalid email or password");
    }
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      throw new UnauthorizedError("Invalid email or password");
    }
    const accessToken = await issueSession(reply, user, randomUUID(), request);
    return { accessToken, user: publicUser(user) };
  });

  app.post("/auth/refresh", async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE];
    if (!presented) throw new UnauthorizedError("No refresh token");

    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256Hex(presented) },
      include: { user: true },
    });
    if (!session || session.expiresAt.getTime() < Date.now()) {
      reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
      throw new UnauthorizedError("Session expired");
    }
    if (session.revokedAt) {
      // Reuse of a rotated token ⇒ the token leaked. Kill the whole family.
      await prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
      request.log.warn({ userId: session.userId }, "refresh token reuse detected — family revoked");
      throw new UnauthorizedError("Session revoked");
    }

    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    const accessToken = await issueSession(reply, session.user, session.familyId, request);
    return { accessToken, user: publicUser(session.user) };
  });

  app.post("/auth/logout", async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE];
    if (presented) {
      await prisma.session.updateMany({
        where: { tokenHash: sha256Hex(presented) },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: [authenticate] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.id },
      include: {
        memberships: {
          where: { workspace: { deletedAt: null } },
          include: { workspace: { select: { id: true, name: true, slug: true } } },
        },
      },
    });
    return {
      user: publicUser(user),
      isSuperAdmin: superAdmins.has(user.email.toLowerCase()),
      memberships: user.memberships.map((m) => ({ workspace: m.workspace, role: m.role })),
    };
  });
}

function publicUser(user: { id: string; email: string; name: string }) {
  return { id: user.id, email: user.email, name: user.name };
}

async function uniqueSlug(
  tx: { workspace: { findUnique(args: { where: { slug: string } }): Promise<unknown> } },
  name: string,
): Promise<string> {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  if (!(await tx.workspace.findUnique({ where: { slug: base } }))) return base;
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}
