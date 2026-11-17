import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, onTestFinished, test, vi } from "vitest";
import type { ToolRenderers } from "../../packages/coding-agent/src/core/extensions/tool-types.js";
import type { MessageRenderer } from "../../packages/coding-agent/src/core/extensions/types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { renderChatMessageEntry } from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowRegisteredToolResult } from "../../packages/workflows/src/extension/render-result.js";
import {
	shortReason,
	summarizeWorkflowResult,
	WorkflowToolResultBlock,
	workflowBlockTheme,
} from "../../packages/workflows/src/extension/workflow-tool-block.js";
import { registerWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store, StoreInvalidationListener } from "../../packages/workflows/src/shared/store-public-types.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const RUN_ID = "wf-run-1";
const START = 1_000_000;

test("workflow tool error previews retain prose, omit actual stack frames and bound long reasons (#5224)", () => {
	const error = [
		"\x1b[31m    at handler (/repo/workflow.ts:10:2)\x1b[0m",
		"at least one approval is required",
		"  at most two batches can run",
	].join("\n");
	assert.equal(shortReason(error), "at least one approval is required");
	assert.equal(shortReason("    at handler (/repo/workflow.ts:10:2)"), undefined);
	assert.equal(shortReason("\n   \n"), undefined);
	const large = shortReason(`Error: ${"x".repeat(1_000_000)}`);
	assert.ok(large);
	assert.ok(large.length <= 240);
	assert.ok(large.endsWith("…"));
	const rendered = new WorkflowToolResultBlock(undefined, workflowBlockTheme(undefined)).update(undefined, {
		expanded: true,
		isError: true,
		errorText: error,
	});
	const text = plain(rendered.render(80)).join("\n");
	assert.match(text, /at least one approval is required/);
	assert.match(text, /at most two batches can run/);
	assert.doesNotMatch(text, /at handler/);
});

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(START);
});

afterEach(() => {
	vi.useRealTimers();
});

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

function stage(id: string, status: StageSnapshot["status"], extra: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status, parentIds: [], toolEvents: [], ...extra };
}

function usage(input: number, output: number): StageSnapshot["modelAttempts"] {
	return [{ model: "test/model", success: true, usage: { input, output } }];
}

function runningStore(): Store {
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "ralph",
		inputs: { prompt: "fix the login bug" },
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: START,
	});
	store.recordStageStart(RUN_ID, stage("plan", "running", { startedAt: START }));
	store.recordStageEnd(
		RUN_ID,
		stage("plan", "completed", { startedAt: START, endedAt: START + 1000, modelAttempts: usage(12_000, 400) }),
	);
	store.recordStageStart(RUN_ID, stage("implement", "running", { startedAt: START + 1000 }));
	store.recordStageStart(RUN_ID, stage("review", "pending"));
	return store;
}

const STARTED: WorkflowRegisteredToolResult = {
	action: "run",
	name: "ralph",
	runId: RUN_ID,
	status: "running",
	message: "started in background",
};

function registered(store?: Store) {
	const tool = registerWorkflowTool(
		{ registerTool: () => {} },
		async () => STARTED as never,
		async (_policy, run) => run(),
		store === undefined ? {} : { runs: store },
	);
	if (tool === undefined) throw new Error("workflow tool was not registered");
	return tool;
}

function block(store: Store | undefined, invalidate: () => void = () => {}, expanded = false) {
	return new WorkflowToolResultBlock(store, workflowBlockTheme(undefined), { now: () => START + 4_000 }).update(
		STARTED,
		{ expanded, isError: false, invalidate, args: { workflow: "ralph", inputs: { prompt: "fix the login bug" } } },
	);
}

