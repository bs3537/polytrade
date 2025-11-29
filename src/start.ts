// Launch dashboard (HTTP) and paper daemon as separate Node processes so the
// dashboard stays responsive even while the paper simulator runs blocking
// SQLite work. Render expects a single command; this file coordinates both
// children and exits if either dies.
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const node = process.execPath;

const child = (label: string, target: string) => {
  const proc = spawn(node, [target], { stdio: "inherit" });
  proc.on("exit", (code, signal) => {
    console.error(`${label} exited (code=${code} signal=${signal ?? "none"})`);
    process.exit(code ?? 1);
  });
  return proc;
};

const dashboardPath = path.resolve(__dirname, "dashboard.js");
const daemonPath = path.resolve(__dirname, "paper-daemon.js");

const dashboard = child("dashboard", dashboardPath);
const daemon = child("paper-daemon", daemonPath);

// Forward termination signals to both children for clean shutdown on Render.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    dashboard.kill(sig);
    daemon.kill(sig);
    process.exit(0);
  });
}
