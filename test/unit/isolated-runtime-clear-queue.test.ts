import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcEvent, RpcResourceExtension } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
}

function createClearQueueClient() {
	let generation = 1;
	let eventListener: ((event: RpcEvent) => void) | undefined;
	let generationEndedListener: ((event: InteractiveEngineGenerationEnded) => void) | undefined;
	let resourceExtensions: RpcResourceExtension[] = [];
	const clearRequests: PromiseWithResolvers<void>[] = [];
	const client = {
		onEvent(listener: (event: RpcEvent) => void) {
			eventListener = listener;
			return () => {
				if (eventListener === listener) eventListener = undefined;
			};
		},
		onGenerationEnded(listener: (event: InteractiveEngineGenerationEnded) => void) {
			generationEndedListener = listener;
			return () => {
				if (generationEndedListener === listener) generationEndedListener = undefined;
			};
		},
		getGeneration() {
			return generation;
		},
		getState: async () => ({ resourceExtensions }),
		requestInternal<T>(command: { type: string }): Promise<T> {
			if (command.type === "clear_queue") {
				const request = Promise.withResolvers<void>();
				clearRequests.push(request);
				return request.promise as Promise<T>;
			}
			return Promise.resolve(undefined as T);
		},
		stop: async () => {},
		restart: async () => {},
	};
	return {
		client,
		emit(event: RpcEvent): void {
			eventListener?.(event);
		},
		emitGenerationEnded(event: InteractiveEngineGenerationEnded): void {
			generationEndedListener?.(event);
		},
		setGeneration(nextGeneration: number): void {
			generation = nextGeneration;
		},
		setResourceExtensions(extensions: RpcResourceExtension[]): void {
			resourceExtensions = extensions;
		},
		reject(error: Error, index = 0): void {
			const request = clearRequests[index];
			if (request === undefined) throw new Error(`no clear_queue request at index ${index}`);
			request.reject(error);
		},
		get clearCalls(): number {
			return clearRequests.length;
		},
	};
}

async function createRuntime(
	harness: Harness,
	client: ReturnType<typeof createClearQueueClient>["client"],
): Promise<IsolatedInteractiveRuntime> {
	const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness), async () => {
		throw new Error("unused runtime factory");
	});
	return new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		client as never,
	);
}

async function settleRejectedClear(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("ending the current generation clears its cached resource extensions", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const extensions = [{ path: "/current/extension.ts", hidden: false }];
		probe.setResourceExtensions(extensions);
		await runtime.synchronize();
		assert.deepEqual(runtime.getResourceExtensions(), extensions);

		probe.emitGenerationEnded({
			generation: 1,
			error: new Error("engine replaced"),
			kind: "explicit-stop",
			expected: true,
		});

		assert.deepEqual(runtime.getResourceExtensions(), []);
	} finally {
		harness.cleanup();
	}
});

test("ending a stale generation preserves the current generation's cached resource extensions", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const extensions = [{ path: "/current/extension.ts", hidden: false }];
		probe.setGeneration(2);
		probe.setResourceExtensions(extensions);
		await runtime.synchronize();
		assert.deepEqual(runtime.getResourceExtensions(), extensions);

		probe.emitGenerationEnded({
			generation: 1,
			error: new Error("retired engine stopped"),
			kind: "exit",
			expected: false,
		});

		assert.deepEqual(runtime.getResourceExtensions(), extensions);
	} finally {
		harness.cleanup();
	}
});

test("clearQueue keeps authoritative superset queues without duplicating the failed snapshot", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		const returned = session.clearQueue();
		assert.deepEqual(returned, { steering: ["before steer"], followUp: ["before follow-up"] });
		assert.deepEqual(session.getSteeringMessages(), []);
		assert.deepEqual(session.getFollowUpMessages(), []);
		assert.equal(probe.clearCalls, 1);

		probe.emit({
			type: "queue_update",
			steering: ["before steer", "new steer"],
			followUp: ["before follow-up", "new follow-up"],
		});
		probe.reject(new Error("engine unavailable"));
		await settleRejectedClear();

		assert.deepEqual(session.getSteeringMessages(), ["before steer", "new steer"]);
		assert.deepEqual(session.getFollowUpMessages(), ["before follow-up", "new follow-up"]);
	} finally {
		harness.cleanup();
	}
});

