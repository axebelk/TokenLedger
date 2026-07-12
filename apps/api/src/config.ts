import { randomBytes } from "node:crypto";
import { z } from "zod";
import { baseEnv, databaseEnv, loadConfig, redisEnv, smtpEnv } from "@tokentrail/config";

const apiEnv = baseEnv
  .merge(databaseEnv)
  .merge(redisEnv)
  .merge(smtpEnv)
  .extend({
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    JWT_SECRET: z.string().min(32).optional(),
    TOKENTRAIL_MASTER_KEY: z.string().min(32).optional(),
    // Comma-separated emails granted instance-level super-admin (cross-workspace).
    SUPERADMIN_EMAILS: z.string().optional(),
  })
  .transform((env, ctx) => {
    let jwtSecret = env.JWT_SECRET;
    if (!jwtSecret) {
      if (env.NODE_ENV === "production") {
        ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "required in production" });
        return z.NEVER;
      }
      // Dev convenience: ephemeral secret — sessions won't survive a restart.
      jwtSecret = randomBytes(48).toString("base64");
      console.warn("[api] JWT_SECRET not set — using an ephemeral dev secret");
    }
    return { ...env, JWT_SECRET: jwtSecret };
  });

export type ApiConfig = Readonly<z.infer<typeof apiEnv>>;

export const config: ApiConfig = loadConfig(apiEnv);
