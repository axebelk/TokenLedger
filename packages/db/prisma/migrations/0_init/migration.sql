-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('LEAD', 'MEMBER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CredStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GEMINI', 'MINIMAX', 'OPENROUTER', 'DEEPSEEK', 'OLLAMA');

-- CreateEnum
CREATE TYPE "PoolStrategy" AS ENUM ('PRIORITY', 'ROUND_ROBIN', 'WEIGHTED');

-- CreateEnum
CREATE TYPE "PoolHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'DISABLED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('OK', 'PROVIDER_ERROR', 'BLOCKED_BUDGET', 'BLOCKED_RATELIMIT', 'AUTH_ERROR');

-- CreateEnum
CREATE TYPE "EventKind" AS ENUM ('REQUEST', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CostBasis" AS ENUM ('ACTUAL', 'ESTIMATED', 'OVERRIDDEN', 'UNPRICED');

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('SEED', 'SYNC', 'MANUAL');

-- CreateEnum
CREATE TYPE "BudgetScope" AS ENUM ('WORKSPACE', 'TEAM', 'PROJECT', 'USER');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "Enforcement" AS ENUM ('ALERT', 'SOFT', 'HARD');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'PDF');

-- CreateEnum
CREATE TYPE "SsoType" AS ENUM ('OIDC', 'SAML');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_member" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_member" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "teamId" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_member" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "teamId" UUID,
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credential" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedSecret" BYTEA,
    "secretLast4" TEXT,
    "baseUrl" TEXT,
    "modelAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "CredStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_pool" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" "PoolStrategy" NOT NULL DEFAULT 'PRIORITY',
    "cooldownS" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_member" (
    "id" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "rpmLimit" INTEGER,
    "tpmLimit" INTEGER,
    "health" "PoolHealth" NOT NULL DEFAULT 'HEALTHY',
    "healthChangedAt" TIMESTAMPTZ(3),

    CONSTRAINT "pool_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_key" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "providerAllowlist" "Provider"[] DEFAULT ARRAY[]::"Provider"[],
    "modelAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rpmLimit" INTEGER,
    "expiresAt" TIMESTAMPTZ(3),
    "status" "KeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtual_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_price" (
    "id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "modelPattern" TEXT NOT NULL,
    "inputPerMtok" DECIMAL(12,6) NOT NULL,
    "outputPerMtok" DECIMAL(12,6) NOT NULL,
    "cacheReadPerMtok" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "cacheWritePerMtok" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(3),
    "source" "PriceSource" NOT NULL DEFAULT 'SEED',

    CONSTRAINT "model_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_price_override" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "modelPattern" TEXT NOT NULL,
    "inputPerMtok" DECIMAL(12,6) NOT NULL,
    "outputPerMtok" DECIMAL(12,6) NOT NULL,
    "cacheReadPerMtok" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "cacheWritePerMtok" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_price_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_event" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "teamId" UUID,
    "userId" UUID NOT NULL,
    "virtualKeyId" UUID NOT NULL,
    "credentialId" UUID,
    "poolId" UUID,
    "provider" "Provider" NOT NULL,
    "modelRaw" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" "EventKind" NOT NULL DEFAULT 'REQUEST',
    "status" "EventStatus" NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "unitPrices" JSONB,
    "costBasis" "CostBasis" NOT NULL DEFAULT 'ACTUAL',
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ttftMs" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id","occurredAt")
);

-- CreateTable
CREATE TABLE "usage_rollup_hourly" (
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "teamId" UUID,
    "userId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "model" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "reasoningTokens" BIGINT NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "latencyMsSum" BIGINT NOT NULL DEFAULT 0,
    "latencyCount" INTEGER NOT NULL DEFAULT 0,
    "latencyDigest" BYTEA,

    CONSTRAINT "usage_rollup_hourly_pkey" PRIMARY KEY ("bucket","workspaceId","projectId","userId","provider","model")
);

-- CreateTable
CREATE TABLE "usage_rollup_daily" (
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "teamId" UUID,
    "userId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "model" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "reasoningTokens" BIGINT NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "latencyMsSum" BIGINT NOT NULL DEFAULT 0,
    "latencyCount" INTEGER NOT NULL DEFAULT 0,
    "latencyDigest" BYTEA,

    CONSTRAINT "usage_rollup_daily_pkey" PRIMARY KEY ("bucket","workspaceId","projectId","userId","provider","model")
);

-- CreateTable
CREATE TABLE "budget" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "scopeType" "BudgetScope" NOT NULL,
    "scopeId" UUID NOT NULL,
    "period" "BudgetPeriod" NOT NULL DEFAULT 'MONTHLY',
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "alertThresholds" INTEGER[] DEFAULT ARRAY[50, 80, 100]::INTEGER[],
    "enforcement" "Enforcement" NOT NULL DEFAULT 'ALERT',
    "softGracePct" INTEGER NOT NULL DEFAULT 10,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_notification" (
    "id" UUID NOT NULL,
    "budgetId" UUID NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "threshold" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_job" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "params" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "rowCount" INTEGER,
    "filePath" TEXT,
    "error" TEXT,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_report" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "reportParams" JSONB NOT NULL,
    "format" "ReportFormat" NOT NULL DEFAULT 'CSV',
    "recipients" JSONB NOT NULL,
    "lastRunAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scheduled_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" UUID NOT NULL,
    "actorUserId" UUID,
    "actorType" TEXT NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "diff" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id","createdAt")
);

