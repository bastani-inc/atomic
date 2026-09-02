import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import type { InteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { GenerationBuffer } from "../../packages/coding-agent/src/modes/rpc/rpc-generation-buffer.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

/**
 * Engine death is host-local lifecycle state, not a wire event: a killed child
 * sends nothing. Two consequences are covered here against a real engine child.
 *
 *  - A child can exit between `start()` returning and the runtime attaching its
 *    listeners. A transient-only event would be lost there and the host would
 *    sit on a dead engine forever, so the terminal event is retained and
 *    replayed to a late subscriber.
 *  - Frames the dead generation left buffered must not be delivered afterwards.
 *    Component IDs restart at `remote_component_1` for every child, so a stale
 *    `engine_custom_open` would remount exactly the UI teardown just removed.
 */

const RETAINED_GENERATION_END_CAP_MS = 5_000;
const RETAINED_GENERATION_END_POLL_MS = 10;

async function waitForRetainedGenerationEnd(client: RpcClient): Promise<void> {
	const deadline = Date.now() + RETAINED_GENERATION_END_CAP_MS;
	while (Date.now() < deadline) {
		let replayed = false;
		const unsubscribe = client.onGenerationEnded(() => {
			replayed = true;
		});
		unsubscribe();
		if (replayed) return;
		await sleep(RETAINED_GENERATION_END_POLL_MS);
	}
	throw new Error(`generation end was not retained within ${RETAINED_GENERATION_END_CAP_MS} ms`);
}

function startupCustomUiClient(): RpcClient {
	return new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
		provider: "isolation-fixture",
		model: "blocking-model",
		env: { ATOMIC_STARTUP_CUSTOM_UI: "1" },
		args: [
			"--no-session",
			"--no-extensions",
			"--extension",
			join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
}

async function waitForEnginePid(client: RpcClient): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const pid = client.getEnginePid();
		if (pid !== undefined) return pid;
		await sleep(10);
	}
	throw new Error("engine child never reported its pid");
}

test.sequential("a child that exits before the host subscribes still reports its death exactly once", async () => {
	const client = startupCustomUiClient();
	try {
		await client.start();
		const pid = await waitForEnginePid(client);
		process.kill(pid, "SIGKILL");
		// Let the exit land with nobody listening yet — the startup-window race.
		for (let attempt = 0; attempt < 200 && client.getStderr() !== undefined; attempt += 1) {
			await sleep(10);
			try {
				process.kill(pid, 0);
			} catch {
				break;
			}
		}
		// Process death and Node's child-exit callback are separate observations on
		// loaded runners. Probe until replay begins; subscriptions do not consume the
		// retained event, which the independent assertions below verify.
		await waitForRetainedGenerationEnd(client);
		const seen: InteractiveEngineGenerationEnded[] = [];
		const unsubscribe = client.onGenerationEnded((event) => seen.push(event));
		assert.equal(seen.length, 1, "a death that already happened must replay to a late subscriber");
		assert.equal(seen[0]!.expected, false);
		assert.equal(seen[0]!.kind, "exit");

		// A second subscriber sees the same retained event; the first sees nothing new.
		const second: InteractiveEngineGenerationEnded[] = [];
		client.onGenerationEnded((event) => second.push(event));
		assert.equal(second.length, 1);
		assert.equal(seen.length, 1, "the retained event must not re-fire on the existing listener");
		unsubscribe();
	} finally {
		await client.stop();
	}
}, 30_000);

test.sequential("a dead generation's buffered custom-UI frames are never delivered", async () => {
	const client = startupCustomUiClient();
	try {
		await client.start();
		const pid = await waitForEnginePid(client);
		// The fixture opens a custom UI during startup; with no host controller
		// attached yet it is buffered. That buffer belongs to this generation.
		await sleep(150);
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			// Under full-suite load the engine child can already be gone by the
			// time the kill lands; an early death is still this generation dying,
			// which is exactly the state the assertions below examine.
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await sleep(150);

		const messages: InteractiveEngineMessage[] = [];
		const deaths: InteractiveEngineGenerationEnded[] = [];
		client.onGenerationEnded((event) => deaths.push(event));
		client.onInteractiveEngineMessage((message) => messages.push(message));
		assert.equal(deaths.length, 1, "the death must still be observable");
		assert.deepEqual(
			messages.filter((message) => message.type === "engine_custom_open"),
			[],
			"a stale mount frame would remount the UI that death teardown just closed",
		);
	} finally {
		await client.stop();
	}
}, 30_000);

test("the generation buffer keeps live frames and forgets dead ones", () => {
	const buffer = new GenerationBuffer<string>();
	buffer.push(1, "gen-1-open");
	buffer.push(2, "gen-2-open");
	buffer.dropGeneration(1);
	assert.equal(buffer.size, 1);
	assert.deepEqual(buffer.drain(2), ["gen-2-open"], "a newer generation's frames survive stale cleanup");
	assert.equal(buffer.size, 0, "drained entries are never requeued");

	buffer.push(3, "gen-3-open");
	assert.deepEqual(buffer.drain(4), [], "frames for a replaced generation are discarded, not delivered");
	assert.equal(buffer.size, 0);
});
