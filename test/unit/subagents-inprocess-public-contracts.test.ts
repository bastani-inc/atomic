import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { createAsyncJobTracker } from "../../packages/subagents/src/runs/background/async-job-tracker.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/inprocess/background-single.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	type SubagentState,
} from "../../packages/subagents/src/shared/types.js";
import { stopWidgetAnimation } from "../../packages/subagents/src/tui/render.js";
import { sleep } from "../helpers/runtime.js";

type EventHandler = (data: unknown) => void;

class TestEvents {
	private readonly handlers = new Map<string, Set<EventHandler>>();

	on(event: string, handler: EventHandler): () => void {
		const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

const tempRoots: string[] = [];
const states: SubagentState[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-public-contract-"));
	tempRoots.push(root);
	return root;
}

function agent(): AgentConfig {
	return {
		name: "qa-echo",
		description: "test echo agent",
		systemPrompt: "Return the fixture output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/qa-echo.md",
	};
}

function state(cwd: string): SubagentState {
	const value: SubagentState = {
		baseCwd: cwd,
		currentSessionId: "parent-session",
		asyncJobs: new Map(),
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
	states.push(value);
	return value;
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(cwd, "parent-session.jsonl"),
			getSessionId: () => "parent-session",
			getLeafId: () => null,
			getEntries: () => [],
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function executor(
	cwd: string,
	events: TestEvents,
	runtime: Partial<SubagentExecutorRuntimeDeps> = {},
): { execute: ReturnType<typeof createSubagentExecutor>; state: SubagentState } {
	const currentState = state(cwd);
	const execute = createSubagentExecutor({
		pi: {
			events,
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state: currentState,
		config: { maxSubagentDepth: 5, parallel: { concurrency: 4, maxTasks: 50 } },
		asyncByDefault: false,
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent()] }),
		runtime,
	});
	return { execute, state: currentState };
}

function text(result: Awaited<ReturnType<ReturnType<typeof createSubagentExecutor>["execute"]>>): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

beforeEach(() => {
	clearSubagentControls();
});

afterEach(() => {
	stopWidgetAnimation();
	clearSubagentControls();
	for (const currentState of states.splice(0)) {
		if (currentState.poller) clearInterval(currentState.poller);
		for (const timer of currentState.cleanupTimers.values()) clearTimeout(timer);
		currentState.cleanupTimers.clear();
	}
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("public parallel dispatch retries capacity refusals until all six tasks complete", async () => {
	const cwd = makeRoot();
	const { execute } = executor(cwd, new TestEvents());
	const result = await execute.execute(
		"parallel-six",
		{
			tasks: Array.from({ length: 6 }, (_, index) => ({ agent: "qa-echo", task: `echo ${index + 1}` })),
			concurrency: 6,
			artifacts: false,
		},
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	assert.equal(result.details.results.length, 6);
	assert.deepEqual(
		result.details.results.map((child) => child.status),
		["ok", "ok", "ok", "ok", "ok", "ok"],
	);
	assert.ok(result.details.results.every((child) => !child.cause?.includes("capacity")));
	assert.match(text(result), /^6\/6 succeeded/);
});

test("public interrupt and resume actions accept both bare run ids and canonical child paths", async () => {
	const cwd = makeRoot();
	let gate = Promise.withResolvers<void>();
	let promptLogPath = join(cwd, "prompt-bare.log");
	const events = new TestEvents();
	const completions: Array<{
		status?: string;
		envelope?: string;
		result?: { status?: string; envelope?: string; stats?: { sessionId?: string } };
	}> = [];
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => completions.push(payload as (typeof completions)[number]));
	const { execute } = executor(cwd, events, {
		executeAsyncSingle: (id, params) =>
			executeAsyncSingle(id, {
				...params,
				testSession: { output: "resumed ok", promptGate: gate.promise, promptLogPath, abortResolvesPrompt: true },
			}),
	});
	const ctx = context(cwd);

	for (const form of ["bare", "canonical"] as const) {
		gate = Promise.withResolvers<void>();
		promptLogPath = join(cwd, `prompt-${form}.log`);
		const launched = await execute.execute(
			`launch-${form}`,
			{ agent: "qa-echo", task: `wait for ${form} management`, async: true, artifacts: false },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const bareId = launched.details.asyncId;
		const canonicalPath = launched.details.results[0]?.path;
		assert.ok(bareId);
		assert.ok(canonicalPath);
		const id = form === "bare" ? bareId : canonicalPath;
		for (let attempt = 0; attempt < 200 && !existsSync(promptLogPath); attempt++) await sleep(5);
		assert.equal(existsSync(promptLogPath), true, "child prompt should start before management actions");
		assert.match(readFileSync(promptLogPath, "utf8"), /wait for/);

		const interrupted = await execute.execute(
			`interrupt-${form}`,
			{ action: "interrupt", id },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(interrupted.isError, undefined, text(interrupted));
		assert.match(text(interrupted), /Interrupt requested/);
		const completion = completions.at(-1);
		assert.equal(completion?.status, "interrupted");
		assert.equal(completion?.result?.status, "interrupted");
		assert.ok(completion?.result?.stats?.sessionId, "the typed interrupted result must retain session stats");
		assert.equal(completion?.envelope, "Interrupted");
		assert.equal(completion?.result?.envelope, "Interrupted");
		assert.doesNotMatch(JSON.stringify(completion), /unknown attempt/i);
		gate.resolve();
		const resumed = await execute.execute(
			`resume-${form}`,
			{ action: "resume", id, message: `continue ${form}` },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(resumed.isError, undefined, text(resumed));
		assert.match(text(resumed), /resumed ok/);
	}
});

test("a terminal run is removed from the live jobs widget and is not rehydrated", async () => {
	const cwd = makeRoot();
	const gate = Promise.withResolvers<void>();
	const events = new TestEvents();
	const { execute, state: currentState } = executor(cwd, events, {
		executeAsyncSingle: (id, params) =>
			executeAsyncSingle(id, {
				...params,
				testSession: { output: "terminal", promptGate: gate.promise },
			}),
	});
	const tracker = createAsyncJobTracker(
		{ events } as unknown as Pick<ExtensionAPI, "events">,
		currentState,
		join(cwd, "async"),
		{ completionRetentionMs: 0 },
	);
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, tracker.handleStarted);
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, tracker.handleComplete);
	const completed = Promise.withResolvers<void>();
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => completed.resolve());
	const ctx = context(cwd);

	const launched = await execute.execute(
		"widget-terminal",
		{ agent: "qa-echo", task: "finish after release", async: true, artifacts: false },
		new AbortController().signal,
		undefined,
		ctx,
	);
	const runId = launched.details.asyncId;
	assert.ok(runId);
	assert.ok(currentState.asyncJobs.has(runId));

	gate.resolve();
	await completed.promise;
	await sleep(10);
	assert.equal(currentState.asyncJobs.has(runId), false);

	tracker.hydrateActiveJobs(ctx);
	assert.equal(currentState.asyncJobs.has(runId), false, "terminal registry state must stay out of the live widget");
});
