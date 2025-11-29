// Single-process entrypoint to avoid SQLite locking between separate processes.
// Starts the daemon loop and the dashboard server within one Node process,
// sharing the same DB connection instance.
import "./paper-daemon.js";
import "./dashboard.js";
