/**
 * Handler for `atomic --ui-server` flag.
 *
 * Starts the atomic daemon (UI server) and either:
 * - Reports the existing daemon endpoint and exits (mode=existing)
 * - Starts a new daemon, prints endpoint JSON to stdout, and blocks forever (mode=new)
 */
import { Daemon } from "@bastani/atomic-sdk/runtime/daemon";
import { WorkflowRegistry } from "@bastani/atomic-sdk/runtime/registry";
import { RunManager } from "@bastani/atomic-sdk/runtime/run-manager";
import { Supervisor } from "@bastani/atomic-sdk/runtime/supervisor";
import { VERSION } from "../../version.ts";

export async function runUiServer(): Promise<void> {
  let sdkVersion = "0.0.0";
  try {
    // Read the SDK version from its package.json without a problematic import
    const { readFileSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const sdkPkgPath = require.resolve("@bastani/atomic-sdk/package.json");
    const raw = readFileSync(sdkPkgPath, "utf-8");
    sdkVersion = (JSON.parse(raw) as { version: string }).version;
  } catch {
    // Fall back to "0.0.0" if the package.json read fails.
  }

  const workflows = new WorkflowRegistry();
  const runs = new RunManager();
  // Supervisor implements all ISupervisor methods; cast to satisfy the interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supervisor = new Supervisor() as any;

  const daemon = new Daemon({
    workflows,
    runs,
    supervisor,
    atomicVersion: VERSION,
    sdkVersion,
  });

  const { mode, endpoint } = await daemon.start();

  if (mode === "existing") {
    process.stdout.write(JSON.stringify({
      status: "existing",
      port: endpoint.port,
      host: endpoint.host,
      pid: endpoint.pid,
    }) + "\n");
    process.exit(0);
  }

  // mode === "new": print started status and block forever.
  process.stdout.write(JSON.stringify({
    status: "started",
    port: endpoint.port,
    host: endpoint.host,
    pid: process.pid,
  }) + "\n");

  // Block forever — daemon's signal handlers (SIGTERM/SIGINT/SIGHUP) will stop the process.
  await new Promise(() => {});
}
