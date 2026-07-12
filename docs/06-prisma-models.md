# TokenTrail — Prisma Models

Lives at `packages/db/prisma/schema.prisma`. Partitioning of `UsageEvent`/`AuditLog` and BRIN/partial indexes are added in raw-SQL migration steps (Prisma models remain the source of truth for shape).

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["relationJoins"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────── Enums ───────────────────────────

enum WorkspaceRole { OWNER ADMIN MEMBER VIEWER }
enum TeamRole      { LEAD MEMBER }
enum UserStatus    { ACTIVE DEACTIVATED }
enum ProjectStatus { ACTIVE ARCHIVED }
enum KeyStatus     { ACTIVE REVOKED EXPIRED }
enum CredStatus    { ACTIVE DISABLED }

enum Provider { ANTHROPIC OPENAI GEMINI MINIMAX OPENROUTER DEEPSEEK OLLAMA }

enum PoolStrategy { PRIORITY ROUND_ROBIN WEIGHTED }
enum PoolHealth   { HEALTHY DEGRADED DISABLED }

enum EventStatus { OK PROVIDER_ERROR BLOCKED_BUDGET BLOCKED_RATELIMIT AUTH_ERROR }
enum EventKind   { REQUEST ADJUSTMENT }
enum CostBasis   { ACTUAL ESTIMATED OVERRIDDEN UNPRICED }
enum PriceSource { SEED SYNC MANUAL }

enum BudgetScope   { WORKSPACE TEAM PROJECT USER }
enum BudgetPeriod  { DAILY WEEKLY MONTHLY QUARTERLY }
enum Enforcement   { ALERT SOFT HARD }          // SOFT/HARD gated by license
enum JobStatus     { PENDING RUNNING DONE FAILED }
enum ReportFormat  { CSV PDF }
enum SsoType       { OIDC SAML }

// ─────────────────────── Identity & Org ──────────────────────

model User {
  id            String     @id @default(uuid(7)) @db.Uuid
  email         String     @unique @db.Citext
  passwordHash  String?                       // null ⇒ SSO-only
  name          String
  avatarUrl     String?
  status        UserStatus @default(ACTIVE)
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  memberships   WorkspaceMember[]
  teamMemberships TeamMember[]
  projectMemberships ProjectMember[]
  virtualKeys   VirtualKey[]
  apiTokens     ApiToken[]
  usageEvents   UsageEvent[]
}

model Workspace {
  id        String    @id @default(uuid(7)) @db.Uuid
  name      String
  slug      String    @unique
  settings  Json      @default("{}")          // failurePolicy, memberAnalytics, displayCurrency…
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  members      WorkspaceMember[]
  teams        Team[]
  projects     Project[]
  credentials  ProviderCredential[]
  pools        ProviderPool[]
  virtualKeys  VirtualKey[]
  usageEvents  UsageEvent[]
  budgets      Budget[]
  invitations  Invitation[]
  priceOverrides ModelPriceOverride[]
  exportJobs   ExportJob[]
  scheduledReports ScheduledReport[]
  auditLogs    AuditLog[]
  ssoConnections SsoConnection[]
  slack        SlackIntegration?
  branding     Branding?
}

model WorkspaceMember {
  id          String        @id @default(uuid(7)) @db.Uuid
  workspaceId String        @db.Uuid
  userId      String        @db.Uuid
  role        WorkspaceRole @default(MEMBER)
  createdAt   DateTime      @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id])
  user      User      @relation(fields: [userId], references: [id])

  @@unique([workspaceId, userId])
  @@index([userId])
}

model Team {
  id          String   @id @default(uuid(7)) @db.Uuid
  workspaceId String   @db.Uuid
  name        String
  slug        String
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  workspace Workspace    @relation(fields: [workspaceId], references: [id])
  members   TeamMember[]
  projects  Project[]

  @@unique([workspaceId, slug])
}

model TeamMember {
  id        String   @id @default(uuid(7)) @db.Uuid
  teamId    String   @db.Uuid
  userId    String   @db.Uuid
  role      TeamRole @default(MEMBER)
  createdAt DateTime @default(now())

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id])

  @@unique([teamId, userId])
  @@index([userId])
}

model Project {
  id          String        @id @default(uuid(7)) @db.Uuid
  workspaceId String        @db.Uuid
  teamId      String?       @db.Uuid            // owning team (optional)
  name        String
  slug        String
  description String?
  tags        String[]      @default([])
  status      ProjectStatus @default(ACTIVE)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  workspace Workspace       @relation(fields: [workspaceId], references: [id])
  team      Team?           @relation(fields: [teamId], references: [id], onDelete: SetNull)
  members   ProjectMember[]
  virtualKeys VirtualKey[]
  usageEvents UsageEvent[]

  @@unique([workspaceId, slug])
  @@index([workspaceId, status])
}