describe("the workflow tool's result line (#5224)", () => {
	test("a running run says its stage progress and tokens on one line", () => {
		const lines = plain(block(runningStore()).render(160));
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /^ {2}⎿ {2}∀ Running · 1\/3 stages · ↓ 12\.4k tokens/);
	});

	test("the line follows the run through the store and repaints only when it changes", () => {
		const store = runningStore();
		let repaints = 0;
		const row = block(store, () => {
			repaints += 1;
		});
		store.recordStageSession(RUN_ID, "implement", { sessionId: "s-1" });
		assert.equal(repaints, 0, "a change that leaves the line as it was does not repaint");
		store.recordRunStart({
			id: "other-run",
			name: "other",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: START,
		});
		assert.equal(repaints, 0, "another run's change does not repaint");
		store.recordStageAwaitingInput(RUN_ID, "implement", true, START + 2_000);
		assert.equal(repaints, 1);
		assert.match(plain(row.render(160))[0]!, /! Waiting for input at implement · 1\/3 stages/);
		store.recordStageEnd(
			RUN_ID,
			stage("implement", "completed", {
				startedAt: START + 1000,
				endedAt: START + 3000,
				modelAttempts: usage(20_000, 0),
			}),
		);
		store.recordStageEnd(RUN_ID, stage("review", "completed", { startedAt: START + 3000, endedAt: START + 4000 }));
		vi.setSystemTime(START + 4000);
		store.recordRunEnd(RUN_ID, "completed", { summary: "fixed" });
		assert.ok(repaints >= 2);
		assert.match(plain(row.render(160))[0]!, /✓ Completed in 4s · 3 stages · 32\.4k tokens/);
		const settled = repaints;
		store.recordRunStart({
			id: "third-run",
			name: "third",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: START,
		});
		store.editRun(RUN_ID, () => ({ run: true }));
		assert.equal(repaints, settled, "an ended run is no longer followed");
	});

	test("a failed run names its stage and the error's first line, never a stack frame", () => {
		const store = runningStore();
		store.recordStageEnd(
			RUN_ID,
			stage("implement", "failed", { error: "Error: tests failed\n    at run (x.ts:1:1)" }),
		);
		store.recordRunEnd(RUN_ID, "failed", undefined, "Error: tests failed\n    at run (x.ts:1:1)", {
			failedStageId: "implement",
		});
		const line = plain(block(store).render(160))[0]!;
		assert.match(line, /✗ Failed at implement · tests failed/);
		assert.doesNotMatch(line, /x\.ts|at run/);
	});

	test("a run whose tool failed names the tool", () => {
		const store = runningStore();
		store.recordToolNodeStart(RUN_ID, {
			kind: "tool",
			id: "tool:review",
			name: "review",
			argsHash: "h",
			ordinal: 0,
			parentIds: [],
			status: "running",
			attachable: false,
		});
		store.recordRunEnd(RUN_ID, "failed", undefined, "tests failed: 3 of 12 checks did not pass", {
			failedToolNodeId: "tool:review",
		});
		assert.match(
			plain(block(store).render(160))[0]!,
			/✗ Failed at review · tests failed: 3 of 12 checks did not pass/,
		);
	});

	test("a paused run says where it paused", () => {
		const store = runningStore();
		store.recordRunPaused(RUN_ID, START + 2000);
		assert.match(plain(block(store).render(160))[0]!, /⏸ Paused at implement · 1\/3 stages/);
	});

	test("a run the store no longer holds says what the call reported", () => {
		assert.match(plain(block(createStore()).render(160))[0]!, /∀ Started in the background · run wf-run-1/);
	});

	test("the line fits 80 columns and is whole at 160", () => {
		const store = runningStore();
		for (const width of [80, 160]) {
			const lines = block(store).render(width);
			assert.equal(lines.length, 1);
			assert.ok(stripVTControlCharacters(lines[0]!).length <= width);
		}
		assert.doesNotMatch(plain(block(store).render(160))[0]!, /…/);
	});

	test("a line too long for its width drops its key hint before it cuts its text", () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		onTestFinished(() => setKeybindings(previous));
		const store = runningStore();
		store.recordRunEnd(RUN_ID, "failed", undefined, "tests failed: 3 of 12 checks did not pass", {
			failedStageId: "implement",
		});
		const row = new WorkflowToolResultBlock(store, workflowBlockTheme(undefined), { now: () => START }).update(
			STARTED,
			{ expanded: false, isError: false },
		);
		const wide = plain(row.render(160))[0]!;
		assert.match(wide, /\(ctrl\+o to expand\)$/);
		const narrow = plain(row.render(80))[0]!;
		assert.doesNotMatch(narrow, /ctrl\+o/);
		assert.ok(narrow.length <= 80);
	});

	test("expanding shows the run's inputs, stages and outputs", () => {
		const store = runningStore();
		store.recordStageEnd(RUN_ID, stage("implement", "completed", { startedAt: START + 1000, endedAt: START + 3000 }));
		store.recordStageEnd(RUN_ID, stage("review", "completed", { durationMs: 1000 }));
		vi.setSystemTime(START + 4000);
		store.recordRunEnd(RUN_ID, "completed", { summary: "fixed the bug" });
		const text = plain(block(store, () => {}, true).render(160)).join("\n");
		assert.match(text, /Inputs\n\s+prompt: fix the login bug/);
		assert.match(text, /Stages\n\s+✓ plan · 1s\n\s+✓ implement · 2s\n\s+✓ review · 1s/);
		assert.match(text, /Outputs\n\s+summary: fixed the bug/);
		assert.match(text, /run wf-run-1 · \/workflows wf-run-1/);
		assert.doesNotMatch(text, /\/workflow status/);
	});

	test("returned failed or blocked status overrides raw completed status and prefers returned summary over caught stage error (#5224)", () => {
		const failedStore = runningStore();
		failedStore.recordStageEnd(
			RUN_ID,
			stage("implement", "failed", { error: "Error: process exited with code 1\n    at run (x.ts:1:1)" }),
		);
		failedStore.recordRunEnd(RUN_ID, "completed", {
			status: "failed",
			summary: "Tests failed in 2 packages",
		});
		const failedLine = plain(block(failedStore).render(160))[0]!;
		assert.match(failedLine, /✗ Failed at implement · Tests failed in 2 packages/);
		assert.doesNotMatch(failedLine, /process exited with code 1|Completed/);

		const blockedStore = runningStore();
		blockedStore.recordStageEnd(RUN_ID, stage("implement", "failed", { error: "Error: missing deploy token" }));
		blockedStore.recordRunEnd(RUN_ID, "completed", {
			status: "needs_human",
			remaining_work: "Provide staging credentials",
		});
		const blockedLine = plain(block(blockedStore).render(160))[0]!;
		assert.match(blockedLine, /! Blocked at implement · Provide staging credentials/);
		assert.doesNotMatch(blockedLine, /missing deploy token|Completed/);
	});

	test("root pendingPrompt and canonical nested waiting questions are shown while superseded and orphaned children are ignored (#5224)", () => {
		const rootPromptStore = runningStore();
		rootPromptStore.editRun(RUN_ID, (run) => {
			run.pendingPrompt = {
				id: "prompt-root",
				kind: "confirm",
				message: "Approve deployment window?",
				createdAt: START + 1500,
			};
			return { run: true };
		});
		assert.match(
			plain(block(rootPromptStore).render(160))[0]!,
			/! Waiting for input · 1\/3 stages · Approve deployment window\?/,
		);

		const nestedStore = createStore();
		nestedStore.recordRunStart({
			id: RUN_ID,
			name: "ralph",
			inputs: {},
			status: "running",
			toolNodes: [],
			startedAt: START,
			stages: [
				stage("compose", "completed", {
					workflowChild: {
						runId: "child-current",
						workflow: "child",
						alias: "child",
						status: "completed",
						outputs: {},
					},
					workflowChildRun: { runId: "child-stale", workflow: "child", alias: "child" },
				}),
				stage("deploy", "running", {
					workflowChildRun: { runId: "child-live", workflow: "deploy-child", alias: "deploy-child" },
				}),
			],
		});
		nestedStore.recordRunStart({
			id: "child-current",
			name: "child",
			inputs: {},
			status: "completed",
			parentRunId: RUN_ID,
			parentStageId: "compose",
			rootRunId: RUN_ID,
			toolNodes: [],
			startedAt: START,
			endedAt: START + 500,
			stages: [stage("done", "completed")],
		});
		nestedStore.recordRunStart({
			id: "child-stale",
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: RUN_ID,
			parentStageId: "compose",
			rootRunId: RUN_ID,
			toolNodes: [],
			startedAt: START,
			stages: [
				stage("stale-ask", "awaiting_input", {
					pendingPrompt: {
						id: "p-stale",
						kind: "confirm",
						message: "Stale prompt must not appear",
						createdAt: START + 100,
					},
				}),
			],
		});
		nestedStore.recordRunStart({
			id: "child-orphan",
			name: "orphan",
			inputs: {},
			status: "running",
			parentRunId: RUN_ID,
			parentStageId: "deploy",
			rootRunId: RUN_ID,
			toolNodes: [],
			startedAt: START,
			stages: [
				stage("orphan-ask", "awaiting_input", {
					pendingPrompt: {
						id: "p-orphan",
						kind: "confirm",
						message: "Orphan prompt must not appear",
						createdAt: START + 100,
					},
				}),
			],
		});
		nestedStore.recordRunStart({
			id: "child-live",
			name: "deploy-child",
			inputs: {},
			status: "running",
			parentRunId: RUN_ID,
			parentStageId: "deploy",
			rootRunId: RUN_ID,
			toolNodes: [],
			startedAt: START,
			stages: [stage("prep", "running")],
		});
		const cleanLine = plain(block(nestedStore).render(160))[0]!;
		assert.match(cleanLine, /∀ Running · 1\/2 stages/);
		assert.doesNotMatch(cleanLine, /Stale prompt|Orphan prompt|Waiting for input/);

		let repaints = 0;
		const row = block(nestedStore, () => {
			repaints += 1;
		});
		nestedStore.recordStageStart(
			"child-live",
			stage("sub-deploy", "running", {
				workflowChildRun: { runId: "grandchild-live", workflow: "sub", alias: "sub" },
			}),
		);
		nestedStore.recordRunStart({
			id: "grandchild-live",
			name: "sub",
			inputs: {},
			status: "running",
			parentRunId: "child-live",
			parentStageId: "sub-deploy",
			rootRunId: RUN_ID,
			toolNodes: [],
			startedAt: START + 1000,
			stages: [
				stage("confirm-region", "awaiting_input", {
					pendingPrompt: {
						id: "p-grandchild",
						kind: "confirm",
						message: "Ship to prod-eu?",
						createdAt: START + 1200,
					},
				}),
			],
		});
		assert.equal(repaints, 1);
		assert.match(
			plain(row.render(160))[0]!,
			/! Waiting for input at confirm-region · 1\/2 stages · Ship to prod-eu\?/,
		);

		nestedStore.recordStageAwaitingInput("child-orphan", "orphan-ask", true, START + 1300);
		assert.equal(repaints, 1);

		nestedStore.removeRun("grandchild-live");
		assert.equal(repaints, 2);
		assert.match(plain(row.render(160))[0]!, /∀ Running · 1\/2 stages/);
	});

	test("deep descendant removals invalidate waiting summaries without a fixed nesting cutoff (#5224)", () => {
		const store = createStore();
		const runIds = [RUN_ID, ...Array.from({ length: 9 }, (_, index) => `nested-${index + 1}`)];
		for (const [index, runId] of runIds.entries()) {
			const childId = runIds[index + 1];
			store.recordRunStart({
				id: runId,
				name: runId,
				inputs: {},
				status: "running",
				startedAt: START,
				toolNodes: [],
				...(index === 0 ? {} : { parentRunId: runIds[index - 1]!, parentStageId: "nested", rootRunId: RUN_ID }),
				stages: childId
					? [
							stage("nested", "running", {
								workflowChildRun: { runId: childId, workflow: "child", alias: "child" },
							}),
						]
					: [
							stage("deep-ask", "awaiting_input", {
								pendingPrompt: { id: "deep-prompt", kind: "confirm", message: "Continue?", createdAt: START },
							}),
						],
			});
		}
		const snapshots = new Map(runIds.map((runId) => [runId, store.run(runId)!] as const));
		const listeners = new Set<StoreInvalidationListener>();
		const source = {
			run: (runId: string) => snapshots.get(runId),
			childRuns: (parentRunId: string) => [...snapshots.values()].filter((run) => run.parentRunId === parentRunId),
			subscribeInvalidation(listener: StoreInvalidationListener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		let repaints = 0;
		const row = new WorkflowToolResultBlock(source, workflowBlockTheme(undefined)).update(STARTED, {
			expanded: false,
			isError: false,
			invalidate: () => {
				repaints += 1;
			},
		});
		try {
			assert.match(plain(row.render(160))[0]!, /Waiting for input at deep-ask/);
			const removedId = runIds.at(-1)!;
			snapshots.delete(removedId);
			for (const listener of listeners) listener([{ runId: removedId }]);
			assert.equal(repaints, 1);
			assert.doesNotMatch(plain(row.render(160))[0]!, /Waiting for input/);
		} finally {
			row.dispose();
		}
	});

	test("failed and blocked runs update when resumed or retried and release subscriptions once completed (#5224)", () => {
		const store = runningStore();
		let repaints = 0;
		const row = block(store, () => {
			repaints += 1;
		});
		store.recordStageEnd(RUN_ID, stage("implement", "failed", { error: "Error: transient failure" }));
		store.recordRunEnd(RUN_ID, "failed", undefined, "Error: transient failure", {
			failedStageId: "implement",
			resumable: true,
		});
		const afterFail = repaints;
		assert.match(plain(row.render(160))[0]!, /✗ Failed at implement · transient failure/);

		store.recordRunStart({
			id: RUN_ID,
			name: "ralph",
			inputs: { prompt: "fix the login bug" },
			status: "running",
			toolNodes: [],
			startedAt: START,
			stages: [
				stage("plan", "completed", { startedAt: START, endedAt: START + 1000 }),
				stage("implement", "running", { startedAt: START + 2000 }),
				stage("review", "pending"),
			],
		});
		assert.ok(repaints > afterFail);
		assert.match(plain(row.render(160))[0]!, /∀ Running · 1\/3 stages/);

		const afterResume = repaints;
		store.recordRunBlocked(RUN_ID, "Rate limit exceeded", {
			failureKind: "rate_limit",
			failureRecoverability: "recoverable",
			failureDisposition: "active_blocked",
			failureMessage: "Rate limit exceeded",
			failedStageId: "implement",
			resumable: true,
		});
		assert.ok(repaints > afterResume);
		assert.match(plain(row.render(160))[0]!, /! Blocked at implement · Rate limit exceeded/);

		const afterBlock = repaints;
		store.recordRunStart({
			id: RUN_ID,
			name: "ralph",
			inputs: { prompt: "fix the login bug" },
			status: "running",
			toolNodes: [],
			startedAt: START,
			stages: [
				stage("plan", "completed", { startedAt: START, endedAt: START + 1000 }),
				stage("implement", "completed", { startedAt: START + 2000, endedAt: START + 3000 }),
				stage("review", "completed", { startedAt: START + 3000, endedAt: START + 4000 }),
			],
		});
		vi.setSystemTime(START + 4000);
		store.recordRunEnd(RUN_ID, "completed", { summary: "fixed after retry" });
		assert.ok(repaints > afterBlock);
		assert.match(plain(row.render(160))[0]!, /✓ Completed in 4s · 3 stages/);

		const settled = repaints;
		store.editRun(RUN_ID, () => ({ run: true }));
		assert.equal(repaints, settled);
	});

	test("theme and source method receivers stay bound when invoked by the block (#5224)", () => {
		class BoundTheme {
			prefix = "[";
			suffix = "]";
			fg(_color: string, text: string): string {
				return `${this.prefix}${text}${this.suffix}`;
			}
			bold(text: string): string {
				return `${this.prefix}${text}${this.suffix}`;
			}
		}
		const adapted = workflowBlockTheme(new BoundTheme());
		const { fg, bold } = adapted;
		assert.equal(fg("accent", "x"), "[x]");
		assert.equal(bold("y"), "[y]");
		const store = runningStore();
		class BoundSource {
			inner = store;
			run(runId: string) {
				return this.inner.run(runId);
			}
			childRuns(parentRunId: string) {
				return this.inner.childRuns(parentRunId);
			}
			subscribeInvalidation(listener: Parameters<Store["subscribeInvalidation"]>[0]) {
				return this.inner.subscribeInvalidation(listener);
			}
		}
		const row = new WorkflowToolResultBlock(new BoundSource(), adapted, {
			now: () => START + 4_000,
		}).update(STARTED, { expanded: false, isError: false });
		assert.match(plain(row.render(160))[0]!, /Running · 1\/3 stages/);
		row.dispose();
	});

	test("disposing the row stops following its run", () => {
		const store = runningStore();
		let repaints = 0;
		const row = block(store, () => {
			repaints += 1;
		});
		row.dispose();
		store.recordRunEnd(RUN_ID, "completed");
		assert.equal(repaints, 0);
	});
});

