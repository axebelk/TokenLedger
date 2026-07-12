import { PrismaClient, Prisma } from "../generated/client/index.js";

export { PrismaClient, Prisma };
export * from "../generated/client/index.js";

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient(
    databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined,
  );
}

/**
 * Models that carry a workspaceId column. The scoped client injects the
 * workspace filter into every query on these models — cross-tenant leakage
 * then requires two mistakes (bypassing the scoped client AND omitting the
 * WHERE clause), not one.
 */
const WORKSPACE_SCOPED_MODELS = new Set<string>([
  "WorkspaceMember",
  "Team",
  "Project",
  "Invitation",
  "ProviderCredential",
  "ProviderPool",
  "VirtualKey",
  "ModelPriceOverride",
  "UsageEvent",
  "UsageRollupHourly",
  "UsageRollupDaily",
  "Budget",
  "ExportJob",
  "ScheduledReport",
  "AuditLog",
  "SsoConnection",
  "SlackIntegration",
  "Branding",
]);

type QueryArgs = { where?: Record<string, unknown>; data?: unknown } & Record<string, unknown>;

function injectWorkspaceFilter(args: QueryArgs, workspaceId: string): void {
  args.where = { ...(args.where ?? {}), workspaceId };
}

/** Returns a client whose queries on workspace-scoped models are force-filtered. */
export function scopedClient(base: PrismaClient, workspaceId: string) {
  return base.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          if (WORKSPACE_SCOPED_MODELS.has(model)) injectWorkspaceFilter(args as QueryArgs, workspaceId);
          return query(args);
        },
        async findFirst({ model, args, query }) {
          if (WORKSPACE_SCOPED_MODELS.has(model)) injectWorkspaceFilter(args as QueryArgs, workspaceId);
          return query(args);
        },
        async count({ model, args, query }) {
          if (WORKSPACE_SCOPED_MODELS.has(model)) injectWorkspaceFilter(args as QueryArgs, workspaceId);
          return query(args);
        },
        async updateMany({ model, args, query }) {
          if (WORKSPACE_SCOPED_MODELS.has(model)) injectWorkspaceFilter(args as QueryArgs, workspaceId);
          return query(args);
        },
        async deleteMany({ model, args, query }) {
          if (WORKSPACE_SCOPED_MODELS.has(model)) injectWorkspaceFilter(args as QueryArgs, workspaceId);
          return query(args);
        },
      },
    },
  });
}

export type ScopedClient = ReturnType<typeof scopedClient>;
