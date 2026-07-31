import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;

/**
 * Escape's contract is an unbounded cooperative wait. `abort` used to fall under
 * the generic 30-second request deadline, so a SIGSTOPped or blocked child made
 * Escape surface a red `Timeout waiting for response to abort` — a host-side
 * deadline masquerading as an engine failure.
 *
 * Failure detection is unaffected: the request still rejects on child exit,
 * transport failure, generation replacement, and explicit stop.
 */
function makeClient(requestTimeoutMs: number): RpcClient {
	return new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
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
		const client = makeClient(60);
		await client.start();
		// start() already waited for engine_ready, so the pid is recorded by now.
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
			assert.equal(settled, undefined, "the cooperative abort must not time out");

			// An ordinary short command still honours the deadline, proving the timer is
			// live and only `abort` is exempt.
			await assert.rejects(() => client.getState(), /Timeout waiting for response to get_state/);

			resume();
			await client.stop();
			await abort;
			assert.equal(settled, "rejected", "explicit stop must settle the pending abort");
			assert.match(rejection?.message ?? "", /Agent process stopped/);
		} finally {
			resume();
			await client.stop().catch(() => {});
		}
	},
	30_000,
);