describe("every workflow action reads as one line (#5224)", () => {
	const now = START;
	const cases: Array<[string, WorkflowRegisteredToolResult, RegExp]> = [
		[
			"list",
			{
				action: "list",
				items: [
					{ name: "a", description: "", inputs: [] },
					{ name: "b", description: "", inputs: [] },
					{ name: "c", description: "", inputs: [] },
					{ name: "d", description: "", inputs: [] },
				],
			},
			/^4 workflows: a, b, c, \+1 more$/,
		],
		["empty status", { action: "status", filter: "all", runs: [], snapshots: [] }, /^No runs$/],
		[
			"inputs",
			{ action: "inputs", name: "ralph", inputs: [{ name: "prompt", type: "string" }] },
			/^1 input: prompt$/,
		],
		[
			"stages",
			{
				action: "stages",
				runId: RUN_ID,
				filter: "all",
				stages: [
					{ id: "a", name: "a", status: "completed" },
					{ id: "b", name: "b", status: "running" },
				],
			},
			/^2 stages · 1 completed · 1 running$/,
		],
		[
			"answer",
			{ action: "answer", runId: RUN_ID, stageId: "review", message: "Answered review.", status: "ok" },
			/^Answered review\.$/,
		],
		[
			"pause failure",
			{
				action: "pause",
				runId: RUN_ID,
				status: "failed",
				message: "Run not found: x\nmore",
				code: "run_not_found",
			} as never,
			/^Run not found: x$/,
		],
		[
			"reload",
			{ action: "reload", status: "ok", message: "Reloaded 12 workflows." } as never,
			/^Reloaded 12 workflows\.$/,
		],
		[
			"models",
			{ action: "models", models: [{ provider: "p", id: "m", fullId: "p/m", isCurrent: true }] },
			/^1 model · current p\/m$/,
		],
		[
			"timeout",
			{
				action: "run",
				status: "failed",
				code: "WORKFLOW_TIMEOUT",
				timeoutMs: 150_000,
				error: "Workflow run request timed out after 150000ms. The outcome is unknown.",
			},
			/^Workflow run request timed out after 150000ms\. The outcome is unknown\.$/,
		],
	];
	for (const [name, result, expected] of cases) {
		test(name, () => {
			const summary = summarizeWorkflowResult(result, { now });
			assert.match(summary.text, expected);
			assert.doesNotMatch(summary.text, /\n/);
		});
	}
});

