/**
 * Interactive mode runs its session in an engine process. The /settings background compaction rows must reach the
 * engine's session, and the host must mirror the engine's background compaction state with its typed error (#4330).
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { BackgroundCompactionState } from "../src/core/compaction/background-compaction.js";
import {
	BackgroundCompactionPlanningError,
	isBackgroundCompactionConfigError,
	serializeBackgroundCompactionError,
} from "../src/core/compaction/background-compaction-errors.js";
import type { ExtensionError } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { InteractiveEngineGenerationEnded } from "../src/modes/interactive-engine/engine-generation.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import type { RpcEvent, RpcSessionState } from "../src/modes/rpc/rpc-types.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { createHarness } from "./suite/harness.js";
import { createHarness as createFileSettingsHarness } from "./test-harness.js";

let pair: EngineHostPair | undefined;

afterEach(async () => {
	await pair?.cleanup();
	pair = undefined;
});

test("background compaction settings from the host reach the engine session (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	assert.equal(host.backgroundCompactionEnabled, true);
	assert.equal(host.backgroundCompactionThresholdPercent, 75);

	host.setBackgroundCompactionEnabled(false);
	host.setBackgroundCompactionThresholdPercent(60);
	assert.equal(host.backgroundCompactionEnabled, false);
	assert.equal(host.backgroundCompactionThresholdPercent, 60);
	await pair.drain();
	assert.equal(pair.engine.session.backgroundCompactionEnabled, false);
	assert.equal(pair.engine.session.backgroundCompactionThresholdPercent, 60);
	assert.equal(pair.engine.settingsManager.getCompactionBackground(), false);
});

test("the host mirrors the engine's background compaction state and typed error (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	assert.equal(host.compaction.state, "idle");
	const error = new BackgroundCompactionPlanningError({ upToEntryId: "m7", attempt: 2 }, { cause: new Error("boom") });

	pair.engineOutput({
		type: "background_compaction",
		compaction: {
			state: "failed",
			upToEntryId: "m7",
			startedAt: "2026-11-05T00:00:00.000Z",
			error: serializeBackgroundCompactionError(error),
		},
	});

	await vi.waitFor(() => assert.equal(host.compaction.state, "failed"));
	assert.equal(host.compaction.upToEntryId, "m7");
	assert.ok(host.compaction.error instanceof BackgroundCompactionPlanningError);
	assert.equal(host.compaction.error.attempt, 2);
});

test("the host adopts the engine's background compaction settings and state when it synchronizes (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	const diagnostics: string[] = [];
	pair.runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));
	pair.failCommand("set_background_compaction", "engine refused");
	pair.failCommand("set_background_compaction_threshold", "engine refused");
	host.setBackgroundCompactionEnabled(false);
	host.setBackgroundCompactionThresholdPercent(50);
	await pair.drain();
	assert.equal(pair.engine.session.backgroundCompactionEnabled, true);
	await vi.waitFor(() => assert.equal(diagnostics.length, 2));
	assert.deepEqual(diagnostics.sort(), [
		"Interactive engine set background compaction failed: engine refused",
		"Interactive engine set background compaction threshold failed: engine refused",
	]);
	const failure = new BackgroundCompactionPlanningError({ upToEntryId: "m3", attempt: 1 });
	(pair.engine.session as unknown as { _backgroundCompaction: { failure: object } })._backgroundCompaction.failure = {
		error: failure,
		upToEntryId: "m3",
		startedAt: "2026-11-05T00:00:00.000Z",
	};

	await pair.runtime.initializeFromEngine();

	assert.equal(host.backgroundCompactionEnabled, true, "the engine's setting wins");
	assert.equal(host.backgroundCompactionThresholdPercent, 75);
	assert.equal(host.compaction.state, "failed");
	assert.ok(host.compaction.error instanceof BackgroundCompactionPlanningError);
	assert.equal(host.compaction.upToEntryId, "m3");
});

function backgroundCompactionEvent(state: "running" | "ready" | "idle", upToEntryId?: string): object {
	return {
		type: "background_compaction",
		compaction: state === "idle" ? { state } : { state, upToEntryId, startedAt: "2026-11-05T00:00:00.000Z" },
	};
}

test("the host waits for the engine's background task and reports each saved result once (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	assert.deepEqual(await host.awaitBackgroundCompaction(), { state: "idle" }, "nothing to wait for while idle");
	const announced: BackgroundCompactionState[] = [];
	const unsubscribed: BackgroundCompactionState[] = [];
	host.onCompactionReady((state) => announced.push(state));
	host.onCompactionReady((state) => unsubscribed.push(state))();

	pair.engineOutput(backgroundCompactionEvent("running", "m4"));
	await pair.drain();
	assert.equal(host.compaction.state, "running");
	let settled: BackgroundCompactionState | undefined;
	const waiting = host.awaitBackgroundCompaction().then((state) => {
		settled = state;
	});
	await pair.drain();
	assert.equal(settled, undefined, "the engine's task is still running");
	pair.engineOutput(backgroundCompactionEvent("running", "m4"));
	await pair.drain();
	assert.equal(settled, undefined, "a repeated running state keeps the wait open");

	pair.engineOutput(backgroundCompactionEvent("ready", "m4"));
	await waiting;
	assert.equal(settled?.state, "ready");
	assert.equal(settled?.upToEntryId, "m4");
	assert.deepEqual(
		announced.map((state) => [state.state, state.upToEntryId]),
		[["ready", "m4"]],
	);

	pair.engineOutput(backgroundCompactionEvent("ready", "m4"));
	pair.engineOutput(backgroundCompactionEvent("idle"));
	pair.engineOutput(backgroundCompactionEvent("ready", "m9"));
	await pair.drain();
	assert.deepEqual(
		announced.map((state) => [state.state, state.upToEntryId]),
		[
			["ready", "m4"],
			["ready", "m9"],
		],
		"a result already reported is not reported again",
	);
	assert.deepEqual(unsubscribed, []);
});

test("an engine result needs no ready listener to settle the host state (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	const errors: ExtensionError[] = [];
	host.extensionRunner.onError((error) => errors.push(error));
	pair.engineOutput(backgroundCompactionEvent("ready", "m5"));
	await pair.drain();
	assert.equal(host.compaction.state, "ready");
	assert.deepEqual(errors, []);
});

test("a ready listener that throws is reported and does not stop the others (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	const errors: ExtensionError[] = [];
	host.extensionRunner.onError((error) => errors.push(error));
	const announced: string[] = [];
	host.onCompactionReady(() => {
		throw new Error("listener broke");
	});
	host.onCompactionReady(() => {
		throw "listener gave up";
	});
	host.onCompactionReady((state) => announced.push(state.upToEntryId ?? ""));

	pair.engineOutput(backgroundCompactionEvent("ready", "m5"));
	await pair.drain();

	assert.deepEqual(announced, ["m5"]);
	assert.deepEqual(
		errors.map(({ extensionPath, event, error, stack }) => ({
			extensionPath,
			event,
			error,
			stack: stack !== undefined,
		})),
		[
			{
				extensionPath: "<background_compaction>",
				event: "background_compaction",
				error: "listener broke",
				stack: true,
			},
			{
				extensionPath: "<background_compaction>",
				event: "background_compaction",
				error: "listener gave up",
				stack: false,
			},
		],
	);
});

test("disposing the host settles a wait on the engine's background task (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	pair.engineOutput(backgroundCompactionEvent("running", "m6"));
	await pair.drain();
	const waiting = host.awaitBackgroundCompaction();

	await pair.runtime.dispose();

	assert.deepEqual(await waiting, { state: "idle" });
});

async function createProbe() {
	const first = await createHarness();
	const second = await createHarness();
	const target = await SessionManager.create(first.session.sessionManager.getSessionStore(), second.tempDir);
	let emit: (event: RpcEvent) => void = () => {};
	let endGeneration: (event: InteractiveEngineGenerationEnded) => void = () => {};
	const state: RpcSessionState = {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: target.getSessionId(),
		autoCompactionEnabled: true,
		compaction: { state: "idle" },
		backgroundCompactionEnabled: true,
		backgroundCompactionThresholdPercent: 75,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
	};
	const client = {
		onEvent(listener: (event: RpcEvent) => void) {
			emit = listener;
			return () => {};
		},
		onGenerationEnded(listener: (event: InteractiveEngineGenerationEnded) => void) {
			endGeneration = listener;
			return () => {};
		},
		getGeneration: () => 1,
		switchSession: async () => ({ cancelled: false }),
		getState: async () => state,
		requestInternal: async <T>(): Promise<T> => ({ models: [], scopedModels: [] }) as T,
		getCommands: async () => [],
		getEntries: async () => ({ entries: [], leafId: null }),
		stop: async () => {},
	};
	const services = { cwd: first.tempDir, agentDir: first.tempDir, settingsManager: first.settingsManager };
	const runtime = new IsolatedInteractiveRuntime(
		new AgentSessionRuntime(first.session, services as never, async () => {
			throw new Error("unused runtime factory");
		}),
		async () => ({ session: second.session, services, diagnostics: [] }) as never,
		client as never,
	);
	return {
		runtime,
		client,
		second,
		target,
		state,
		emit: (event: object) => emit(event as RpcEvent),
		endGeneration: (generation: number) =>
			endGeneration({ generation, error: new Error("engine exited"), kind: "exit", expected: true }),
		cleanup: () => {
			first.cleanup();
			second.cleanup();
		},
	};
}

test("a disposed host ignores late engine compaction notifications (#4330)", async () => {
	const probe = await createProbe();
	try {
		const announced: string[] = [];
		probe.runtime.session.onCompactionReady((state) => announced.push(state.upToEntryId ?? ""));
		probe.emit(backgroundCompactionEvent("running", "m1"));
		await probe.runtime.dispose();
		probe.emit(backgroundCompactionEvent("ready", "m1"));
		assert.deepEqual(announced, []);
	} finally {
		probe.cleanup();
	}
});

test("a replaced host session stops waiting for and hearing the engine's background compaction (#4330)", async () => {
	const probe = await createProbe();
	try {
		probe.state.compaction = { state: "running", upToEntryId: "n2", startedAt: "2026-11-05T00:00:00.000Z" };
		const replaced = probe.runtime.session;
		const heardByReplaced: string[] = [];
		replaced.onCompactionReady((ready) => heardByReplaced.push(ready.upToEntryId ?? ""));
		probe.emit(backgroundCompactionEvent("running", "m1"));
		const waiting = replaced.awaitBackgroundCompaction();

		await probe.runtime.switchSession(probe.target.getSessionId());

		assert.equal(probe.runtime.session, probe.second.session);
		assert.equal(probe.runtime.session.compaction.state, "running", "the new session's engine task is running");
		assert.deepEqual(await waiting, { state: "idle" }, "the replaced session has no engine task");
		assert.deepEqual(await replaced.awaitBackgroundCompaction(), { state: "idle" });
		const heardByCurrent: string[] = [];
		probe.runtime.session.onCompactionReady((ready) => heardByCurrent.push(ready.upToEntryId ?? ""));
		probe.emit(backgroundCompactionEvent("ready", "n2"));
		assert.deepEqual(heardByCurrent, ["n2"]);
		assert.deepEqual(heardByReplaced, []);
	} finally {
		probe.cleanup();
	}
});

test("a session that inherits a reported ready result still reports it after the switch (#4330)", async () => {
	const probe = await createProbe();
	try {
		const heardByFirst: string[] = [];
		probe.runtime.session.onCompactionReady((ready) => heardByFirst.push(ready.upToEntryId ?? ""));
		probe.emit(backgroundCompactionEvent("ready", "m2"));
		await probe.runtime.switchSession(probe.target.getSessionId());
		const heardBySecond: string[] = [];
		probe.runtime.session.onCompactionReady((ready) => heardBySecond.push(ready.upToEntryId ?? ""));

		probe.emit(backgroundCompactionEvent("ready", "m2"));

		assert.deepEqual(heardByFirst, ["m2"]);
		assert.deepEqual(heardBySecond, ["m2"]);
	} finally {
		probe.cleanup();
	}
});

test("a wait on the engine's background task settles when that engine generation ends (#4330)", async () => {
	const probe = await createProbe();
	try {
		const host = probe.runtime.session;
		const resourceCounts: number[] = [];
		probe.runtime.onResourceExtensionsChanged((extensions) => resourceCounts.push(extensions.length));
		probe.emit(backgroundCompactionEvent("running", "m1"));
		const waiting = host.awaitBackgroundCompaction();

		probe.endGeneration(2);
		assert.equal(host.compaction.state, "running", "an older generation's end leaves the current task alone");
		probe.endGeneration(1);

		assert.deepEqual(await waiting, { state: "idle" });
		assert.equal(host.compaction.state, "idle");
		assert.deepEqual(resourceCounts, [0], "the retired engine's resources are cleared");
	} finally {
		probe.cleanup();
	}
});

test("a ready result the host learns of by resynchronizing is reported once (#4330)", async () => {
	const probe = await createProbe();
	try {
		const host = probe.runtime.session;
		probe.state.sessionId = host.sessionId;
		probe.state.backgroundCompactionEnabled = false;
		await probe.runtime.initializeFromEngine();
		const announced: string[] = [];
		host.onCompactionReady((ready) => {
			assert.equal(host.backgroundCompactionEnabled, true);
			assert.equal(host.backgroundCompactionThresholdPercent, 60);
			announced.push(ready.upToEntryId ?? "");
		});
		probe.emit(backgroundCompactionEvent("running", "m3"));
		const waiting = host.awaitBackgroundCompaction();
		probe.state.backgroundCompactionEnabled = true;
		probe.state.backgroundCompactionThresholdPercent = 60;
		probe.state.compaction = { state: "ready", upToEntryId: "m3", startedAt: "2026-11-05T00:00:00.000Z" };

		await probe.runtime.initializeFromEngine();
		await probe.runtime.initializeFromEngine();
		probe.emit(backgroundCompactionEvent("ready", "m3"));

		assert.equal((await waiting).state, "ready");
		assert.deepEqual(announced, ["m3"]);
	} finally {
		probe.cleanup();
	}
});

test.each(
	(["ready", "idle", "running"] as const).flatMap((newerState) =>
		(["getState", "requestInternal"] as const).map((delayedResponse) => ({ newerState, delayedResponse })),
	),
)(
	"engine initialization preserves a newer $newerState compaction event while $delayedResponse waits (#4330)",
	async ({ newerState, delayedResponse }) => {
		const probe = await createProbe();
		try {
			const host = probe.runtime.session;
			probe.state.sessionId = host.sessionId;
			probe.state.compaction = { state: "running", upToEntryId: "m1", startedAt: "2026-11-05T00:00:00.000Z" };
			let releaseResponse!: () => void;
			const responseGate = new Promise<void>((resolve) => {
				releaseResponse = resolve;
			});
			const requestState = vi.spyOn(probe.client, "getState").mockImplementationOnce(async () => {
				if (delayedResponse === "getState") await responseGate;
				return probe.state;
			});
			const requestCatalog = vi.spyOn(probe.client, "requestInternal").mockImplementationOnce(async () => {
				if (delayedResponse === "requestInternal") await responseGate;
				return { models: [], scopedModels: [] } as never;
			});
			const announced: string[] = [];
			host.onCompactionReady((state) => announced.push(state.upToEntryId ?? ""));
			const initializing = probe.runtime.initializeFromEngine();
			await vi.waitFor(() =>
				assert.equal((delayedResponse === "getState" ? requestState : requestCatalog).mock.calls.length, 1),
			);
			probe.emit(backgroundCompactionEvent(newerState, "m2"));
			releaseResponse();
			await initializing;

			assert.equal(host.compaction.state, newerState);
			assert.equal(host.compaction.upToEntryId, newerState === "idle" ? undefined : "m2");
			assert.deepEqual(announced, newerState === "ready" ? ["m2"] : []);
			if (newerState !== "running") {
				assert.equal((await host.awaitBackgroundCompaction()).state, newerState);
			}
		} finally {
			probe.cleanup();
		}
	},
);

test("the host rejects an invalid background compaction setting before changing or sending it (#4330)", async () => {
	pair = await createEngineHostPair({});
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	const host = pair.runtime.session;
	const diagnostics: string[] = [];
	pair.runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));

	assert.throws(
		() => host.setBackgroundCompactionThresholdPercent(150),
		(error: Error) =>
			isBackgroundCompactionConfigError(error) &&
			error.code === "invalid-setting" &&
			error.source === "sdk" &&
			error.field === "compaction.backgroundThresholdPercent" &&
			error.reason === "out-of-range",
	);
	assert.throws(
		() => host.setBackgroundCompactionEnabled("yes" as never),
		(error: Error) =>
			isBackgroundCompactionConfigError(error) &&
			error.source === "sdk" &&
			error.field === "compaction.background" &&
			error.reason === "not-a-boolean",
	);
	await pair.drain();

	assert.equal(host.backgroundCompactionThresholdPercent, 75);
	assert.equal(host.backgroundCompactionEnabled, true);
	assert.deepEqual(diagnostics, [], "nothing reached the engine");
	assert.equal(pair.engine.session.backgroundCompactionThresholdPercent, 75);
});

test("background compaction settings apply before optional resources finish loading (#4330)", async () => {
	const harness = await createHarness();
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const waitForResources = vi.fn(() => new Promise<void>(() => {}));
	const handle = createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: vi.fn(),
		waitForResources,
	});
	try {
		assert.deepEqual(await handle({ id: "off", type: "set_background_compaction", enabled: false }), {
			id: "off",
			type: "response",
			command: "set_background_compaction",
			success: true,
		});
		await handle({ id: "threshold", type: "set_background_compaction_threshold", percent: 60 });
		assert.equal(waitForResources.mock.calls.length, 0);
		assert.equal(harness.session.backgroundCompactionEnabled, false);
		assert.equal(harness.session.backgroundCompactionThresholdPercent, 60);
	} finally {
		harness.cleanup();
	}
});

test("get_state keeps answering after a reload loads an invalid background setting (#4330)", async () => {
	const harness = await createFileSettingsHarness();
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const handle = createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: vi.fn(),
	});
	try {
		writeFileSync(
			join(harness.tempDir, "settings.json"),
			JSON.stringify({ compaction: { backgroundThresholdPercent: 150 } }),
		);
		await harness.settingsManager.reload();
		const response = await handle({ id: "state", type: "get_state" });
		assert.ok(response?.success === true && response.command === "get_state");
		assert.equal(response.data.backgroundCompactionEnabled, false);
		assert.equal(response.data.backgroundCompactionThresholdPercent, 75);
		assert.equal(response.data.compaction?.state, "failed");
		assert.equal(response.data.compaction?.error?.code, "invalid-setting");
		assert.equal(response.data.compaction?.error?.fields.reason, "out-of-range");
	} finally {
		harness.cleanup();
	}
});
