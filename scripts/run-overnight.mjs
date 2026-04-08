#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { hours: 8, pollSeconds: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === "--hours" || a === "-h") && argv[i + 1]) {
      out.hours = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if ((a === "--poll-seconds" || a === "-p") && argv[i + 1]) {
      out.pollSeconds = Number(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function fetchDeepHealth() {
  const res = await fetch("http://localhost:4000/health/deep");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const { hours, pollSeconds } = parseArgs(process.argv.slice(2));
if (!Number.isFinite(hours) || hours <= 0) {
  console.error("Invalid --hours value. Example: --hours 8");
  process.exit(1);
}
if (!Number.isFinite(pollSeconds) || pollSeconds < 5) {
  console.error("Invalid --poll-seconds value. Use 5 or greater.");
  process.exit(1);
}

const logRoot = path.join(root, "logs");
ensureDir(logRoot);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const runDir = path.join(logRoot, `overnight-${stamp}`);
ensureDir(runDir);
const watchdogLog = path.join(runDir, "watchdog.log");

function logWatchdog(line) {
  fs.appendFileSync(watchdogLog, `[${nowIso()}] ${line}\n`, "utf8");
// ── DB snapshot before services start ────────────────────────────────────────
// Copies dev.db into the overnight log folder so every run has a forensic
// archive of exactly what state the DB was in at session start.
const dbPath = path.join(root, "packages", "db", "prisma", "dev.db");
if (fs.existsSync(dbPath)) {
  const snapshotPath = path.join(runDir, "dev.db.snapshot");
  try {
    fs.copyFileSync(dbPath, snapshotPath);
    console.log(`DB snapshot saved: ${snapshotPath}`);
  } catch (err) {
    console.warn(`DB snapshot failed (non-fatal): ${err.message}`);
  }
} else {
  console.warn(`DB not found at ${dbPath} — skipping snapshot`);
}

}

const services = [
  { name: "api-server", filter: "@copybot/api-server" },
  { name: "bot-worker", filter: "@copybot/bot-worker" },
  { name: "guardian-worker", filter: "@copybot/guardian-worker" },
  { name: "dashboard", filter: "@copybot/dashboard" }
];

const pnpmCmd = getPnpmCommand();

function startService(service) {
  const outPath = path.join(runDir, `${service.name}.out.log`);
  const errPath = path.join(runDir, `${service.name}.err.log`);
  const outFd = fs.openSync(outPath, "a");
  const errFd = fs.openSync(errPath, "a");
  const cmd = `${pnpmCmd} --filter ${service.filter} dev`;

  const child = spawn(cmd, {
    cwd: root,
    shell: true,
    stdio: ["ignore", outFd, errFd]
  });

  return { child, outFd, errFd };
}

function stopService(entry, name) {
  if (!entry || !entry.child || entry.child.killed) return;
  try {
    entry.child.kill("SIGTERM");
  } catch {
    // Ignore termination failures in shutdown path.
  }
  logWatchdog(`STOPPED ${name}`);
}

const running = new Map();

for (const svc of services) {
  const entry = startService(svc);
  running.set(svc.name, entry);
  logWatchdog(`STARTED ${svc.name} pid=${entry.child.pid}`);
}

logWatchdog(`RUN_DIR ${runDir}`);
console.log(`Overnight soak started. Logs: ${runDir}`);

const deadlineMs = Date.now() + hours * 60 * 60 * 1000;
let stopRequested = false;

process.on("SIGINT", () => {
  stopRequested = true;
  logWatchdog("INTERRUPTED_BY_USER SIGINT");
});
process.on("SIGTERM", () => {
  stopRequested = true;
  logWatchdog("INTERRUPTED_BY_USER SIGTERM");
});

while (Date.now() < deadlineMs && !stopRequested) {
  await sleep(pollSeconds * 1000);

  for (const svc of services) {
    const entry = running.get(svc.name);
    if (!entry) continue;
    const { child } = entry;
    if (child.exitCode !== null || child.signalCode !== null) {
      logWatchdog(`PROCESS_EXITED ${svc.name} code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}`);
      const restarted = startService(svc);
      running.set(svc.name, restarted);
      logWatchdog(`PROCESS_RESTARTED ${svc.name} pid=${restarted.child.pid}`);
    }
  }

  try {
    const health = await fetchDeepHealth();
    logWatchdog(`health.ok=${Boolean(health.ok)} heartbeatAgeMs=${health.heartbeatAgeMs ?? "null"} queueDepth=${health.queueDepth ?? "null"}`);
    if (!health.ok) {
      logWatchdog("HEALTH_DEGRADED");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWatchdog(`HEALTH_CHECK_FAILED ${msg}`);
  }
}

for (const svc of services) {
  stopService(running.get(svc.name), svc.name);
}

logWatchdog("OVERNIGHT_RUN_COMPLETE");
console.log(`Overnight soak complete. Logs: ${runDir}`);
