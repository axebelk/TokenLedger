import { config } from "./config.js";
import { buildServer } from "./server.js";

const { app, prisma, redis } = await buildServer(config);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down: draining connections");
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
app.log.info(`TokenTrail API listening on :${config.API_PORT}`);
