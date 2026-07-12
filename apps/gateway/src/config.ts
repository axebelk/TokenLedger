import { z } from "zod";
import { baseEnv, gatewayEnv, loadConfig, redisEnv } from "@tokentrail/config";

const env = baseEnv
  .merge(redisEnv)
  .merge(gatewayEnv)
  .extend({
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    // When set, VK auth + credentials come from Postgres (raw pg, cache in
    // front); otherwise the gateway runs on empty in-memory stores (dev only).
    DATABASE_URL: z.string().optional(),
    TOKENTRAIL_MASTER_KEY: z.string().min(32).optional(),
  });

export type GatewayConfig = Readonly<z.infer<typeof env>>;

export const config: GatewayConfig = loadConfig(env);