model ProjectMember {
  id        String   @id @default(uuid(7)) @db.Uuid
  projectId String   @db.Uuid
  userId    String   @db.Uuid
  createdAt DateTime @default(now())

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id])

  @@unique([projectId, userId])
}

model Invitation {
  id          String        @id @default(uuid(7)) @db.Uuid
  workspaceId String        @db.Uuid
  email       String        @db.Citext
  role        WorkspaceRole @default(MEMBER)
  teamId      String?       @db.Uuid
  tokenHash   String        @unique
  invitedById String        @db.Uuid
  expiresAt   DateTime
  acceptedAt  DateTime?
  createdAt   DateTime      @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@index([workspaceId, email])
}

// ───────────────── Credentials, Pools, Keys ──────────────────

model ProviderCredential {
  id              String     @id @default(uuid(7)) @db.Uuid
  workspaceId     String     @db.Uuid
  provider        Provider
  name            String
  encryptedSecret Bytes?                       // null for Ollama (no secret)
  secretLast4     String?
  baseUrl         String?                      // Ollama / proxied / regional endpoints
  modelAllowlist  String[]   @default([])
  isDefault       Boolean    @default(false)   // partial unique (ws,provider) in SQL migration
  status          CredStatus @default(ACTIVE)
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  workspace   Workspace    @relation(fields: [workspaceId], references: [id])
  poolMembers PoolMember[]
  usageEvents UsageEvent[]

  @@index([workspaceId, provider])
}

model ProviderPool {                            // EE
  id          String       @id @default(uuid(7)) @db.Uuid
  workspaceId String       @db.Uuid
  provider    Provider
  name        String
  strategy    PoolStrategy @default(PRIORITY)
  cooldownS   Int          @default(60)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  workspace Workspace    @relation(fields: [workspaceId], references: [id])
  members   PoolMember[]
  usageEvents UsageEvent[]

  @@unique([workspaceId, provider, name])
}

model PoolMember {                              // EE
  id              String     @id @default(uuid(7)) @db.Uuid
  poolId          String     @db.Uuid
  credentialId    String     @db.Uuid
  priority        Int        @default(0)
  weight          Int        @default(1)
  rpmLimit        Int?
  tpmLimit        Int?
  health          PoolHealth @default(HEALTHY)
  healthChangedAt DateTime?

  pool       ProviderPool       @relation(fields: [poolId], references: [id], onDelete: Cascade)
  credential ProviderCredential @relation(fields: [credentialId], references: [id])

  @@unique([poolId, credentialId])
}

model VirtualKey {
  id                String    @id @default(uuid(7)) @db.Uuid
  workspaceId       String    @db.Uuid
  projectId         String    @db.Uuid
  userId            String    @db.Uuid
  name              String
  keyHash           String    @unique           // sha256 of tt_live_…
  keyLast4          String
  providerAllowlist Provider[] @default([])     // empty ⇒ all workspace providers
  modelAllowlist    String[]  @default([])
  rpmLimit          Int?
  expiresAt         DateTime?
  status            KeyStatus @default(ACTIVE)
  lastUsedAt        DateTime?
  createdAt         DateTime  @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id])
  project   Project   @relation(fields: [projectId], references: [id])
  user      User      @relation(fields: [userId], references: [id])
  usageEvents UsageEvent[]

  @@index([workspaceId, status])
  @@index([userId])
}

model ApiToken {
  id          String    @id @default(uuid(7)) @db.Uuid
  workspaceId String    @db.Uuid
  userId      String    @db.Uuid
  name        String
  tokenHash   String    @unique
  scopes      String[]  @default([])
  expiresAt   DateTime?
  lastUsedAt  DateTime?
  createdAt   DateTime  @default(now())

  user User @relation(fields: [userId], references: [id])
}

// ─────────────────────────── Pricing ─────────────────────────

model ModelPrice {
  id               String      @id @default(uuid(7)) @db.Uuid
  provider         Provider
  modelPattern     String                       // exact id or trailing-* prefix
  inputPerMtok     Decimal     @db.Decimal(12, 6)
  outputPerMtok    Decimal     @db.Decimal(12, 6)
  cacheReadPerMtok Decimal     @default(0) @db.Decimal(12, 6)
  cacheWritePerMtok Decimal    @default(0) @db.Decimal(12, 6)
  effectiveFrom    DateTime
  effectiveTo      DateTime?                    // null ⇒ current
  source           PriceSource @default(SEED)

  @@unique([provider, modelPattern, effectiveFrom])
  @@index([provider, effectiveTo])
}

