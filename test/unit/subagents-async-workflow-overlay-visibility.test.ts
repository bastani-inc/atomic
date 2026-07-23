import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@bastani/atomic";
import { createAsyncJobTracker } from "../../packages/subagents/src/runs/background/async-job-tracker.js";
import { stopWidgetAnimation } from "../../packages/subagents/src/tui/render.js";
import type { AsyncStatus, SubagentState } from "../../packages/subagents/src/shared/types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { makeSnap, makeStage, makeStore, defaultTheme, visibleText } from "./overlay-graph-helpers.js";

type SetWidgetArgs = Parameters<ExtensionContext["ui"]["setWidget"]>;

const tempRoots: string[] = [];
const states: SubagentState[] = [];

function makeTempRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function makeState(cwd: string): SubagentState {
	const state: SubagentState = {
		baseCwd: cwd,
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
	states.push(state);
	return state;
}

function makePi(): Pick<ExtensionAPI, "events"> {
	return { events: { emit: () => {}, on: () => () => {} } } as Pick<ExtensionAPI, "events">;
}

function makeUiContext(cwd: string, statuses: Map<string, string>): ExtensionContext {
	return {
		hasUI: true,
		cwd,
		ui: {
			setWidget: (_key: string, _content: SetWidgetArgs[1], _options?: SetWidgetArgs[2]) => {},
			setStatus: (key: string, value: string | undefined) => {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			requestRender: () => {},
		},
		sessionManager: {
			getSessionFile: () => "session-current",
			getSessionId: () => "session-current",
			getEntries: () => [],
		},
		modelRegistry: { getAvailable: () => [] },
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function makeStatus(runId: string, cwd: string): AsyncStatus {
	return {
		runId,
		mode: "single",
		state: "running",
		cwd,
		sessionId: "session-current",
		startedAt: 1_000,
		lastUpdate: 2_000,
		currentStep: 0,
		steps: [{ agent: "worker", status: "running", startedAt: 1_000 }],
	};
}

function writeStatus(asyncRoot: string, runId: string, status: AsyncStatus): void {
	const asyncDir = path.join(asyncRoot, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
}

function footerData(statuses: Map<string, string>): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

afterEach(() => {
	stopWidgetAnimation();
	for (const state of states.splice(0)) {
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
		state.cleanupTimers.clear();
	}
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async subagent status while workflow overlay is active", () => {
	test("surfaces running and completed async subagent status in the workflow graph statusline", () => {
		const cwd = makeTempRoot("atomic-subagent-workflow-cwd-");
		const asyncRoot = makeTempRoot("atomic-subagent-workflow-async-");
		const resultsDir = makeTempRoot("atomic-subagent-workflow-results-");
		const statuses = new Map<string, string>();
		const state = makeState(cwd);
		writeStatus(asyncRoot, "run-visible", makeStatus("run-visible", cwd));
		const ctx = makeUiContext(cwd, statuses);
		const tracker = createAsyncJobTracker(makePi(), state, asyncRoot, {
			resultsDir,
			pollIntervalMs: 60_000,
		});

		tracker.hydrateActiveJobs(ctx);
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store: makeStore(makeSnap([{ ...makeStage("stage-1"), status: "running" }])),
			graphTheme: defaultTheme,
			footerData: footerData(statuses),
			getViewportRows: () => 20,
		});

		assert.match(visibleText(view.render(100)), /Async agents: 1 running/);

		tracker.handleComplete({ id: "run-visible", success: true, asyncDir: path.join(asyncRoot, "run-visible") });

		assert.match(visibleText(view.render(100)), /Async agents: 1 complete/);
		view.dispose();
	});
});
