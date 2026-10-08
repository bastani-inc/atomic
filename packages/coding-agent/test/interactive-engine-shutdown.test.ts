import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { SessionShutdownEvent } from "../src/core/extensions/session-events.ts";
import { waitForInteractiveEngineBound } from "../src/modes/interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { rpcTransportError } from "../src/modes/rpc/rpc-transport-error.ts";
import type { RpcEvent, RpcModelCatalog, RpcSessionState, RpcSlashCommand } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = (error: Error) => rejectPromise(error);
	});
	return { promise, resolve, reject };
}

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
	};
}

function createLocalRuntime(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(harness.session, servicesFor(harness) as never, async () => {
		throw new Error("unused runtime factory");
	});
}

function createState(): RpcSessionState {
	return {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "engine-session",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
	};
}

function createRuntime(
	harness: Harness,
	client: {
		onEvent(listener: (event: RpcEvent) => void): () => void;
		onGenerationEnded(listener: () => void): () => void;
		waitForInteractiveEngineBound(): Promise<void>;
		stop(): Promise<void>;
		getState(): Promise<RpcSessionState>;
		requestInternal<T>(command: { type: string }): Promise<T>;
		getCommands(): Promise<readonly RpcSlashCommand[]>;
	},
): IsolatedInteractiveRuntime {
	return new IsolatedInteractiveRuntime(
		createLocalRuntime(harness),
		async () => {
			throw new Error("unused runtime factory");
		},
		client as never,
	);
}
afterEach(() => {
	vi.restoreAllMocks();
});

describe("isolated interactive startup shutdown", () => {
	test("resolves a bind wait when explicit disposal rejects it", async () => {
		const harness = await createHarness();
		try {
			const bound = deferred<void>();
			const stop = vi.fn(async () => {
				bound.reject(rpcTransportError("Agent process stopped"));
			});
			const runtime = createRuntime(harness, {
				onEvent: () => () => {},
				onGenerationEnded: () => () => {},
				waitForInteractiveEngineBound: () => bound.promise,
				stop,
				getState: async () => createState(),
				requestInternal: async <T>(_command: { type: string }) => undefined as T,
				getCommands: async () => [],
			});

			const startup = waitForInteractiveEngineBound(runtime);
			const firstDispose = runtime.dispose();
			const secondDispose = runtime.dispose();

			assert.strictEqual(firstDispose, secondDispose);
			await firstDispose;
			await startup;
			assert.equal(
				stop.mock.calls.length,
				2,
				"shutdown requests the idempotent stop during health and trailing cleanup",
			);
		} finally {
			harness.cleanup();
		}
	});

	test("handles an in-flight first-paint getState rejection during disposal", async () => {
		const harness = await createHarness();
		try {
			const state = deferred<RpcSessionState>();
			const stop = vi.fn(async () => {
				state.reject(rpcTransportError("Agent process stopped"));
			});
			const runtime = createRuntime(harness, {
				onEvent: () => () => {},
				onGenerationEnded: () => () => {},
				waitForInteractiveEngineBound: async () => {},
				stop,
				getState: () => state.promise,
				requestInternal: async <T>(_command: { type: string }) => undefined as T,
				getCommands: async () => [],
			});

			const startup = waitForInteractiveEngineBound(runtime);
			await Promise.resolve();
			await Promise.resolve();
			await runtime.dispose();
			await startup;
			assert.equal(
				stop.mock.calls.length,
				2,
				"shutdown requests the idempotent stop during health and trailing cleanup",
			);
		} finally {
			harness.cleanup();
		}
	});

	test("keeps remote command refresh rejection contained during explicit disposal", async () => {
		const harness = await createHarness();
		try {
			const commands = deferred<never>();
			const stop = vi.fn(async () => {
				commands.reject(rpcTransportError("Agent process stopped"));
			});
			const runtime = createRuntime(harness, {
				onEvent: () => () => {},
				onGenerationEnded: () => () => {},
				waitForInteractiveEngineBound: async () => {},
				stop,
				getState: async () => createState(),
				requestInternal: async <T>(_command: { type: string }) =>
					({ models: [], scopedModels: [] }) as RpcModelCatalog as T,
				getCommands: () => commands.promise,
			});

			await waitForInteractiveEngineBound(runtime);
			await runtime.dispose();
			await Promise.resolve();
			assert.equal(
				stop.mock.calls.length,
				2,
				"shutdown requests the idempotent stop during health and trailing cleanup",
			);
		} finally {
			harness.cleanup();
		}
	});

	test("forwards a host-signal disposal to session shutdown handlers (#3492)", async () => {
		const events: SessionShutdownEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", (event) => {
						events.push(event);
					});
				},
			],
		});
		try {
			const runtime = createRuntime(harness, {
				onEvent: () => () => {},
				onGenerationEnded: () => () => {},
				waitForInteractiveEngineBound: async () => {},
				stop: async () => {},
				getState: async () => createState(),
				requestInternal: async <T>(_command: { type: string }) => undefined as T,
				getCommands: async () => [],
			});

			await runtime.dispose({ fromSignal: true });

			assert.deepEqual(events, [{ type: "session_shutdown", reason: "quit", fromSignal: true }]);
		} finally {
			harness.cleanup();
		}
	});
});
