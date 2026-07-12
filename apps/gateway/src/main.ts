import { config } from "./config.js";
import { buildServer } from "./server.js";

const { app, redis, subscriber, pricingSource } = await buildServer(config);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down: draining in-flight proxies");
  pricingSource?.stop();
  await app.close();
  redis.disconnect();
  subscriber.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.GATEWAY_PORT, host: "0.0.0.0" });
app.log.info(`TokenTrail Gateway listening on :${config.GATEWAY_PORT}`);
