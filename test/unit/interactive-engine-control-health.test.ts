import assert from "node:assert/strict";
import { join } from "node:path";
import { Input } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { routeGlobalClearInput } from "../../packages/coding-agent/src/modes/interactive/interactive-global-clear.js";
import { ENGINE_UNRESPONSIVE_MS } from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.js";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
import {
	RpcClient,
	type RpcClientOptions,
	type RpcCommandBody,
} from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function controlHarness(control: (command: RpcCommandBody) => Promise<unknown>, abort: () => Promise<void>) {
	let stops = 0;
	const client = Object.assign(Object.create(RpcClient.prototype) as RpcClient, {
		onEvent: () => () => {},
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
		getState: async () => ({
			thinkingLevel: "off",
			isStreaming: true,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "control-health",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		}),
		requestInternal: async (command: RpcCommandBody) =>
			command.type === "get_available_models"
				? { models: [], scopedModels: [], customAuthProviders: [] }
				: control(command),
		abort,
		getCommands: async () => [],
		stop: async () => {
			stops += 1;
		},
	});
	return { runtime: await createHost(client), stops: () => stops };
}

async function createHost(client: RpcClient): Promise<IsolatedInteractiveRuntime> {
	const session = Object.assign({} as AgentSession, {
		modelRuntime: await ModelRuntime.create({ modelsPath: null }),
		sessionManager: SessionManager.inMemory(process.cwd()),
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model: undefined, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("Unexpected session replacement");
	};
	const local = new AgentSessionRuntime(
		session,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
	);
	const runtime = new IsolatedInteractiveRuntime(local, createRuntime, client);
	await runtime.initializeFromEngine();
	return runtime;
}

afterEach(() => vi.useRealTimers());

test("a stalled queue clear arms host termination despite engine heartbeats (#3865)", async () => {
	const clear = deferred();
	const { runtime, stops } = await controlHarness(
		() => clear.promise,
		async () => {},
	);
	vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
	assert.deepEqual(runtime.session.clearQueue(), { steering: [], followUp: [] });
	assert.equal(runtime.needsExplicitTermination(), false);
	await vi.advanceTimersByTimeAsync(ENGINE_UNRESPONSIVE_MS);
	runtime.noteEngineHeartbeat();
	assert.equal(runtime.needsExplicitTermination(), true, "heartbeat must not acknowledge a pending control");
	assert.equal(stops(), 0, "only the user may terminate a stalled engine");
	clear.resolve();
	await vi.waitFor(() =>
		assert.equal(runtime.needsExplicitTermination(), false, "acknowledgement disarms a healthy engine"),
	);
});

test("a failed queue clear leaves the host escape hatch armed (#3865)", async () => {
	const clear = deferred();
	const { runtime, stops } = await controlHarness(
		() => clear.promise,
		async () => {},
	);
	runtime.session.clearQueue();
	clear.reject(new Error("Timeout waiting for response to clear_queue"));
	await vi.waitFor(() => {
		runtime.noteEngineHeartbeat();
		assert.equal(runtime.needsExplicitTermination(), true);
	});
	assert.equal(stops(), 0);
});

test("a failed cooperative abort leaves the host escape hatch armed (#3865)", async () => {
	const error = new Error("Abort transport failed");
	const { runtime, stops } = await controlHarness(
		async () => {},
		async () => {
			throw error;
		},
	);
	await assert.rejects(runtime.session.abort(), (caught) => caught === error);
	runtime.noteEngineHeartbeat();
	assert.equal(runtime.needsExplicitTermination(), true);
	assert.equal(stops(), 0);
});

test("an earlier failed queue pause cannot prevent a subsequent abort submission (#3865)", async () => {
	let aborts = 0;
	const { runtime } = await controlHarness(
		async () => {
			throw new Error("Timeout waiting for response to pause_queued_messages");
		},
		async () => {
			aborts += 1;
		},
	);
	runtime.session.pauseQueuedMessages();
	await runtime.session.abort();
	assert.equal(aborts, 1);
});

const REAL_ENGINE_CONTROL_TIMEOUT_MS = 60_000;
const CONTROL_RESPONSE_TIMEOUT_MS = 100;

test(
	"host input and explicit recovery remain usable when engine RPC input stalls but heartbeats continue (#3865)",
	async () => {
		let heartbeats = 0;
		let host: IsolatedInteractiveRuntime | undefined;
		const options: RpcClientOptions = {
			cliPath: join(moduleDir(import.meta.url), "fixtures/stalled-control-engine.ts"),
			runtimeExecutable: bunExecutable(),
			interactiveEngine: {
				onDiagnostic: () => {},
				onHeartbeat: () => {
					heartbeats += 1;
					host?.noteEngineHeartbeat();
				},
			},
		};
		const client = new RpcClient(options);
		try {
			await client.start();
			host = await createHost(client);
			options.requestTimeoutMs = CONTROL_RESPONSE_TIMEOUT_MS;
			const runtime = host;
			const diagnostics: string[] = [];
			runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));
			await client.prompt("stall RPC input");
			const pid = client.getEnginePid();
			const before = heartbeats;
			const editor = new Input();
			editor.handleInput("still typing");
			runtime.session.pauseQueuedMessages();
			assert.deepEqual(runtime.session.clearQueue(), { steering: ["queued before stall"], followUp: [] });
			assert.deepEqual(runtime.session.getSteeringMessages(), []);
			let abortError: Error | undefined;
			const abort = runtime.session.abort().catch((error: Error) => {
				abortError = error;
			});
			await sleep(ENGINE_UNRESPONSIVE_MS + CONTROL_RESPONSE_TIMEOUT_MS);
			editor.handleInput(" after timeout");
			assert.equal(editor.getValue(), "still typing after timeout");
			assert.ok(heartbeats > before, "engine heartbeats must continue during the RPC stall");
			assert.ok(
				diagnostics.some((message) => message.includes("Timeout waiting for response to clear_queue")),
				JSON.stringify(diagnostics),
			);
			assert.equal(runtime.needsExplicitTermination(), true);
			assert.equal(client.getEnginePid(), pid, "a failed control must not automatically kill the engine");
			let recovery: Promise<void> | undefined;
			options.requestTimeoutMs = undefined;
			const routed = routeGlobalClearInput("\x03", {
				matchesCtrlC: (data) => data === "\x03",
				matchesEscape: (data) => data === "\x1b",
				isSafetyKeyRelease: () => false,
				matchesClear: () => false,
				hasOverlay: () => true,
				blockingInlineCustomUiActive: () => false,
				editorOwnsInput: () => false,
				engineNeedsExplicitTermination: () => runtime.needsExplicitTermination(),
				onEngineTerminate: () => {
					recovery = runtime.terminateAndRecover();
				},
				onClear: () => assert.fail("Ctrl+C must recover rather than clear the editor"),
				requestRender: () => {},
			});
			assert.deepEqual(routed, { consume: true });
			assert.ok(recovery);
			await recovery;
			await abort;
			assert.match(abortError?.message ?? "", /Agent process stopped/);
			assert.notEqual(client.getEnginePid(), pid);
			assert.equal(
				runtime.needsExplicitTermination(),
				false,
				"old control failures must not poison the replacement",
			);
		} finally {
			await client.stop();
		}
	},
	REAL_ENGINE_CONTROL_TIMEOUT_MS,
);
