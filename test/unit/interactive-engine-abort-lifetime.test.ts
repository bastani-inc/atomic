import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { bunExecutable, moduleDir, sleep, spawnSyncCollect } from "../helpers/runtime.js";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;
/** Real Bun CLI startup, engine binding, signal handling, and bounded process-tree teardown. */
const REAL_CLI_ENGINE_TIMEOUT_MS = 30_000;
/** SIGSTOP delivery is asynchronous; allow a loaded kernel to report the child stopped. */
const ENGINE_STOP_CONFIRMATION_TIMEOUT_MS = 5_000;
const ENGINE_STOP_STATE_POLL_MS = 20;

async function waitUntilProcessStopped(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastState = "unknown";
	while (Date.now() < deadline) {
		const result = spawnSyncCollect(["ps", "-o", "state=", "-p", String(pid)]);
		lastState = result.stdout.toString("utf8").trim() || `ps exit ${result.exitCode}`;
		if (lastState.startsWith("T")) return;
		await sleep(ENGINE_STOP_STATE_POLL_MS);
	}
	throw new Error(`engine child ${pid} did not stop within ${timeoutMs} ms (last state: ${lastState})`);
}

/**
 * Escape's contract is an unbounded cooperative wait. `abort` used to fall under
 * the generic 30-second request deadline, so a SIGSTOPped or blocked child made
 * Escape surface a red `Timeout waiting for response to abort` — a host-side
 * deadline masquerading as an engine failure.
 *
 * Failure detection is unaffected: the request still rejects on child exit,
 * transport failure, generation replacement, and explicit stop.
 */
function makeClient(agentDir: string, requestTimeoutMs: number): RpcClient {
	return new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
		env: { ATOMIC_CODING_AGENT_DIR: agentDir },
		provider: "isolation-fixture",
		model: "blocking-model",
		requestTimeoutMs,
		args: [
			"--no-session",
			"--no-extensions",
			"--extension",
			join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
			"--approve",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
}

serialTest(
	"a pending abort outlives the generic request deadline and rejects only on stop",
	async () => {
		// Startup touches the trust store after engine_ready; an ambient agent dir
		// lets parallel real-CLI tests turn that short critical section into ELOCKED.
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-abort-lifetime-"));
		const client = makeClient(agentDir, 60);
		try {
			await client.start();
			// engine_ready intentionally precedes session binding. Wait for bound so
			// startup has finished before this test freezes the RPC loop.
			await client.waitForInteractiveEngineBound();

			// The real child owns the RPC loop and reports its own process.pid.
			const enginePid = client.getEnginePid();
			assert.ok(enginePid, "engine child never reported its pid");
			let resumed = false;
			// A SIGSTOPped child cannot answer a stop request, and a failed assertion
			// between here and the resume below would leak it: frozen, unkillable by the
			// client, and still holding this process's stdio pipes — the same leak class
			// that hung the Windows job. Teardown is unconditional for that reason.
			const resume = (): void => {
				if (resumed) return;
				resumed = true;
				try {
					process.kill(enginePid, "SIGCONT");
				} catch {
					// Already gone: nothing to resume, and stop() below is idempotent.
				}
			};
			try {
				// Freeze the child so it can never answer the cooperative abort.
				process.kill(enginePid, "SIGSTOP");
				await waitUntilProcessStopped(enginePid, ENGINE_STOP_CONFIRMATION_TIMEOUT_MS);
				let settled: "resolved" | "rejected" | undefined;
				let rejection: Error | undefined;
				const abort = client.abort().then(
					() => {
						settled = "resolved";
					},
					(error: Error) => {
						settled = "rejected";
						rejection = error;
					},
				);

				// Well past the configured deadline; a timed request would already be dead.
				await sleep(400);
				assert.equal(
					settled,
					undefined,
					`the cooperative abort must not time out (rejection: ${rejection?.message ?? "none"})`,
				);

				// An ordinary short command still honours the deadline, proving the timer is
				// live and only `abort` is exempt.
				await assert.rejects(() => client.getState(), /Timeout waiting for response to get_state/);

				// Arm termination while the child is frozen; resuming first lets its queued
				// abort response race ahead of the explicit stop on a loaded host.
				const stop = client.stop();
				resume();
				await stop;
				await abort;
				assert.equal(settled, "rejected", "explicit stop must settle the pending abort");
				assert.match(rejection?.message ?? "", /Agent process stopped/);
			} finally {
				resume();
			}
		} finally {
			await client.stop().catch(() => {});
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
	REAL_CLI_ENGINE_TIMEOUT_MS,
);
