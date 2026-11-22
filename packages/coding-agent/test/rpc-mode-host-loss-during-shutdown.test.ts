import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createHarness, type Harness } from "./suite/harness.js";

const rpcIo = vi.hoisted(() => ({
	engineChild: true,
	/** Whether this engine's exit ends its commands' processes when its host is gone. */
	watchesHostLoss: true,
	/** The channel state the exit's check for the host's loss reads, once installed. */
	channelClosed: undefined as (() => boolean) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	rawStdoutWriteFailed: () => false,
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: () => {},
}));

vi.mock("../src/utils/interactive-engine-env.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/interactive-engine-env.ts")>();
	return {
		...actual,
		isInteractiveEngineChild: () => rpcIo.engineChild,
		interactiveEngineStartupEnv: () => ({ ...actual.interactiveEngineStartupEnv(), hostPid: "4242" }),
	};
});

vi.mock("../src/modes/interactive-engine/engine-host-loss.ts", () => ({
	endCommandsWhenHostIsGone: (_hostPid: number, _quitAnnounced: () => boolean, channelClosed: () => boolean) => {
		if (!rpcIo.watchesHostLoss) return false;
		rpcIo.channelClosed = channelClosed;
		return true;
	},
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

vi.mock("../src/modes/interactive-engine/engine-quit-intent.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive-engine/engine-quit-intent.ts")>()),
	reportShutdownCompleteAtExit: () => {},
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn(() => () => {}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type Listener = (...args: never[]) => void;

/** An engine child stopped by its host's signal, whose shutdown waits until the test lets its runtime's disposal end. */
async function signalledEngine(options: { engineChild?: boolean; watchesHostLoss?: boolean } = {}) {
	rpcIo.engineChild = options.engineChild ?? true;
	rpcIo.watchesHostLoss = options.watchesHostLoss ?? true;
	rpcIo.channelClosed = undefined;
	const harness: Harness = await createHarness();
	let finishDisposal!: () => void;
	const disposal = new Promise<void>((resolve) => {
		finishDisposal = resolve;
	});
	const dispose = vi.fn(() => disposal);
	const runtimeHost = {
		session: harness.session,
		services: { agentDir: harness.tempDir },
		dispose,
		setRebindSession: vi.fn(),
		setBeforeSessionInvalidate: vi.fn(),
	} as unknown as AgentSessionRuntime;

	const signalHandlers = new Map<string, Listener>();
	const realOn = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation(((event: string, listener: Listener) => {
		if (event === "SIGTERM" || event === "SIGHUP") signalHandlers.set(event, listener);
		return realOn(event, listener);
	}) as typeof process.on);
	// The input's end listeners, which the test calls in place of the end of the real input; its reads are not started.
	const inputEndListeners = new Set<Listener>();
	vi.spyOn(process.stdin, "on").mockImplementation(((event: string, listener: Listener) => {
		if (event === "end") inputEndListeners.add(listener);
		return process.stdin;
	}) as typeof process.stdin.on);
	vi.spyOn(process.stdin, "once").mockImplementation(((event: string, listener: Listener) => {
		if (event === "end") inputEndListeners.add(listener);
		return process.stdin;
	}) as typeof process.stdin.once);
	vi.spyOn(process.stdin, "off").mockImplementation(((event: string, listener: Listener) => {
		if (event === "end") inputEndListeners.delete(listener);
		return process.stdin;
	}) as typeof process.stdin.off);
	const resume = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	const pause = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	const bound = vi.spyOn(harness.session.agent, "subscribe");
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => assert.ok(bound.mock.calls.length > 0 && signalHandlers.has("SIGTERM")));
	signalHandlers.get("SIGTERM")?.();
	await vi.waitFor(() => assert.equal(dispose.mock.calls.length, 1));

	return {
		/** The host is killed while the engine shuts down: its end of the engine's input closes. */
		hostKilled: () => {
			for (const listener of inputEndListeners) listener();
		},
		resumed: () => resume.mock.calls.length > 0,
		paused: () => pause.mock.calls.length > 0,
		async exited() {
			finishDisposal();
			await vi.waitFor(() => assert.equal(exit.mock.calls.length, 1));
		},
		cleanup: () => harness.cleanup(),
	};
}

describe("an engine child stopped by its host's signal", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("sees its input end when its host is killed while it shuts down, so its exit checks for the host's loss", async () => {
		const engine = await signalledEngine();
		try {
			engine.hostKilled();
			await engine.exited();
			assert.equal(rpcIo.channelClosed?.(), true, "the exit takes the channel to the host for open");
		} finally {
			engine.cleanup();
		}
	});

	test("takes the channel for open when its host stays and keeps it open", async () => {
		const engine = await signalledEngine();
		try {
			await engine.exited();
			assert.equal(rpcIo.channelClosed?.(), false);
		} finally {
			engine.cleanup();
		}
	});

	test("stops reading its input as before when its exit does not check for its host's loss", async () => {
		const engine = await signalledEngine({ watchesHostLoss: false });
		try {
			await engine.exited();
			assert.deepEqual({ paused: engine.paused(), resumed: engine.resumed() }, { paused: true, resumed: false });
		} finally {
			engine.cleanup();
		}
	});

	test("as a standalone RPC process, stops reading its input as before", async () => {
		const engine = await signalledEngine({ engineChild: false });
		try {
			await engine.exited();
			assert.deepEqual({ paused: engine.paused(), resumed: engine.resumed() }, { paused: true, resumed: false });
		} finally {
			engine.cleanup();
		}
	});
});
