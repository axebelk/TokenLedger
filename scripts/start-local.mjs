#!/usr/bin/env node
/**
 * TokenTrail — from-source launcher (no Docker required).
 *
 * Starts worker, API, gateway, and the built console against an existing
 * PostgreSQL and Redis. Runs migrations + pricing seed first. Console is
 * served single-origin on PORT (default 8080) and proxies /api and /gw.
 *
 *   node scripts/start-local.mjs
 *
 * Requires .env with DATABASE_URL, REDIS_URL, JWT_SECRET, TOKENTRAIL_MASTER_KEY.
 * Reads .env automatically. Ctrl-C stops everything.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = join(root, ".env");
if (!existsSync(envPath)) {
  console.error("Missing .env — copy .env.example to .env and fill the secrets.");
  process.exit(1);
}
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !line.trimStart().startsWith("#")) process.env[m[1]] ??= m[2];
}
const required = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "TOKENTRAIL_MASTER_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  process.exit(1);
}
process.env.NODE_ENV ??= "production";
const PORT = process.env.PORT ?? "8080";
process.env.API_PORT ??= "4000";
process.env.GATEWAY_PORT ??= "4100";
process.env.PUBLIC_BASE_URL ??= `http://localhost:${PORT}`;

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
function run(args, opts = {}) {
  const r = spawnSync(pnpm, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) { console.error(`\n✗ \`pnpm ${args.join(" ")}\` failed`); process.exit(1); }
}

console.log("→ Applying database migrations…");
run(["--filter", "@tokentrail/db", "exec", "prisma", "migrate", "deploy"]);
console.log("→ Seeding pricing catalog…");
run(["--filter", "@tokentrail/db", "run", "seed"]);
console.log("→ Building console…");
run(["--filter", "@tokentrail/web", "build"]);

// ── Launch services ──────────────────────────────────────────────────────────
const children = [];
function start(name, cwd, args) {
  const child = spawn(pnpm, args, { cwd: join(root, cwd), stdio: "inherit", shell: process.platform === "win32", env: process.env });
  child.on("exit", (code) => {
    if (!stopping) { console.error(`\n✗ ${name} exited (${code}); shutting down`); stop(1); }
  });
  children.push({ name, child });
  console.log(`✓ ${name} started`);
}

start("worker", "apps/worker", ["exec", "tsx", "src/main.ts"]);
start("api", "apps/api", ["exec", "tsx", "src/main.ts"]);
start("gateway", "apps/gateway", ["exec", "tsx", "src/main.ts"]);
start("console", "apps/web", ["exec", "vite", "preview", "--port", PORT, "--host"]);

console.log(`\n🚀 TokenTrail is up:\n   Console : http://localhost:${PORT}\n   Gateway : http://localhost:${PORT}/gw/{provider}/…\n   Press Ctrl-C to stop.\n`);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) child.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