test("clearQueue restores both snapshots when the remote clear fails before any engine update", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		const returned = session.clearQueue();
		assert.deepEqual(returned, { steering: ["before steer"], followUp: ["before follow-up"] });
		assert.deepEqual(session.getSteeringMessages(), []);
		assert.deepEqual(session.getFollowUpMessages(), []);

		probe.reject(new Error("engine unavailable"));
		await settleRejectedClear();

		assert.deepEqual(session.getSteeringMessages(), ["before steer"]);
		assert.deepEqual(session.getFollowUpMessages(), ["before follow-up"]);
	} finally {
		harness.cleanup();
	}
});

test("clearQueue adopts disjoint authoritative engine queues after a failed remote clear", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		session.clearQueue();
		probe.emit({ type: "queue_update", steering: ["admitted steer"], followUp: ["admitted follow-up"] });
		probe.reject(new Error("engine unavailable"));
		await settleRejectedClear();

		assert.deepEqual(session.getSteeringMessages(), ["admitted steer"]);
		assert.deepEqual(session.getFollowUpMessages(), ["admitted follow-up"]);
	} finally {
		harness.cleanup();
	}
});

test("clearQueue keeps an authoritative empty queue_update when the remote clear fails", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		session.clearQueue();
		probe.emit({ type: "queue_update", steering: [], followUp: [] });
		probe.reject(new Error("engine unavailable"));
		await settleRejectedClear();

		assert.deepEqual(session.getSteeringMessages(), []);
		assert.deepEqual(session.getFollowUpMessages(), []);
	} finally {
		harness.cleanup();
	}
});

test("overlapping failed clears restore the original queue when rejected oldest-first", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		assert.deepEqual(session.clearQueue(), { steering: ["before steer"], followUp: ["before follow-up"] });
		assert.deepEqual(session.clearQueue(), { steering: [], followUp: [] });
		assert.equal(probe.clearCalls, 2);

		probe.reject(new Error("engine unavailable"), 0);
		await settleRejectedClear();
		assert.deepEqual(session.getSteeringMessages(), []);
		assert.deepEqual(session.getFollowUpMessages(), []);

		probe.reject(new Error("engine unavailable"), 1);
		await settleRejectedClear();
		assert.deepEqual(session.getSteeringMessages(), ["before steer"]);
		assert.deepEqual(session.getFollowUpMessages(), ["before follow-up"]);
	} finally {
		harness.cleanup();
	}
});

test("overlapping failed clears restore the original queue when rejected newest-first", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		session.clearQueue();
		session.clearQueue();

		probe.reject(new Error("engine unavailable"), 1);
		await settleRejectedClear();
		probe.reject(new Error("engine unavailable"), 0);
		await settleRejectedClear();

		assert.deepEqual(session.getSteeringMessages(), ["before steer"]);
		assert.deepEqual(session.getFollowUpMessages(), ["before follow-up"]);
	} finally {
		harness.cleanup();
	}
});

test("clearQueue does not restore a retired engine's queue after replacement", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		session.clearQueue();
		probe.emitGenerationEnded({
			generation: 1,
			error: new Error("engine replaced"),
			kind: "explicit-stop",
			expected: true,
		});
		probe.reject(new Error("engine unavailable"));
		await settleRejectedClear();

		assert.deepEqual(session.getSteeringMessages(), []);
		assert.deepEqual(session.getFollowUpMessages(), []);
	} finally {
		harness.cleanup();
	}
});
