import assert from "node:assert/strict";
import { afterEach, beforeEach, type MockInstance, test, vi } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { startInteractiveEngineLiveness } from "../../packages/coding-agent/src/modes/interactive-engine/engine-child-liveness.ts";
import { renderEngineDiagnostic } from "../../packages/coding-agent/src/modes/interactive-engine/engine-diagnostic-view.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	clearDeprecationWarningsForTests,
	deferDeprecationWarnings,
	finishDeprecationWarningsAtExit,
	setDeprecationWarningSink,
	warnDeprecation,
} from "../../packages/coding-agent/src/utils/deprecation.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";

vi.mock("../../packages/coding-agent/src/utils/interactive-engine-env.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/coding-agent/src/utils/interactive-engine-env.ts")>()),
	interactiveEngineStartupEnv: () => ({ child: "1", hostPid: undefined, guardFile: undefined, apiKey: undefined }),
}));

const IGNORED = 'Ignored legacy "routerModel" because "decisionModel" is already set.';
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
	clearDeprecationWarningsForTests();
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
	clearDeprecationWarningsForTests();
});

/** The engine's stdout lines, as the host parses them. */
function engineMessages(lines: string[]): InteractiveEngineMessage[] {
	return lines.flatMap((line) => parseInteractiveEngineMessage(line) ?? []);
}

test("the engine sends its deprecation warnings to the host as messages, never on its stderr", () => {
	deferDeprecationWarnings();
	warnDeprecation(IGNORED, { once: "settings.json\0openai/gpt-6.1-sol" });
	assert.deepEqual(warn.mock.calls, [], "nothing on the engine's stderr, which its host shows as diagnostics");

	const lines: string[] = [];
	const liveness = startInteractiveEngineLiveness((line) => lines.push(line));
	try {
		warnDeprecation("an engine-only notice");
	} finally {
		liveness.stop();
	}
	assert.deepEqual(
		engineMessages(lines).filter((message) => message.type === "engine_deprecation_warning"),
		[
			{ type: "engine_deprecation_warning", message: IGNORED, once: "settings.json\0openai/gpt-6.1-sol" },
			{ type: "engine_deprecation_warning", message: "an engine-only notice" },
		],
	);
});

test("an engine that exits before it can send its warnings writes them to stderr", () => {
	deferDeprecationWarnings();
	warnDeprecation(IGNORED);
	finishDeprecationWarningsAtExit();
	assert.equal(warn.mock.calls.length, 1);
	assert.match(String(warn.mock.calls[0]?.[0]), /Ignored legacy "routerModel"/);
});

test("the host shows an engine's deprecation warning once with its own, and stderr text that looks like one stays a diagnostic", async () => {
	const harness = await createHarness();
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const client = {
		onInteractiveEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			engineListeners.push(listener);
			return () => engineListeners.splice(engineListeners.indexOf(listener), 1);
		},
		onInteractiveEngineKeybindingState: () => () => {},
		onExtensionUIRequest: () => () => {},
		onEvent: () => () => {},
		onGenerationEnded: () => () => {},
		getGeneration: () => 1,
		getState: async () => ({ resourceExtensions: [] }),
		requestInternal: <T>() => Promise.resolve(undefined as T),
		stop: async () => {},
		restart: async () => {},
	};
	const localRuntime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const runtime = new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		client as never,
	);
	const shown: string[] = [];
	const restore = setDeprecationWarningSink((message) => shown.push(message));
	try {
		warnDeprecation(IGNORED);
		for (const message of [IGNORED, "an engine-only notice"])
			for (const listener of [...engineListeners]) listener({ type: "engine_deprecation_warning", message });
		assert.deepEqual(shown, [IGNORED, "an engine-only notice"]);

		const statuses: string[] = [];
		renderEngineDiagnostic(
			{
				activity: undefined,
				elapsedMs: 0,
				level: "blocking",
				source: "stderr",
				message: "Deprecation warning: spoofed\u0007\n",
			},
			{ showStatus: (message) => statuses.push(message), showError: () => {}, stopWorkingLoader: () => {} },
		);
		assert.deepEqual(shown, [IGNORED, "an engine-only notice"], "stderr text is never taken for a warning");
		assert.equal(statuses.length, 1);
		assert.doesNotMatch(statuses[0]!, /\u0007/, "and its display is sanitized");
	} finally {
		restore();
		await runtime.dispose();
		await harness.cleanup();
	}
});
