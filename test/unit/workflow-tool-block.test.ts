import assert from "node:assert/strict";
import { readHintSpans, type TUI, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import type { ToolRenderers } from "../../packages/coding-agent/src/core/extensions/tool-types.js";
import type { MessageRenderer } from "../../packages/coding-agent/src/core/extensions/types.js";
import { renderChatMessageEntry } from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.js";
import {
	isToolBlock,
	ToolBlock,
	ToolBlockRecords,
} from "../../packages/coding-agent/src/modes/interactive/components/tool-block.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import { renderCall, workflowCallLabel } from "../../packages/workflows/src/extension/render-call.js";
import type { WorkflowRegisteredToolResult } from "../../packages/workflows/src/extension/render-result.js";
import {
	buildWorkflowStatusListing,
	summarizeRunSnapshot,
} from "../../packages/workflows/src/extension/workflow-status-summary.js";
import {
	callComponent,
	parseDefinitionError,
	shortReason,
	styledCallLine,
	summarizeWorkflowResult,
	WorkflowToolResultBlock,
	workflowBlockTheme,
} from "../../packages/workflows/src/extension/workflow-tool-block.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { registerWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store, StoreInvalidationListener } from "../../packages/workflows/src/shared/store-public-types.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { runFailureText } from "../../packages/workflows/src/tui/run-display-state.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const RUN_ID = "wf-run-1";
const START = 1_000_000;

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

test("successful body summaries cannot hide an admitted runtime failure (#5224)", () => {
	const runtimeError = "an admitted tool failed before the body returned";
	for (const status of ["completed", "ok", undefined]) {
		assert.equal(
			runFailureText({
				id: "promoted-failure",
				name: "promoted-failure",
				status: "failed",
				startedAt: START,
				inputs: {},
				stages: [],
				toolNodes: [],
				error: runtimeError,
				result: { ...(status === undefined ? {} : { status }), summary: "all clear" },
			}),
			runtimeError,
		);
	}
});

function usage(input: number, output: number): StageSnapshot["modelAttempts"] {
	return [{ model: "test/model", success: true, usage: { input, output } }];
}

function runningStore(): Store {
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "ralph",
		inputs: { prompt: "fix the shipping benchmark" },
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

function fiveStageStore(): Store {
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "ralph",
		inputs: { prompt: "fix the shipping benchmark" },
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: START,
	});
	store.recordStageStart(RUN_ID, stage("scout", "running", { startedAt: START }));
	store.recordStageEnd(
		RUN_ID,
		stage("scout", "completed", { startedAt: START, endedAt: START + 60_000, modelAttempts: usage(20_000, 500) }),
	);
	store.recordStageStart(RUN_ID, stage("plan", "running", { startedAt: START + 60_000 }));
	store.recordStageEnd(
		RUN_ID,
		stage("plan", "completed", {
			startedAt: START + 60_000,
			endedAt: START + 180_000,
			modelAttempts: usage(40_000, 500),
		}),
	);
	store.recordStageStart(RUN_ID, stage("implement", "running", { startedAt: START + 180_000 }));
	store.recordStageStart(RUN_ID, stage("verify", "pending"));
	store.recordStageStart(RUN_ID, stage("ship", "pending"));
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
		{ registerTool: () => {}, registerAgentPanelSource: () => ({ dispose() {} }) } as never,
		async () => STARTED as never,
		async (_policy, run) => run(),
		store === undefined ? {} : { runs: store },
	);
	if (tool === undefined) throw new Error("workflow tool was not registered");
	return tool;
}

function block(store: Store | undefined, invalidate: () => void = () => {}, expanded = false, nowOffset = 4_000) {
	return new WorkflowToolResultBlock(store, workflowBlockTheme(undefined), {
		agentPanel: true,
		now: () => START + nowOffset,
	}).update(STARTED, {
		expanded,
		isError: false,
		invalidate,
		args: { workflow: "ralph", inputs: { prompt: "fix the shipping benchmark" } },
	});
}

