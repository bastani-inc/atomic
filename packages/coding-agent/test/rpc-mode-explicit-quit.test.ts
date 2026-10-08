import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createHarness, type Harness } from "./suite/harness.js";

const rpcIo = vi.hoisted(() => ({
	engineChild: false,
	output: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.output.push(line);
	},
}));

vi.mock("../src/utils/interactive-engine-env.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/interactive-engine-env.ts")>()),
	isInteractiveEngineChild: () => rpcIo.engineChild,
}));

// Liveness would start a parent-process guardian and heartbeat for the test runner itself.
vi.mock("../src/modes/interactive-engine/engine-child-liveness.ts", () => ({
	startInteractiveEngineLiveness: () => ({
		ready: () => {},
		bound: () => {},
		resourcesReady: () => {},
		resourcesFailed: () => {},
		stop: () => {},
	}),
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type Listener = (...args: never[]) => void;

/** What the child's shutdown told its runtime, observed by driving the real signal and stdin handlers. */
async function startChild(engineChild: boolean) {
	rpcIo.engineChild = engineChild;
	rpcIo.output = [];
	rpcIo.lineHandler = undefined;
	const harness: Harness = await createHarness();
	const dispose = vi.fn(async (_options?: { fromSignal?: boolean }) => {});
	const runtimeHost = {
		session: harness.session,
		services: { agentDir: harness.tempDir },
		dispose,
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	const signalHandlers = new Map<string, Listener>();
	const realOn = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation(((event: string, listener: Listener) => {
		if (event === "SIGTERM" || event === "SIGHUP") signalHandlers.set(event, listener);
		return realOn(event, listener);
	}) as typeof process.on);
	let inputEnd: Listener | undefined;
	const realStdinOn = process.stdin.on.bind(process.stdin);
	vi.spyOn(process.stdin, "on").mockImplementation(((event: string, listener: Listener) => {
		if (event === "end") inputEnd = listener;
		return realStdinOn(event, listener);
	}) as typeof process.stdin.on);
	// The last step of binding the session; a shutdown that races earlier steps tears down half-built state.
	const bound = vi.spyOn(harness.session.agent, "subscribe");
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);

	void runRpcMode(runtimeHost);
	await vi.waitFor(() =>
		assert.ok(bound.mock.calls.length > 0 && rpcIo.lineHandler && inputEnd && signalHandlers.has("SIGTERM")),
	);

	return {
		announceExplicitQuit: () => rpcIo.lineHandler?.(JSON.stringify({ type: "engine_explicit_quit" })),
		signal: () => signalHandlers.get("SIGTERM")?.(),
		endInput: () => inputEnd?.(),
		async disposeOptions() {
			await vi.waitFor(() => assert.equal(exit.mock.calls.length, 1));
			assert.equal(dispose.mock.calls.length, 1);
			return dispose.mock.calls[0][0];
		},
		cleanup: () => harness.cleanup(),
	};
}

describe("RPC mode shutdown cause", () => {
	beforeEach(() => {
		rpcIo.output = [];
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("an engine child stopped by SIGTERM with no announced quit keeps its session registered (#3492)", async () => {
		const child = await startChild(true);
		try {
			child.signal();
			assert.deepEqual(await child.disposeOptions(), { fromSignal: true });
		} finally {
			child.cleanup();
		}
	});

	test("an engine child acknowledges an announced quit and then releases on SIGTERM (#3492)", async () => {
		const child = await startChild(true);
		try {
			child.announceExplicitQuit();
			assert.ok(rpcIo.output.some((line) => JSON.parse(line).type === "engine_explicit_quit_ack"));
			child.signal();
			assert.deepEqual(await child.disposeOptions(), { fromSignal: false });
		} finally {
			child.cleanup();
		}
	});

	test("an engine child whose stdin closes without an announced quit keeps its session registered (#3492)", async () => {
		const child = await startChild(true);
		try {
			child.endInput();
			assert.deepEqual(await child.disposeOptions(), { fromSignal: true });
		} finally {
			child.cleanup();
		}
	});

	test("an engine child whose stdin closes after an announced quit releases (#3492)", async () => {
		const child = await startChild(true);
		try {
			child.announceExplicitQuit();
			child.endInput();
			assert.deepEqual(await child.disposeOptions(), { fromSignal: false });
		} finally {
			child.cleanup();
		}
	});

	test("a standalone RPC process treats SIGTERM as a host signal and a closed stdin as a quit (#3492)", async () => {
		const signalled = await startChild(false);
		try {
			signalled.signal();
			assert.deepEqual(await signalled.disposeOptions(), { fromSignal: true });
		} finally {
			signalled.cleanup();
		}
		vi.restoreAllMocks();
		const closed = await startChild(false);
		try {
			closed.endInput();
			assert.deepEqual(await closed.disposeOptions(), { fromSignal: false });
		} finally {
			closed.cleanup();
		}
	});
});