model ModelPriceOverride {
  id               String    @id @default(uuid(7)) @db.Uuid
  workspaceId      String    @db.Uuid
  provider         Provider
  modelPattern     String
  inputPerMtok     Decimal   @db.Decimal(12, 6)
  outputPerMtok    Decimal   @db.Decimal(12, 6)
  cacheReadPerMtok Decimal   @default(0) @db.Decimal(12, 6)
  cacheWritePerMtok Decimal  @default(0) @db.Decimal(12, 6)
  createdAt        DateTime  @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@unique([workspaceId, provider, modelPattern])
}

// ──────────────────────── Usage (hot) ────────────────────────
// Physically: PARTITION BY RANGE (occurredAt), monthly. Append-only.

model UsageEvent {
  id              String      @db.Uuid          // uuid v7 minted at gateway
  occurredAt      DateTime                       // partition key
  workspaceId     String      @db.Uuid
  projectId       String      @db.Uuid
  teamId          String?     @db.Uuid           // denormalized at event time
  userId          String      @db.Uuid
  virtualKeyId    String      @db.Uuid
  credentialId    String?     @db.Uuid
  poolId          String?     @db.Uuid
  provider        Provider
  modelRaw        String
  model           String                          // normalized / price-matched
  endpoint        String
  requestId       String
  kind            EventKind   @default(REQUEST)
  status          EventStatus
  httpStatus      Int
  streamed        Boolean     @default(false)
  inputTokens     Int         @default(0)
  outputTokens    Int         @default(0)
  cacheReadTokens Int         @default(0)
  cacheWriteTokens Int        @default(0)
  reasoningTokens Int         @default(0)
  costUsd         Decimal     @default(0) @db.Decimal(14, 8)
  unitPrices      Json?                           // snapshot {in,out,cr,cw,source}
  costBasis       CostBasis   @default(ACTUAL)
  latencyMs       Int         @default(0)
  ttftMs          Int?
  tags            String[]    @default([])

  workspace  Workspace          @relation(fields: [workspaceId], references: [id])
  project    Project            @relation(fields: [projectId], references: [id])
  user       User               @relation(fields: [userId], references: [id])
  virtualKey VirtualKey         @relation(fields: [virtualKeyId], references: [id])
  credential ProviderCredential? @relation(fields: [credentialId], references: [id])
  pool       ProviderPool?      @relation(fields: [poolId], references: [id])

  @@id([id, occurredAt])                          // partition key in PK
  @@index([workspaceId, occurredAt(sort: Desc)])
  @@index([projectId, occurredAt(sort: Desc)])
  @@index([userId, occurredAt(sort: Desc)])
}

model UsageRollupHourly {
  bucket        DateTime
  workspaceId   String   @db.Uuid
  projectId     String   @db.Uuid
  teamId        String?  @db.Uuid
  userId        String   @db.Uuid
  provider      Provider
  model         String
  requests      Int      @default(0)
  errors        Int      @default(0)
  inputTokens   BigInt   @default(0)
  outputTokens  BigInt   @default(0)
  cacheReadTokens BigInt @default(0)
  cacheWriteTokens BigInt @default(0)
  reasoningTokens BigInt @default(0)
  costUsd       Decimal  @default(0) @db.Decimal(14, 6)
  latencyMsSum  BigInt   @default(0)
  latencyCount  Int      @default(0)
  latencyDigest Bytes?

  @@id([bucket, workspaceId, projectId, userId, provider, model])
  @@index([workspaceId, bucket(sort: Desc)])
}

model UsageRollupDaily {
  bucket        DateTime
  workspaceId   String   @db.Uuid
  projectId     String   @db.Uuid
  teamId        String?  @db.Uuid
  userId        String   @db.Uuid
  provider      Provider
  model         String
  requests      Int      @default(0)
  errors        Int      @default(0)
  inputTokens   BigInt   @default(0)
  outputTokens  BigInt   @default(0)
  cacheReadTokens BigInt @default(0)
  cacheWriteTokens BigInt @default(0)
  reasoningTokens BigInt @default(0)
  costUsd       Decimal  @default(0) @db.Decimal(14, 6)
  latencyMsSum  BigInt   @default(0)
  latencyCount  Int      @default(0)
  latencyDigest Bytes?

  @@id([bucket, workspaceId, projectId, userId, provider, model])
  @@index([workspaceId, bucket(sort: Desc)])
}

// ───────────────────────── Governance ────────────────────────

