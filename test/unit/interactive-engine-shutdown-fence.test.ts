/**
 * Disposal must fence an in-flight replacement.
 *
 * A recovery attempt sits between its own stop and its spawn with no child
 * attached, so a disposal-time `stop()` saw nothing to do and returned. The
 * attempt then resumed and started a fresh engine after teardown had finished —
 * a child, and a host initialization, outliving the session that owned them.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ActivityWatchdogDiagnostic } from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import { EngineHealthController } from "../../packages/coding-agent/src/modes/interactive-engine/engine-health.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { RESTART_CANCELLED_MESSAGE } from "../../packages/coding-agent/src/modes/rpc/rpc-command-timeouts.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ended(): InteractiveEngineGenerationEnded {
	return {
		generation: 1,
		error: new Error("Agent process exited (code=null signal=SIGKILL). Stderr: "),
		kind: "exit",
		expected: false,
	};
}

function createBlockingClient(): RpcClient {
	return new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
		provider: "isolation-fixture",
		model: "blocking-model",
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

function createIsolatedRuntime(harness: Harness, client: RpcClient): IsolatedInteractiveRuntime {
	const localRuntime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			settingsManager: harness.settingsManager,
		} as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	return new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused runtime factory");
		},
		client,
	);
}

test("shutdown stops the child, joins the in-flight attempt, and reports no failure", async () => {
	const calls = { stops: 0, restarts: 0 };
	const diagnostics: ActivityWatchdogDiagnostic[] = [];
	let failRestart!: (error: Error) => void;
	const controller = new EngineHealthController({
		stop: async () => {
			calls.stops += 1;
		},
		restart: () =>
			new Promise<void>((_, reject) => {
				failRestart = reject;
			}),
		clearActivity: () => {},
	});
	controller.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));

	controller.handleGenerationEnded(ended());
	assert.equal(controller.isRecovering(), true);
	assert.equal(calls.restarts, 0);

	let shutdownSettled = false;
	const shutdown = controller.shutdown().then(() => {
		shutdownSettled = true;
	});
	await sleep(10);
	assert.equal(calls.stops, 1, "shutdown must stop the current child, voiding the restart permit");
	assert.equal(shutdownSettled, false, "shutdown must not return while the attempt is still running");

	// The stop cancelled the attempt; that failure is expected, not reportable.
	failRestart(new Error(RESTART_CANCELLED_MESSAGE));
	await shutdown;
	assert.equal(shutdownSettled, true);
	assert.equal(controller.isRecovering(), false);
	assert.deepEqual(
		diagnostics.filter((diagnostic) => diagnostic.message.includes("restart failed")),
		[],
		"a cancelled attempt must not be reported as a failure",
	);
	assert.equal(controller.needsExplicitTermination(), false, "shutdown must not arm the Ctrl+C rescue");

	// Nothing may start after shutdown.
	controller.handleGenerationEnded(ended());
	await sleep(10);
	assert.equal(controller.isRecovering(), false);
	assert.equal(await controller.shutdown(), undefined, "shutdown is idempotent");
});

test("a generation that dies after shutdown starts no replacement", async () => {
	const calls = { restarts: 0 };
	const controller = new EngineHealthController({
		stop: async () => {},
		restart: async () => {
			calls.restarts += 1;
		},
		clearActivity: () => {},
	});
	await controller.shutdown();
	controller.handleGenerationEnded(ended());
	await sleep(10);
	assert.equal(calls.restarts, 0);
});

serialTest(
	"an explicit stop during a restart prevents the replacement from spawning",
	async () => {
		const client = new RpcClient({
			cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
			cwd: join(moduleDir(import.meta.url), "../.."),
			runtimeExecutable: bunExecutable(),
			provider: "isolation-fixture",
			model: "blocking-model",
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
		try {
			await client.start();
			const firstPid = client.getEnginePid();
			assert.ok(firstPid, "engine child never reported its pid");
			// Both in the same turn: the restart is awaiting its own child's
			// termination, so this stop finds no process at all — exactly the window
			// where disposal used to return and let the replacement spawn afterwards.
			const restart = client.restart(undefined).then(
				() => undefined,
				(error: unknown) => error,
			);
			const stopped = client.stop();
			const outcome = await restart;
			await stopped;

			assert.ok(outcome instanceof Error, "a superseded restart must not report success");
			assert.match((outcome as Error).message, /restart cancelled/i);
			await sleep(250);
			// The client only reports a pid when a child announces readiness, so an
			// unchanged pid means no replacement ever started.
			assert.equal(client.getEnginePid(), firstPid, "a replacement child was spawned after disposal");
			assert.equal(isAlive(firstPid), false, "the original child outlived the stop");
		} finally {
			await client.stop();
		}
	},
	60_000,
);

serialTest(
	"a second stop after restart begins still cancels the replacement",
	async () => {
		const client = createBlockingClient();
		try {
			await client.start();
			const firstPid = client.getEnginePid();
			assert.ok(firstPid, "engine child never reported its pid");

			const firstStop = client.stop();
			const restart = client.restart(undefined).then(
				() => undefined,
				(error: unknown) => error,
			);
			// Let restart() run up to its stop fence without letting the first stop finish: restart takes
			// its permit synchronously and reaches the fence within a few microtasks, while the first
			// stop cannot finish before the child's exit arrives as I/O. A timer here could oversleep
			// under load until the first stop had finished, so the second stop would start a new one.
			for (let turn = 0; turn < 10; turn++) await Promise.resolve();
			const secondStop = client.stop();
			assert.strictEqual(secondStop, firstStop, "concurrent stops must share the teardown");

			await firstStop;
			const outcome = await restart;
			await sleep(250);
			const observedPid = client.getEnginePid();
			assert.equal(
				observedPid,
				firstPid,
				`a replacement child was spawned after the second stop (firstPid=${firstPid}, observedPid=${observedPid})`,
			);
			assert.ok(outcome instanceof Error, "a superseded restart must not report success");
			assert.match((outcome as Error).message, /restart cancelled/i);
			assert.equal(isAlive(firstPid), false, "the original child outlived the stop");
		} finally {
			await client.stop();
		}
	},
	60_000,
);

serialTest(
	"isolated runtime disposal leaves no child after an overlapping replacement",
	async () => {
		const harness = await createHarness();
		const client = createBlockingClient();
		const runtime = createIsolatedRuntime(harness, client);
		try {
			await client.start();
			const firstPid = client.getEnginePid();
			assert.ok(firstPid, "engine child never reported its pid");

			const firstStop = client.stop();
			const restart = client.restart(undefined).then(
				() => undefined,
				(error: unknown) => error,
			);
			const disposal = runtime.dispose();

			await firstStop;
			await disposal;
			const outcome = await restart;
			await sleep(250);
			const observedPid = runtime.getEnginePid();
			assert.equal(
				observedPid,
				firstPid,
				`a replacement child survived disposal (firstPid=${firstPid}, observedPid=${observedPid})`,
			);
			assert.ok(outcome instanceof Error, "disposal must cancel an overlapping restart");
			assert.match((outcome as Error).message, /restart cancelled/i);
			assert.equal(isAlive(firstPid), false, "the original child outlived disposal");
		} finally {
			await runtime.dispose();
			harness.cleanup();
		}
	},
	60_000,
);
