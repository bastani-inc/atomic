import assert from "node:assert/strict";
import { type FauxResponseStep, fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { createHarness } from "./suite/harness.js";

/** What the mode had done when it started the managed-tool readiness check (fd, rg and git), once per call. */
interface ReadinessStart {
	readonly inputReady: boolean;
	readonly modelRequests: number;
}

interface StartedMode {
	readonly mode: InteractiveMode;
	readonly starts: ReadinessStart[];
	readonly modelRequests: () => number;
	/** Wait for the startup work input-ready begins, and on the isolated host for the engine to have handled it. */
	readonly settled: () => Promise<void>;
}

const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop();
});

/** The real interactive mode, offline, on either host, recording when it starts the managed-tool readiness check. */
async function interactiveMode(
	host: "in-process" | "isolated",
	options: Omit<InteractiveModeOptions, "terminal"> = {},
): Promise<StartedMode> {
	let requests = 0;
	const responses: FauxResponseStep[] = Array.from({ length: 3 }, () => () => {
		requests++;
		return fauxAssistantMessage("done");
	});
	let runtime: AgentSessionRuntime;
	let pair: EngineHostPair | undefined;
	if (host === "isolated") {
		pair = await createEngineHostPair({});
		const created = pair;
		stops.push(() => created.cleanup());
		created.engine.setResponses(responses);
		runtime = created.runtime;
	} else {
		const harness = await createHarness({});
		stops.push(() => harness.cleanup());
		harness.setResponses(responses);
		runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.session.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			} as never,
			async () => {
				throw new Error("no session replacement in this test");
			},
		);
	}
	for (const [name, value] of [
		["ATOMIC_REDUCED_MOTION", "1"],
		["ATOMIC_OFFLINE", "1"],
	] as const) {
		const previous = process.env[name];
		process.env[name] = value;
		stops.push(() => {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		});
	}
	const mode = new InteractiveMode(runtime, { ...options, terminal: new VirtualTerminal(79, 30) });
	stops.push(() => mode.stop());
	const starts: ReadinessStart[] = [];
	// The check itself runs fd, rg and git: what is recorded is when it starts.
	mode.ensureManagedToolsReady = async () => {
		starts.push({ inputReady: mode.inputHandlerReadyRecorded, modelRequests: requests });
	};
	return {
		mode,
		starts,
		modelRequests: () => requests,
		settled: async () => {
			await mode.ensureDeferredStartupComplete();
			await pair?.drain();
		},
	};
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	await vi.waitFor(
		() => {
			if (!condition()) throw new Error(`still waiting for ${what}`);
		},
		{ timeout: 20_000, interval: 10 },
	);
}

describe.each(["in-process", "isolated"] as const)("the managed-tool readiness check on the %s host", (host) => {
	test("starts once the editor takes input, not while the editor is starting", async () => {
		const { mode, starts, settled } = await interactiveMode(host);
		void mode.run().catch(() => {});

		await waitFor(() => mode.inputHandlerReadyRecorded && starts.length > 0, "input and the readiness check");
		await settled();
		assert.deepEqual(starts, [{ inputReady: true, modelRequests: 0 }]);
	});

	test("starts before a prompt given on the command line is sent", async () => {
		const { mode, starts, modelRequests, settled } = await interactiveMode(host, { initialMessage: "hello" });
		void mode.run().catch(() => {});

		await waitFor(() => modelRequests() > 0 && mode.inputHandlerReadyRecorded, "the prompt's answer");
		await settled();
		assert.deepEqual(starts, [{ inputReady: false, modelRequests: 0 }]);
	});

	test("starts in init() for a mode that init() alone drives, and once when run() follows", async () => {
		const { mode, starts, settled } = await interactiveMode(host);
		await mode.init();
		assert.equal(starts.length, 1);

		// The startup notices are shown by the work that follows input-ready, after the point the check would start.
		let noticesShown = false;
		const showNotices = mode.showStartupNoticesIfNeeded.bind(mode);
		mode.showStartupNoticesIfNeeded = (container) => {
			noticesShown = true;
			showNotices(container);
		};
		void mode.run().catch(() => {});
		await waitFor(() => mode.inputHandlerReadyRecorded && noticesShown, "input and the work after it");
		await settled();
		assert.equal(starts.length, 1);
	});
});
