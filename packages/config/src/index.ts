import { z } from "zod";

/**
 * Shared env-schema fragments. Each app composes these with its own
 * service-specific fields and calls `loadConfig` once at boot; a bad
 * environment fails fast with a readable report before anything starts.
 */

export const baseEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
});

export const databaseEnv = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
});

export const redisEnv = z.object({
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
});

export const secretsEnv = z.object({
  TOKENTRAIL_MASTER_KEY: z
    .string()
    .min(32, "TOKENTRAIL_MASTER_KEY must be a base64-encoded 32-byte key"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
});

export const gatewayEnv = z.object({
  GATEWAY_FAILURE_POLICY: z.enum(["FAIL_OPEN", "FAIL_CLOSED"]).default("FAIL_OPEN"),
});

export const smtpEnv = z.object({
  SMTP_URL: z.string().optional(),
});

export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): Readonly<z.infer<T>> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const report = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${report}`);
  }
  return Object.freeze(parsed.data);
}