describe("the workflow tool row renders the same wherever a chat shows it (#5224)", () => {
	const ui = { requestRender: () => {} } as unknown as TUI;
	const args: WorkflowToolArgs = { workflow: "ralph", inputs: { prompt: "fix the login bug" } };
	const result = {
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "workflow",
		timestamp: START,
		content: [{ type: "text" as const, text: "started" }],
		details: STARTED,
		isError: false,
	};

	function mainChat(definition: ToolRenderers, expanded: boolean): ToolExecutionComponent {
		const component = new ToolExecutionComponent("workflow", "call-1", args, {}, definition, ui, process.cwd());
		component.setExpanded(expanded);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult(result, false);
		return component;
	}

	function chatSessionHost(definition: ToolRenderers, expanded: boolean) {
		const component = renderChatMessageEntry(
			{ role: "tool", kind: "tool", toolName: "workflow", toolCallId: "call-1", args, result },
			{ ui, cwd: process.cwd(), getToolDefinition: () => definition, toolOutputExpanded: expanded },
		);
		(component as ToolExecutionComponent).markExecutionStarted();
		(component as ToolExecutionComponent).setArgsComplete();
		return component;
	}

	for (const expanded of [false, true]) {
		for (const width of [80, 160]) {
			test(`${expanded ? "expanded" : "collapsed"} at ${width} columns`, () => {
				const definition = registered(runningStore()) as unknown as ToolRenderers;
				const main = mainChat(definition, expanded).render(width);
				const hosted = chatSessionHost(definition, expanded).render(width);
				assert.deepEqual(hosted, main);
				const text = plain(main).join("\n");
				assert.match(text, /Workflow\(ralph · fix the login bug\)/);
				assert.match(text, /⎿ {2}∀ Running · 1\/3 stages/);
				assert.equal(text.includes("╭"), false, "no rounded panel of its own");
			});
		}
	}
});

