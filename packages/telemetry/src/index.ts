import { pino, type Logger } from "pino";
import { Registry, collectDefaultMetrics } from "prom-client";

export type { Logger };

/** Redaction paths applied to every service logger — secrets never hit logs. */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers['x-api-key']",
  "*.secret",
  "*.password",
  "*.encryptedSecret",
];

export function createLogger(service: string, level = "info"): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function createMetricsRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}