model Budget {
  id              String       @id @default(uuid(7)) @db.Uuid
  workspaceId     String       @db.Uuid
  scopeType       BudgetScope
  scopeId         String       @db.Uuid          // = workspaceId when scopeType=WORKSPACE
  period          BudgetPeriod @default(MONTHLY)
  amountUsd       Decimal      @db.Decimal(12, 2)
  alertThresholds Int[]        @default([50, 80, 100])
  enforcement     Enforcement  @default(ALERT)
  softGracePct    Int          @default(10)
  timezone        String       @default("UTC")
  status          String       @default("ACTIVE")
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  workspace     Workspace            @relation(fields: [workspaceId], references: [id])
  notifications BudgetNotification[]

  @@unique([scopeType, scopeId, period])
  @@index([workspaceId])
}

model BudgetNotification {
  id          String   @id @default(uuid(7)) @db.Uuid
  budgetId    String   @db.Uuid
  periodStart DateTime
  threshold   Int
  channel     String                             // email | slack | webhook
  sentAt      DateTime @default(now())

  budget Budget @relation(fields: [budgetId], references: [id], onDelete: Cascade)

  @@unique([budgetId, periodStart, threshold, channel])
}

model ExportJob {
  id           String    @id @default(uuid(7)) @db.Uuid
  workspaceId  String    @db.Uuid
  requestedById String   @db.Uuid
  params       Json                               // report definition
  status       JobStatus @default(PENDING)
  rowCount     Int?
  filePath     String?
  error        String?
  expiresAt    DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@index([workspaceId, createdAt(sort: Desc)])
}

// ───────────────────────── Enterprise ────────────────────────

model ScheduledReport {
  id           String       @id @default(uuid(7)) @db.Uuid
  workspaceId  String       @db.Uuid
  name         String
  cron         String
  timezone     String       @default("UTC")
  reportParams Json
  format       ReportFormat @default(CSV)
  recipients   Json                                // {emails:[], slackChannel?}
  lastRunAt    DateTime?
  status       String       @default("ACTIVE")
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id])
}

model AuditLog {                                   // append-only, monthly partitions
  id           String   @db.Uuid
  createdAt    DateTime @default(now())
  workspaceId  String   @db.Uuid
  actorUserId  String?  @db.Uuid
  actorType    String   @default("USER")           // USER | SYSTEM | API_TOKEN
  action       String                              // e.g. budget.update
  resourceType String
  resourceId   String?
  diff         Json?                               // redacted before/after
  ip           String?
  userAgent    String?
  prevHash     String?
  hash         String

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@id([id, createdAt])
  @@index([workspaceId, createdAt(sort: Desc)])
  @@index([workspaceId, action])
}

model SsoConnection {
  id          String   @id @default(uuid(7)) @db.Uuid
  workspaceId String   @db.Uuid
  type        SsoType
  config      Json                                 // encrypted secrets inside
  enforced    Boolean  @default(false)
  defaultRole WorkspaceRole @default(MEMBER)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id])
}

model SlackIntegration {
  id                String   @id @default(uuid(7)) @db.Uuid
  workspaceId       String   @unique @db.Uuid
  slackTeamId       String
  encryptedBotToken Bytes
  defaultChannel    String?
  status            String   @default("ACTIVE")
  createdAt         DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id])
}

model Branding {
  id            String  @id @default(uuid(7)) @db.Uuid
  workspaceId   String  @unique @db.Uuid
  productName   String?
  logoUrl       String?
  faviconUrl    String?
  colors        Json?
  emailFromName String?

  workspace Workspace @relation(fields: [workspaceId], references: [id])
}

model License {
  id         String   @id @default(uuid(7)) @db.Uuid
  keyText    String
  plan       String
  seats      Int
  expiresAt  DateTime
  verifiedAt DateTime @default(now())
}
```

## Raw-SQL migration companions

1. `CREATE EXTENSION IF NOT EXISTS citext;`
2. Convert `usage_event` / `audit_log` to `PARTITION BY RANGE` + create current & next month partitions (worker maintains future ones).
3. Partial unique index: `CREATE UNIQUE INDEX ON provider_credential(workspace_id, provider) WHERE is_default;`
4. BRIN index on `usage_event(occurred_at)`.
5. `REVOKE UPDATE, DELETE ON usage_event, audit_log FROM tokentrail_app;`

## Tenancy guard (packages/db)

```ts
export const scopedClient = (base: PrismaClient, workspaceId: string) =>
  base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, args, query }) {
          if (WORKSPACE_SCOPED_MODELS.has(model)) injectWorkspaceFilter(args, workspaceId);
          return query(args);
        },
      },
    },
  });
```
Every API request handler receives a `scopedClient` from the workspace-context plugin — cross-tenant leakage requires *two* mistakes, not one.