describe("a workflow's notice renders the same wherever a chat shows it (#5224)", () => {
	const ui = { requestRender: () => {} } as unknown as TUI;
	function noticeRenderer(): MessageRenderer {
		let registered: MessageRenderer | undefined;
		registerLifecycleNoticeRenderer({
			rendererHost: {},
			registerMessageRenderer: (_event, renderer) => {
				registered = renderer as unknown as MessageRenderer;
			},
		});
		if (registered === undefined) throw new Error("the lifecycle notice renderer was not registered");
		return registered;
	}
	const details: WorkflowLifecycleNoticeDetails = {
		kind: "failed",
		scope: "run",
		runId: RUN_ID,
		workflowName: "ralph",
		status: "failed",
		stageName: "review",
		durationMs: 12_000,
		error: "tests failed",
		createdAt: START,
	};
	const message = {
		role: "custom" as const,
		customType: LIFECYCLE_NOTICE_CUSTOM_TYPE,
		content: "failed",
		display: true,
		details,
		timestamp: START,
	};

	for (const expanded of [false, true]) {
		for (const width of [80, 160]) {
			test(`${expanded ? "expanded" : "collapsed"} at ${width} columns`, () => {
				const renderer = noticeRenderer();
				const main = new CustomMessageComponent(message, renderer);
				main.setExpanded(expanded);
				const hosted = renderChatMessageEntry(
					{ role: "custom", kind: "custom", message },
					{ ui, cwd: process.cwd(), getCustomMessageRenderer: () => renderer, toolOutputExpanded: expanded },
				);
				(hosted as CustomMessageComponent).setExpanded(expanded);
				const lines = main.render(width);
				assert.deepEqual(hosted.render(width), lines);
				const text = plain(lines).filter((line) => line.length > 0);
				assert.equal(text[0], '✗ Workflow "ralph" failed · at review · 12s');
				if (!expanded) assert.equal(text.length, 1);
			});
		}
	}
});