-- CreateTable
CREATE TABLE "sso_connection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "SsoType" NOT NULL,
    "config" JSONB NOT NULL,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "defaultRole" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sso_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_integration" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "encryptedBotToken" BYTEA NOT NULL,
    "defaultChannel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branding" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "productName" TEXT,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "colors" JSONB,
    "emailFromName" TEXT,

    CONSTRAINT "branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license" (
    "id" UUID NOT NULL,
    "keyText" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_tokenHash_key" ON "session"("tokenHash");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_familyId_idx" ON "session"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_slug_key" ON "workspace"("slug");

-- CreateIndex
CREATE INDEX "workspace_member_userId_idx" ON "workspace_member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_member_workspaceId_userId_key" ON "workspace_member"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "team_workspaceId_slug_key" ON "team"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "team_member_userId_idx" ON "team_member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "team_member_teamId_userId_key" ON "team_member"("teamId", "userId");

-- CreateIndex
CREATE INDEX "project_workspaceId_status_idx" ON "project"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_workspaceId_slug_key" ON "project"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "project_member_projectId_userId_key" ON "project_member"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_tokenHash_key" ON "invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "invitation_workspaceId_email_idx" ON "invitation"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "provider_credential_workspaceId_provider_idx" ON "provider_credential"("workspaceId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "provider_pool_workspaceId_provider_name_key" ON "provider_pool"("workspaceId", "provider", "name");

-- CreateIndex
CREATE UNIQUE INDEX "pool_member_poolId_credentialId_key" ON "pool_member"("poolId", "credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_key_keyHash_key" ON "virtual_key"("keyHash");

-- CreateIndex
CREATE INDEX "virtual_key_workspaceId_status_idx" ON "virtual_key"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "virtual_key_userId_idx" ON "virtual_key"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "api_token_tokenHash_key" ON "api_token"("tokenHash");

-- CreateIndex
CREATE INDEX "model_price_provider_effectiveTo_idx" ON "model_price"("provider", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "model_price_provider_modelPattern_effectiveFrom_key" ON "model_price"("provider", "modelPattern", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "model_price_override_workspaceId_provider_modelPattern_key" ON "model_price_override"("workspaceId", "provider", "modelPattern");

-- CreateIndex
CREATE INDEX "usage_event_workspaceId_occurredAt_idx" ON "usage_event"("workspaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "usage_event_projectId_occurredAt_idx" ON "usage_event"("projectId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "usage_event_userId_occurredAt_idx" ON "usage_event"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "usage_rollup_hourly_workspaceId_bucket_idx" ON "usage_rollup_hourly"("workspaceId", "bucket" DESC);

-- CreateIndex
CREATE INDEX "usage_rollup_daily_workspaceId_bucket_idx" ON "usage_rollup_daily"("workspaceId", "bucket" DESC);

-- CreateIndex
CREATE INDEX "budget_workspaceId_idx" ON "budget"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "budget_scopeType_scopeId_period_key" ON "budget"("scopeType", "scopeId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "budget_notification_budgetId_periodStart_threshold_channel_key" ON "budget_notification"("budgetId", "periodStart", "threshold", "channel");

-- CreateIndex
CREATE INDEX "export_job_workspaceId_createdAt_idx" ON "export_job"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_log_workspaceId_createdAt_idx" ON "audit_log"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_log_workspaceId_action_idx" ON "audit_log"("workspaceId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "slack_integration_workspaceId_key" ON "slack_integration"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "branding_workspaceId_key" ON "branding"("workspaceId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_pool" ADD CONSTRAINT "provider_pool_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_member" ADD CONSTRAINT "pool_member_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "provider_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_member" ADD CONSTRAINT "pool_member_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "provider_credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_price_override" ADD CONSTRAINT "model_price_override_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_virtualKeyId_fkey" FOREIGN KEY ("virtualKeyId") REFERENCES "virtual_key"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "provider_credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "provider_pool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget" ADD CONSTRAINT "budget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_notification" ADD CONSTRAINT "budget_notification_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_report" ADD CONSTRAINT "scheduled_report_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_connection" ADD CONSTRAINT "sso_connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_integration" ADD CONSTRAINT "slack_integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branding" ADD CONSTRAINT "branding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── TokenTrail companions (raw-SQL, per docs/05 §migration-companions) ──

-- Default all sessions of the app role to UTC so date_trunc / display are
-- timezone-safe regardless of the host's local timezone.
ALTER ROLE CURRENT_USER SET timezone TO 'UTC';

-- Only one default credential per (workspace, provider).
CREATE UNIQUE INDEX "provider_credential_default_unique"
  ON "provider_credential" ("workspaceId", "provider")
  WHERE "isDefault";

-- BRIN index on the append-only event stream's time column (cheap, effective
-- for range scans on a naturally time-ordered table).
CREATE INDEX "usage_event_occurredAt_brin" ON "usage_event" USING BRIN ("occurredAt");
