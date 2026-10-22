import { Worker } from "node:worker_threads";

export const BROKER_WATCHDOG_INTERVAL_MS = 2_000;
export const BROKER_WATCHDOG_PROBE_TIMEOUT_MS = 10_000;
export const BROKER_WATCHDOG_SILENCE_MS = 60_000;

const WATCHDOG_SOURCE = `
const { workerData } = require("node:worker_threads");
const { connect } = require("node:net");
const { randomUUID } = require("node:crypto");
const { writeFileSync } = require("node:fs");
let lastHealthyAt = performance.now();
let consecutiveFailures = 0;

function probe() {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const socket = connect(workerData.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(failure);
    };
    const timer = setTimeout(() => finish("response-timeout"), workerData.probeTimeoutMs);
    socket.on("error", () => finish("connection-error"));
    socket.on("close", () => finish("connection-closed"));
    socket.on("connect", () => {
      const payload = Buffer.from(JSON.stringify({ type: "health", requestId }));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length);
      try { socket.write(Buffer.concat([header, payload])); }
      catch { finish("write-error"); }
    });
    socket.on("data", (data) => {
      if (buffer.length + data.length > 1024) return finish("oversized-response");
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > 1020) return finish("oversized-response");
      if (buffer.length < length + 4) return;
      try {
        const reply = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        if (reply.type !== "health" || reply.requestId !== requestId) return finish("unexpected-response");
        if (reply.instanceId !== workerData.instanceId) return finish("different-broker-instance");
        finish();
      } catch { finish("invalid-response"); }
    });
  });
}

async function check() {
  const failure = await probe();
  if (failure === undefined) {
    lastHealthyAt = performance.now();
    consecutiveFailures = 0;
  } else {
    consecutiveFailures += 1;
    const silentForMs = Math.round(performance.now() - lastHealthyAt);
    if (consecutiveFailures >= 3 && silentForMs >= workerData.silenceMs) {
      try {
        writeFileSync(workerData.logPath, JSON.stringify({
          at: new Date().toISOString(), pid: process.pid, instanceId: workerData.instanceId,
          reason: "Intercom broker stopped answering health requests; terminating for recovery",
          failure, consecutiveFailures, silentForMs
        }) + "\\n", { mode: 0o600 });
      } catch {}
      process.kill(process.pid, "SIGKILL");
      return;
    }
  }
  setTimeout(check, workerData.intervalMs);
}
setTimeout(check, workerData.intervalMs);
`;

export function startBrokerWatchdog(socketPath: string, instanceId: string, logPath: string): void {
	try {
		const worker = new Worker(WATCHDOG_SOURCE, {
			eval: true,
			workerData: {
				socketPath,
				instanceId,
				logPath,
				intervalMs: BROKER_WATCHDOG_INTERVAL_MS,
				probeTimeoutMs: BROKER_WATCHDOG_PROBE_TIMEOUT_MS,
				silenceMs: BROKER_WATCHDOG_SILENCE_MS,
			},
		});
		let failed = false;
		worker.on("error", (error) => {
			failed = true;
			console.error("Intercom broker watchdog unavailable:", error);
		});
		worker.on("exit", (code) => {
			if (!failed) console.error(`Intercom broker watchdog exited unexpectedly with code ${code}`);
		});
		worker.unref();
	} catch (error) {
		console.error("Intercom broker watchdog unavailable:", error);
	}
}
