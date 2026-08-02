// @ts-nocheck
import { describe, test } from "vitest";
import { testRunId } from "../helpers/run-id.js";
import type { ExtensionRuntime } from "./slash-dispatch-utils.js";
import {
	assert,
	createExtensionRuntime,
	createRegistry,
	installSlashDispatchTestHooks,
	makeExecuteWorkflowTool,
	makeInflightRun,
	renderResult,
	store,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("tool run-control actions", () => {
	function makeToolHandler() {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		return makeExecuteWorkflowTool(runtime, () => undefined);
	}

	function _makeDispatchTrackingWorkflowHandler(): {
		handler: ReturnType<typeof makeExecuteWorkflowTool>;
		wasDispatched: () => boolean;
	} {
		let dispatched = false;
		const runtime = {
			dispatch: async () => {
				dispatched = true;
				return {
					action: "run",
					runId: "unexpected",
					status: "running",
					stages: [],
				};
			},
		} as unknown as ExtensionRuntime;

		return {
			handler: makeExecuteWorkflowTool(runtime, () => undefined),
			wasDispatched: () => dispatched,
		};
	}

	function _restoreWorkflowStageGuard(previousGuard: string | undefined): void {
		if (previousGuard === undefined) {
			delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
			return;
		}
		process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
	}

	function _assertWorkflowToolBlocked(result: WorkflowToolResult, wasDispatched: () => boolean): void {
		assert.equal(wasDispatched(), false);
		assert.match((result as { error?: string }).error ?? "", /workflows cannot invoke workflows/);
	}
	test.sequential("makeExecuteWorkflowTool stages clones pending prompts", async () => {
		const runId = testRunId(`stage-tool-prompt-clone-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-prompt-clone",
			name: "ask",
			status: "awaiting_input",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStagePendingPrompt(runId, "stage-prompt-clone", {
			id: "prompt-clone",
			kind: "select",
			message: "Original?",
			choices: ["yes"],
			createdAt: Date.now(),
		});
		const handler = makeToolHandler();

		const result = await handler({ action: "stages", runId }, {} as never);

		assert.equal(result.action, "stages");
		const stages = result as {
			action: string;
			stages: Array<{
				pendingPrompt?: { message: string; choices?: string[] };
			}>;
		};
		assert.equal(stages.stages[0]?.pendingPrompt?.message, "Original?");
		stages.stages[0]!.pendingPrompt!.message = "Mutated";
		stages.stages[0]!.pendingPrompt!.choices!.push("no");
		const storedPrompt = store.runs().find((run) => run.id === runId)?.stages[0]?.pendingPrompt;
		assert.equal(storedPrompt?.message, "Original?");
		assert.deepEqual(storedPrompt?.choices, ["yes"]);
	});

	test.sequential("makeExecuteWorkflowTool stage rejects all-run inspection", async () => {
		const handler = makeToolHandler();

		const result = await handler({ action: "stage", all: true }, {} as never);

		assert.equal(result.action, "stage");
		const stage = result as {
			action: string;
			runId: string;
			error?: string;
		};
		assert.equal(stage.runId, "--all");
		assert.match(stage.error ?? "", /requires a single run/);
	});

	test.sequential("makeExecuteWorkflowTool stages supports all stage status filters", async () => {
		const runId = testRunId(`stage-tool-status-filters-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		for (const status of [
			"pending",
			"running",
			"awaiting_input",
			"paused",
			"blocked",
			"completed",
			"failed",
			"skipped",
		] as const) {
			store.recordStageStart(runId, {
				id: `stage-${status}`,
				name: status,
				status,
				parentIds: [],
				toolEvents: [],
			});
		}
		const handler = makeToolHandler();

		const completedResult = await handler({ action: "stages", runId, statusFilter: "completed" }, {} as never);

		assert.equal(completedResult.action, "stages");
		const completed = completedResult as {
			action: string;
			stages: Array<{ name: string; status: string }>;
		};
		assert.deepEqual(
			completed.stages.map(({ name, status }) => ({ name, status })),
			[{ name: "completed", status: "completed" }],
		);
	});

	test.sequential("makeExecuteWorkflowTool stages reports missing and ambiguous run targets", async () => {
		const handler = makeToolHandler();

		const missing = await handler({ action: "stages" }, {} as never);
		assert.equal(missing.action, "stages");
		const missingStages = missing as {
			action: string;
			runId: string;
			error?: string;
			stages: unknown[];
		};
		assert.equal(missingStages.runId, "");
		assert.deepEqual(missingStages.stages, []);
		assert.match(missingStages.error ?? "", /No active run to inspect/);
		assert.match(renderResult(missing, { plain: true }), /No active run to inspect/);

		const firstId = testRunId("stages-ambiguous-run-a");
		const secondId = testRunId("stages-ambiguous-run-b");
		store.recordRunStart(makeInflightRun(firstId));
		store.recordRunStart(makeInflightRun(secondId));
		const prefix = firstId.slice(0, 12);
		const malformed = await handler({ action: "stages", runId: prefix }, {} as never);
		assert.equal(malformed.action, "stages");
		const malformedStages = malformed as { action: string; runId: string; error?: string; stages: unknown[] };
		assert.equal(malformedStages.runId, prefix);
		assert.deepEqual(malformedStages.stages, []);
		assert.match(malformedStages.error ?? "", /Run id must be a full 36-character UUID/);
		assert.match(renderResult(malformed, { plain: true }), /Run id must be a full 36-character UUID/);
		assert.equal(
			store.runs().some((run) => run.id === firstId),
			true,
		);
		assert.equal(
			store.runs().some((run) => run.id === secondId),
			true,
		);
	});

	test.sequential("workflow status rejects run prefixes while full ids remain independently addressable", async () => {
		const anchor = testRunId("status-shared-prefix");
		const firstId = `${anchor.slice(0, 24)}111111111111`;
		const secondId = `${anchor.slice(0, 24)}222222222222`;
		store.recordRunStart(makeInflightRun(firstId));
		store.recordRunStart(makeInflightRun(secondId));
		const handler = makeToolHandler();

		const listed = await handler({ action: "status" }, {} as never);
		const rendered = renderResult(listed, { plain: true });
		assert.ok(rendered.includes(firstId));
		assert.ok(rendered.includes(secondId));

		const prefix = anchor.slice(0, 8);
		const malformed = await handler({ action: "status", runId: prefix }, {} as never);
		assert.equal(malformed.action, "statusDetail");
		const malformedDetail = malformed as { action: string; runId: string; error?: string };
		assert.equal(malformedDetail.runId, prefix);
		assert.match(malformedDetail.error ?? "", /Run id must be a full 36-character UUID/);

		for (const fullId of [firstId, secondId]) {
			const detail = await handler({ action: "status", runId: fullId }, {} as never);
			assert.equal(detail.action, "statusDetail");
			const statusDetail = detail as { action: string; runId: string; error?: string };
			assert.equal(statusDetail.runId, fullId);
			assert.equal(statusDetail.error, undefined);
		}
	});

	test.sequential("makeExecuteWorkflowTool returns chronologically final snapshot result after tools", async () => {
		const runId = testRunId(`stage-tool-transcript-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-transcript-1",
			name: "summarize",
			status: "completed",
			parentIds: [],
			toolEvents: [
				{
					name: "read",
					output: "file contents",
					startedAt: 1,
					endedAt: 2,
				},
			],
			result: "done",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
		});
		const handler = makeToolHandler();

		const result = await handler(
			{
				action: "transcript",
				runId,
				stageId: "summarize",
				tail: 1,
				includeToolOutput: true,
			},
			{} as never,
		);

		assert.equal(result.action, "transcript");
		const transcript = result as {
			action: string;
			source: string;
			entries: Array<{ role: string; text?: string; output?: string }>;
			truncated: boolean;
			sessionFile?: string;
			transcriptPath?: string;
		};
		assert.equal(transcript.source, "snapshot");
		assert.equal(transcript.sessionFile, "/tmp/session.jsonl");
		assert.equal(transcript.transcriptPath, "/tmp/session.jsonl");
		assert.equal(transcript.truncated, true);
		assert.deepEqual(transcript.entries, [{ role: "assistant", text: "done" }]);
	});
});