describe("the workflow tool call header (#5224)", () => {
	test("renders Workflow(name · description first line) and truncates before ) at 80 and 160 columns", () => {
		const args: WorkflowToolArgs = {
			workflow: "ralph",
			inputs: {
				prompt:
					"fix the shipping benchmark across all platforms and verify every eighty-column and one-hundred-sixty-column transcript row before closing the release lane",
			},
		};
		for (const width of [80, 160]) {
			const rendered = renderCall(args, { width });
			assert.ok(visibleWidth(rendered) <= width, `renderCall exceeds ${width}: ${visibleWidth(rendered)}`);
			assert.ok(rendered.endsWith(")"), `expected closing ) at width ${width}, got: ${rendered}`);
			const componentLines = plain(
				callComponent(styledCallLine(workflowCallLabel(args), workflowBlockTheme(undefined))).render(width),
			);
			assert.equal(componentLines.length, 1, `call header must never wrap at width ${width}`);
			assert.ok(visibleWidth(componentLines[0]!) <= width);
			assert.ok(componentLines[0]!.endsWith(")"), `callComponent must preserve ) at width ${width}`);
		}
		assert.match(renderCall(args, { width: 80 }), /^Workflow\(ralph · fix the shipping benchmark.*…\)$/);
	});

	test("sanitises terminal escapes, control characters, and bidi overrides in call header arguments", () => {
		const out = renderCall({
			workflow: "ralph\x1b[31m\u202e",
			inputs: { prompt: "first\x1b]8;;https://example.com\x07link\x1b]8;;\x07\nsecond line" },
		});
		assert.doesNotMatch(out, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
		assert.match(out, /^Workflow\(ralph<U\+202E> · firstlink\)$/);
	});
});

describe("the workflow tool's result line (#5224)", () => {
	test("a running run renders Running in background · stage 3/5 implement · 12m · ↓ 61.0k tokens · ↓ to manage", () => {
		const rendered = block(fiveStageStore(), () => {}, false, 12 * 60_000).render(160);
		const lines = plain(rendered);
		assert.equal(lines.length, 1);
		assert.equal(lines[0], "  ⎿  Running in background · stage 3/5 implement · 12m · ↓ 61.0k tokens · ↓ to manage");
		const manage = lines[0]!.lastIndexOf("↓ to manage");
		assert.deepEqual(
			readHintSpans(rendered[0]!).spans.map((span) => [span.start, span.end, span.action]),
			[[manage, manage + "↓ to manage".length, { kind: "key", key: "down" }]],
			"a click on ↓ to manage presses ↓",
		);
	});

	test("a completed run renders ✓ Completed in 4s · 3 stages · 32.4k tokens", () => {
		const store = runningStore();
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
		const lines = plain(block(store, () => {}, false, 4_000).render(160));
		assert.equal(lines.length, 1);
		assert.equal(lines[0], "  ⎿  ✓ Completed in 4s · 3 stages · 32.4k tokens");
	});

	test("a failed run renders ✗ Failed in 2s · stage implement · 1/3 stages · 9.4k tokens and strips stack frames", () => {
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "ralph",
			inputs: { prompt: "fix the shipping benchmark" },
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: START,
		});
		store.recordStageStart(RUN_ID, stage("plan", "running", { startedAt: START }));
		store.recordStageEnd(
			RUN_ID,
			stage("plan", "completed", { startedAt: START, endedAt: START + 1000, modelAttempts: usage(9_000, 400) }),
		);
		store.recordStageStart(RUN_ID, stage("implement", "running", { startedAt: START + 1000 }));
		store.recordStageEnd(RUN_ID, stage("implement", "failed", { startedAt: START + 1000, endedAt: START + 2000 }));
		store.recordStageStart(RUN_ID, stage("review", "pending"));
		vi.setSystemTime(START + 2000);
		store.recordRunEnd(RUN_ID, "failed", undefined, undefined, { failedStageId: "implement" });
		assert.equal(
			plain(block(store, () => {}, false, 2_000).render(160))[0],
			"  ⎿  ✗ Failed in 2s · stage implement · 1/3 stages · 9.4k tokens",
		);

		const withReason = runningStore();
		withReason.recordStageEnd(
			RUN_ID,
			stage("implement", "failed", { error: "Error: tests failed\n    at run (x.ts:1:1)" }),
		);
		vi.setSystemTime(START + 2000);
		withReason.recordRunEnd(RUN_ID, "failed", undefined, "Error: tests failed\n    at run (x.ts:1:1)", {
			failedStageId: "implement",
		});
		const line = plain(block(withReason, () => {}, false, 2_000).render(160))[0]!;
		assert.match(line, /^ {2}⎿ {2}✗ Failed in 2s · stage implement · 1\/3 stages · 12\.4k tokens · tests failed$/);
		assert.doesNotMatch(line, /x\.ts|at run/);
	});

	test("shortReason preserves legitimate messages starting with 'at ' and bounds oversized errors", () => {
		assert.equal(
			shortReason("Error: at capacity for worker pool\n    at run (x.ts:1:1)"),
			"at capacity for worker pool",
		);
		assert.equal(shortReason("at least 2 stages required"), "at least 2 stages required");
		assert.equal(shortReason("at most 1 active run allowed"), "at most 1 active run allowed");
		assert.equal(shortReason("at :12:3 unexpected token"), "at :12:3 unexpected token");
		assert.equal(
			shortReason(
				[
					"    \x1b[90mat Object.run [as execute] (/path with spaces/file.ts:12:4)\x1b[39m",
					"    at async Promise.all (index 0)",
					"    at <anonymous>",
					"Error: real failure after frames",
				].join("\n"),
			),
			"real failure after frames",
		);
		assert.equal(shortReason("    at run (x.ts:1:1)\n    at <anonymous>"), undefined);
		assert.equal(shortReason("   \n  "), undefined);
		const huge = `Error: ${"x".repeat(1_000_000)}\n    at run (x.ts:1:1)`;
		const bounded = shortReason(huge);
		assert.ok(bounded !== undefined);
		assert.equal(bounded.length, 240);
		assert.ok(bounded.endsWith("…"));
	});

	test("a stopped run renders ◼ Stopped in 13s · 2/5 stages · 19.4k tokens", () => {
		const store = fiveStageStore();
		store.recordStageEnd(
			RUN_ID,
			stage("scout", "completed", { startedAt: START, endedAt: START + 5000, modelAttempts: usage(10_000, 0) }),
		);
		store.recordStageEnd(
			RUN_ID,
			stage("plan", "completed", {
				startedAt: START + 5000,
				endedAt: START + 10_000,
				modelAttempts: usage(9_000, 400),
			}),
		);
		vi.setSystemTime(START + 13_000);
		store.recordRunEnd(RUN_ID, "cancelled", undefined, "stopped by user");
		assert.equal(
			plain(block(store, () => {}, false, 13_000).render(160))[0],
			"  ⎿  ◼ Stopped in 13s · 2/5 stages · 19.4k tokens",
		);
	});

	test("a paused run renders ⏸ Paused · stage 3/5 · ↓ to manage", () => {
		const store = fiveStageStore();
		store.recordRunPaused(RUN_ID, START + 2000);
		assert.equal(plain(block(store).render(160))[0], "  ⎿  ⏸ Paused · stage 3/5 · ↓ to manage");
	});

	test("a definition error renders Definition error, offending source line, caret, and dim guidance", () => {
		const errorText = [
			"Definition error: Unexpected token ')' (12:4)",
			"  const broken = workflow({",
			"                          ^",
			"Fix the workflow definition and run /reload.",
			"    at loadWorkflow (/repo/discovery.ts:44:11)",
		].join("\n");
		const row = new WorkflowToolResultBlock(undefined, workflowBlockTheme(undefined), {
			now: () => START,
		}).update(
			{ action: "run", name: "ralph", runId: "", status: "failed", error: errorText, stages: [] },
			{ expanded: false, isError: true, errorText, args: { workflow: "ralph" } },
		);
		const lines = plain(row.render(160));
		assert.deepEqual(lines, [
			"  ⎿  Definition error: Unexpected token ')' (12:4)",
			"     const broken = workflow({",
			"                             ^",
			"     Fix the workflow definition and run /reload.",
		]);
	});

	test("definition errors preserve text after terminal controls on supported Node versions (#5224)", () => {
		const failure = parseDefinitionError("Definition error: bad\x1b[2Jthing\x07\u202e");
		assert.equal(failure?.message, "badthing\\x07<U+202E>");
	});

	test("the line follows the run through blocked and resumable-failed states until permanent completion", () => {
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

		store.recordRunEnd(RUN_ID, "blocked", undefined, "budget limit reached");
		assert.equal(repaints, 1);
		assert.match(plain(row.render(160))[0]!, /! Blocked · 1\/3 stages · budget limit reached/);

		store.recordRunStart({
			...store.run(RUN_ID)!,
			status: "running",
			endedAt: undefined,
			durationMs: undefined,
			error: undefined,
		});
		assert.equal(repaints, 2, "resuming a blocked run refreshes the block");
		assert.match(plain(row.render(160))[0]!, /Running in background · stage 2\/3 implement/);

		store.recordRunEnd(RUN_ID, "failed", undefined, "transient failure", {
			failedStageId: "implement",
			resumable: true,
		});
		assert.equal(repaints, 3);
		assert.match(plain(row.render(160))[0]!, /✗ Failed/);

		store.recordRunStart({
			...store.run(RUN_ID)!,
			status: "running",
			endedAt: undefined,
			durationMs: undefined,
			error: undefined,
		});
		assert.equal(repaints, 4, "resuming a resumable failed run refreshes the block");
		assert.match(plain(row.render(160))[0]!, /Running in background/);

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
		assert.match(plain(row.render(160))[0]!, /^ {2}⎿ {2}✓ Completed in 4s · 3 stages · 32\.4k tokens$/);
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
		assert.equal(repaints, settled, "an ended completed run is no longer followed");
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
		vi.setSystemTime(START + 2000);
		store.recordRunEnd(RUN_ID, "failed", undefined, "tests failed: 3 of 12 checks did not pass", {
			failedToolNodeId: "tool:review",
		});
		assert.match(
			plain(block(store, () => {}, false, 2_000).render(160))[0]!,
			/✗ Failed in 2s · stage review · 1\/3 stages · 12\.4k tokens · tests failed: 3 of 12 checks did not pass/,
		);
	});

	test("a run the store no longer holds says what the call reported", () => {
		assert.match(
			plain(block(createStore()).render(160))[0]!,
			/^ {2}⎿ {2}Running in background · run wf-run-1 · ↓ to manage$/,
		);
	});

	test("the line fits 80 columns by dropping the trailing hint before cutting core text, and is whole at 160", () => {
		const store = fiveStageStore();
		const row = block(store, () => {}, false, 12 * 60_000);
		const wide = plain(row.render(160))[0]!;
		assert.equal(wide, "  ⎿  Running in background · stage 3/5 implement · 12m · ↓ 61.0k tokens · ↓ to manage");
		const narrow = plain(row.render(80))[0]!;
		assert.equal(narrow, "  ⎿  Running in background · stage 3/5 implement · 12m · ↓ 61.0k tokens");
		assert.ok(narrow.length <= 80);
		assert.doesNotMatch(narrow, /…/);
	});

	test("expanding shows the run's inputs, stages and outputs without /workflow slash commands", () => {
		const store = runningStore();
		store.recordStageEnd(RUN_ID, stage("implement", "completed", { startedAt: START + 1000, endedAt: START + 3000 }));
		store.recordStageEnd(RUN_ID, stage("review", "completed", { durationMs: 1000 }));
		vi.setSystemTime(START + 4000);
		store.recordRunEnd(RUN_ID, "completed", { summary: "fixed the bug" });
		const text = plain(block(store, () => {}, true).render(160)).join("\n");
		assert.match(text, /Inputs\n\s+prompt: fix the shipping benchmark/);
		assert.match(text, /Stages\n\s+✓ plan · 1s\n\s+✓ implement · 2s\n\s+✓ review · 1s/);
		assert.match(text, /Outputs\n\s+summary: fixed the bug/);
		assert.match(text, /run wf-run-1 · \/workflows\b/);
		assert.doesNotMatch(text, /\/workflow\s/);
	});

	test("a stage suspended while it waits shows the waiting mark on the expanded card, a paused stage the pause mark (#5489)", () => {
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "ralph",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: START,
		});
		store.recordStageStart(RUN_ID, stage("plan", "completed", { startedAt: START, endedAt: START + 1000 }));
		store.recordStageStart(
			RUN_ID,
			stage("implement", "suspended", {
				startedAt: START + 1000,
				wait: { kind: "tool", since: START + 2000, toolCalls: [{ toolCallId: "toolu_1", toolName: "bash" }] },
			}),
		);
		store.recordStageStart(RUN_ID, stage("review", "paused", { startedAt: START + 1000 }));
		const text = plain(block(store, () => {}, true).render(160)).join("\n");
		assert.match(text, /Stages\n\s+✓ plan · 1s\n\s+◌ implement · suspended/);
		assert.match(text, /\n\s+⏸ review · paused/);
		assert.doesNotMatch(text, /⏸ implement/);
	});

	test("a definition error in a normal non-error tool envelope returns a failure ToolBlock with ✗ header and outputPad", () => {
		const errorText = [
			"Definition error: Unexpected token ')' (12:4)",
			"  const broken = workflow({",
			"                          ^",
			"Fix the workflow definition and run /reload.",
			"    at loadWorkflow (/repo/discovery.ts:44:11)",
		].join("\n");
		const details: WorkflowRegisteredToolResult = {
			action: "run",
			name: "ralph",
			runId: "",
			status: "failed",
			error: errorText,
			stages: [],
		};
		const tool = registered();
		const args: WorkflowToolArgs = { workflow: "ralph" };
		const renderedComponent = tool.renderResult!(
			{ content: [{ type: "text", text: renderWorkflowToolContent(details, args) }], details, isError: false },
			{ expanded: false, isPartial: false },
			workflowBlockTheme(undefined) as never,
			{ args, isError: false, outputPad: 2 } as never,
		);
		assert.equal(renderedComponent instanceof ToolBlock, true);
		if (typeof renderedComponent === "string") throw new Error("expected component");
		assert.equal(isToolBlock(renderedComponent as never), true);
		assert.equal(renderedComponent.isWorking?.(), false);
		const lines = plain(renderedComponent.render(160));
		assert.deepEqual(lines, [
			"  ✗ Workflow(ralph)",
			"    ⎿  Definition error: Unexpected token ')' (12:4)",
			"       const broken = workflow({",
			"                               ^",
			"       Fix the workflow definition and run /reload.",
		]);
		assert.equal(
			renderWorkflowToolContent(details, args),
			JSON.stringify(details, null, 2),
			"model-facing payload remains byte-identical",
		);
	});

	test("isWorking() is cached O(1), true while running, false when paused/blocked/completed/disposed, and revives on resume", () => {
		const store = runningStore();
		const row = block(store);
		assert.equal(row.isWorking(), true);

		const childRunsSpy = vi.spyOn(store, "childRuns");
		for (let i = 0; i < 50; i++) {
			assert.equal(row.isWorking(), true);
		}
		assert.equal(childRunsSpy.mock.calls.length, 0, "isWorking() must not scan usage trees on watcher probes");
		childRunsSpy.mockRestore();

		store.recordRunPaused(RUN_ID, START + 2000);
		assert.equal(row.isWorking(), false);

		store.recordRunResumed(RUN_ID, START + 2500);
		assert.equal(row.isWorking(), true);

		store.recordRunEnd(RUN_ID, "blocked", undefined, "budget limit reached");
		assert.equal(row.isWorking(), false);

		store.recordRunStart({
			...store.run(RUN_ID)!,
			status: "running",
			endedAt: undefined,
			durationMs: undefined,
			error: undefined,
		});
		assert.equal(row.isWorking(), true);

		store.recordRunEnd(RUN_ID, "completed", { summary: "ok" });
		assert.equal(row.isWorking(), false);

		const runningAgain = block(runningStore());
		assert.equal(runningAgain.isWorking(), true);
		runningAgain.dispose();
		assert.equal(runningAgain.isWorking(), false);
	});

	test("WorkflowToolResultBlock is a ToolBlockRecords instance so ToolBlock does not double-prefix connectors", () => {
		const row = block(runningStore());
		assert.equal(row instanceof ToolBlockRecords, true);
	});

	test("returned failed or blocked status overrides raw completed status and prefers returned summary over caught stage error (#5224)", () => {
		const failedStore = runningStore();
		failedStore.recordStageEnd(
			RUN_ID,
			stage("implement", "failed", { error: "Error: process exited with code 1\n    at run (x.ts:1:1)" }),
		);
		vi.setSystemTime(START + 2000);
		failedStore.recordRunEnd(RUN_ID, "completed", {
			status: "failed",
			summary: "Tests failed in 2 packages",
		});
		const failedLine = plain(block(failedStore, () => {}, false, 2_000).render(160))[0]!;
		assert.match(
			failedLine,
			/✗ Failed in 2s · stage implement · 1\/3 stages · 12\.4k tokens · Tests failed in 2 packages/,
		);
		assert.doesNotMatch(failedLine, /process exited with code 1|Completed/);

		const blockedStore = runningStore();
		blockedStore.recordStageEnd(RUN_ID, stage("implement", "failed", { error: "Error: missing deploy token" }));
		vi.setSystemTime(START + 2000);
		blockedStore.recordRunEnd(RUN_ID, "completed", {
			status: "needs_human",
			remaining_work: "Provide staging credentials",
		});
		const blockedLine = plain(block(blockedStore, () => {}, false, 2_000).render(160))[0]!;
		assert.match(blockedLine, /! Blocked at implement · 1\/3 stages · Provide staging credentials/);
		assert.doesNotMatch(blockedLine, /missing deploy token|Completed/);
	});

	test("root pendingPrompt with leading blank line and canonical nested waiting questions are shown while superseded and orphaned children are ignored (#5224)", () => {
		const rootPromptStore = runningStore();
		rootPromptStore.editRun(RUN_ID, (run) => {
			run.pendingPrompt = {
				id: "prompt-root",
				kind: "confirm",
				message: "\n  Approve deployment window?\nmore details",
				createdAt: START + 1500,
			};
			return { run: true };
		});
		assert.match(
			plain(block(rootPromptStore).render(160))[0]!,
			/! Waiting for input · stage 2\/3 implement · 4s · Approve deployment window\?/,
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
		assert.match(cleanLine, /Running in background · stage 2\/2 deploy/);
		assert.doesNotMatch(cleanLine, /Stale prompt|Orphan prompt|Waiting for input/);

		let repaints = 0;
		const row = block(nestedStore, () => {
			repaints += 1;
		});
		assert.equal(row.isWorking(), true);
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
						message: "\n\tShip to prod-eu?",
						createdAt: START + 1200,
					},
				}),
			],
		});
		assert.equal(repaints, 1);
		assert.equal(row.isWorking(), false, "nested waiting stage pauses working status");
		assert.match(
			plain(row.render(160))[0]!,
			/! Waiting for input at confirm-region · stage 2\/2 deploy · 4s · Ship to prod-eu\?/,
		);

		nestedStore.recordStageAwaitingInput("child-orphan", "orphan-ask", true, START + 1300);
		assert.equal(repaints, 1);

		nestedStore.removeRun("grandchild-live");
		assert.equal(repaints, 2);
		assert.equal(row.isWorking(), true);
		assert.match(plain(row.render(160))[0]!, /Running in background · stage 2\/2 deploy/);
	});

	test("deep 10-level descendant removals invalidate waiting summaries and aggregate tokens without a depth-8 cutoff (#5224)", () => {
		const store = createStore();
		const runIds = [RUN_ID, ...Array.from({ length: 10 }, (_, index) => `nested-${index + 1}`)];
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
								modelAttempts: usage(5_000, 500),
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
		const row = new WorkflowToolResultBlock(source, workflowBlockTheme(undefined), {
			now: () => START + 4_000,
		}).update(STARTED, {
			expanded: false,
			isError: false,
			invalidate: () => {
				repaints += 1;
			},
		});
		try {
			assert.match(plain(row.render(160))[0]!, /Waiting for input at deep-ask.*Continue\?/);
			assert.equal(row.isWorking(), false);
			const removedId = runIds.at(-1)!;
			snapshots.delete(removedId);
			for (const listener of listeners) listener([{ runId: removedId }]);
			assert.equal(repaints, 1);
			assert.equal(row.isWorking(), true);
			assert.doesNotMatch(plain(row.render(160))[0]!, /Waiting for input/);
		} finally {
			row.dispose();
		}
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
		assert.match(plain(row.render(160))[0]!, /Running in background · stage 2\/3 implement/);
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

describe("every workflow action reads as one line collapsed and unboxed when expanded (#5224)", () => {
	const now = START;
	test("a status receipt keeps the running row for old readers and displays the captured block to the model", () => {
		const store = runningStore();
		store.recordRunBlocked(RUN_ID, "session offline", {
			failureRecoverability: "recoverable",
			resumable: true,
			blockedAt: START,
		});
		const captured = store.runs();
		const receipt = { action: "status" as const, ...buildWorkflowStatusListing(captured, "blocked", now) };
		const decoded = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
		assert.equal(decoded.runs[0]?.status, "running");
		assert.equal(decoded.snapshots[0]?.blockedAt, START);
		assert.equal(buildWorkflowStatusListing(captured, "running", now).runs.length, 0);
		assert.match(renderWorkflowToolContent(decoded, { action: "status" }), /ralph {2}blocked/);
		assert.equal(summarizeWorkflowResult(decoded, { now }).text, "1 run · 1 blocked");
	});

	test("ordinary saved status rows and failed indicators render with only their recorded fields", () => {
		const store = runningStore();
		const strict = () =>
			new Proxy(JSON.parse(JSON.stringify(store.run(RUN_ID))) as NonNullable<ReturnType<Store["run"]>>, {
				get(target, key, receiver) {
					if (typeof key === "string" && !(key in target)) throw new Error(`Unsupported snapshot field: ${key}`);
					return Reflect.get(target, key, receiver);
				},
			});
		const summary = summarizeRunSnapshot(store.run(RUN_ID)!, now);
		assert.equal(
			summarizeWorkflowResult({ action: "status", filter: "all", runs: [summary], snapshots: [strict()] }, { now })
				.text,
			"1 run · 1 running",
		);
		store.recordRunEnd(RUN_ID, "failed", { status: "failed" });
		assert.equal(runIndicatorStatus(strict()), "failed");
	});

	test("repainting the same collapsed status receipt does not reopen its captured rows", () => {
		const store = runningStore();
		const snapshot = store.run(RUN_ID)!;
		let reads = 0;
		const snapshots = new Proxy([snapshot], {
			get(target, key, receiver) {
				if (key === "0") reads++;
				return Reflect.get(target, key, receiver);
			},
		});
		const receipt = {
			action: "status",
			filter: "all",
			runs: [summarizeRunSnapshot(snapshot, now)],
			snapshots,
		} satisfies WorkflowRegisteredToolResult;
		const view = { expanded: false, isError: false };
		const row = new WorkflowToolResultBlock(undefined, workflowBlockTheme(undefined)).update(receipt, view);
		assert.match(plain(row.render(160))[0]!, /1 running/);
		const initialReads = reads;
		for (const width of [80, 160, 40]) assert.match(plain(row.update(receipt, view).render(width))[0]!, /1 running/);
		assert.equal(reads, initialReads);
		const next = { ...receipt, snapshots: [{ ...snapshot, blockedAt: 1 }] };
		assert.match(plain(row.update(next, view).render(160))[0]!, /1 blocked/);
		row.dispose();
	});

	test("a saved status tally honors a block recorded on its own run (#5534)", () => {
		const store = runningStore();
		store.recordRunBlocked(RUN_ID, "session store unavailable", {
			failureKind: "unknown",
			failureRecoverability: "recoverable",
			resumable: true,
			blockedAt: START,
		});
		const marked = store.run(RUN_ID)!;
		const row = { ...summarizeRunSnapshot(marked, now), status: "running" as const };
		const tally = (snapshots: (typeof marked)[]) =>
			summarizeWorkflowResult({ action: "status", filter: "all", runs: [row], snapshots }, { now }).text;
		assert.equal(tally([marked]), "1 run · 1 blocked");
		assert.equal(tally([{ ...marked, id: "other-run" }]), "1 run · 1 running");
		assert.equal(tally([]), "1 run · 1 running");
	});
	const cases: Array<[string, WorkflowRegisteredToolResult, RegExp]> = [
		[
			"list",
			{
				action: "list",
				items: [
					{ name: "a", description: "Alpha", inputs: [] },
					{ name: "b", description: "Beta", inputs: [] },
					{ name: "c", description: "Gamma", inputs: [] },
					{ name: "d", description: "Delta", inputs: [] },
				],
			},
			/^4 workflows: a, b, c, \+1 more$/,
		],
		["empty status", { action: "status", filter: "all", runs: [], snapshots: [] }, /^No runs$/],
		[
			"inputs",
			{ action: "inputs", name: "ralph", inputs: [{ name: "prompt", type: "string", required: true }] },
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
			const expanded = new WorkflowToolResultBlock(undefined, workflowBlockTheme(undefined), {
				now: () => now,
			})
				.update(result, { expanded: true, isError: false })
				.render(80);
			const text = plain(expanded).join("\n");
			assert.equal(text.includes("╭"), false, `${name} expanded must not render a rounded box`);
			assert.equal(text.includes("╰"), false, `${name} expanded must not render a rounded box`);
		});
	}
});

describe("the workflow tool row renders the same wherever a chat shows it (#5224)", () => {
	const ui = { requestRender: () => {} } as unknown as TUI;
	const args: WorkflowToolArgs = { workflow: "ralph", inputs: { prompt: "fix the shipping benchmark" } };
	const result = {
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "workflow",
		timestamp: START,
		content: [{ type: "text" as const, text: renderWorkflowToolContent(STARTED, args) }],
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

	test("registered tool uses default shell and preserves model-facing content", async () => {
		const tool = registered(runningStore());
		assert.equal(tool.renderShell, undefined);
		const executed = await tool.execute("call-1", args, undefined, undefined, {} as never);
		assert.equal(executed.content[0]?.type, "text");
		if (executed.content[0]?.type === "text") {
			assert.equal(executed.content[0].text, renderWorkflowToolContent(STARTED, args));
		}
	});

	test("with NO_COLOR the raw row carries no colour sequences, while a coloured terminal still gets them", () => {
		const colour = /\x1b\[(?:3[0-7]|9[0-7]|38;|4[0-7]|48;)[0-9;]*m/;
		const definition = registered(runningStore()) as unknown as ToolRenderers;
		vi.stubEnv("NO_COLOR", undefined);
		try {
			assert.match(mainChat(definition, false).render(80).join("\n"), colour);
			vi.stubEnv("NO_COLOR", "1");
			for (const expanded of [false, true]) {
				const raw = mainChat(definition, expanded).render(80).join("\n");
				assert.match(stripVTControlCharacters(raw), /Workflow\(ralph · fix the shipping benchmark\)/);
				assert.doesNotMatch(raw, colour);
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});

	for (const expanded of [false, true]) {
		for (const width of [80, 160]) {
			test(`${expanded ? "expanded" : "collapsed"} at ${width} columns`, () => {
				const definition = registered(runningStore()) as unknown as ToolRenderers;
				const main = mainChat(definition, expanded).render(width);
				const hosted = chatSessionHost(definition, expanded).render(width);
				assert.deepEqual(hosted, main);
				const text = plain(main).join("\n");
				assert.match(text, /Workflow\(ralph · fix the shipping benchmark\)/);
				assert.match(text, /⎿ {2}Running in background · stage 2\/3 implement/);
				assert.match(plain(main)[2] ?? "", /^ {3}⎿ {2}Running in background · stage 2\/3 implement/);
				assert.doesNotMatch(text, /⎿\s+⎿/);
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
				assert.equal(text[0], ' ✗ Workflow "ralph" failed · at review · 12s');
				if (!expanded) assert.equal(text.length, 1);
			});
		}
	}
});
