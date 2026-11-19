import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createGraphStageActions } from "../../packages/workflows/src/extension/workflow-graph-stage-actions.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphStageActionResult } from "../../packages/workflows/src/tui/graph-view-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { workflowsListingItems } from "../../packages/workflows/src/tui/workflows-listing.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { defaultTheme } from "./overlay-graph-helpers.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

function reopenDefinition() {
	return workflow({
		name: "reopen-after-wait",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.task("implement", { prompt: "watch ci" });
			return {};
		},
	});
}

for (const refused of ["checkpoint", "blocked status"] as const) {
	test(`a refused ${refused} write does not replace the stage reopen diagnostic`, async () => {
		const sql = new DatabaseSync(":memory:");
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(sql));
		const store = createStore();
		const service = new FakeCiService();
		const runId = "journal-refusal";
		let reopens = 0;
		const adapters = detachingAdapters(service, counters(), {
			resumable: true,
			failCreationAfter: 1,
			creationFailure: () => {
				reopens++;
				return new StorageUnavailableError({ adapter: "libsql", location: "sessions" }, new Error("offline"));
			},
		});
		const off = store.subscribe(() => {
			if (store.run(runId)?.blockedAt === undefined) return;
			const when =
				refused === "checkpoint"
					? "INSERT ON wf_events WHEN NEW.type='CheckpointRecorded'"
					: "UPDATE OF status ON wf_runs WHEN NEW.status='blocked'";
			sql.exec(`CREATE TRIGGER IF NOT EXISTS quota BEFORE ${when} BEGIN SELECT RAISE(ABORT,'quota exhausted'); END`);
		});
		try {
			const result = await run(
				reopenDefinition(),
				{},
				{
					runId,
					store,
					durableBackend: backend,
					releaseWhenWaiting: { afterMs: 0 },
					adapters,
					onStageLifecycleEvent: (_id, event) => {
						if (event.type === "stage_waiting") service.finishAll();
					},
				},
			);
			assert.equal(reopens, 3);
			assert.equal(service.dispatches, 1);
			assert.equal(result.failure?.disposition, "active_blocked");
			assert.match(result.error ?? "", /implement.*session-unavailable/);
			assert.equal(backend.getWorkflow(runId)?.status, refused === "checkpoint" ? "blocked" : "running");
			if (refused === "blocked status")
				assert.ok(store.notices().some((notice) => notice.message.includes("quota exhausted")));
		} finally {
			off();
			await backend.close();
		}
	});
}

test("a woken stage whose session store stays unreachable shows a block until the graph resumes it (#5534)", async () => {
	initTheme("dark", false);
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const service = new FakeCiService();
	const definition = reopenDefinition();
	const adapters = detachingAdapters(service, counters(), {
		resumable: true,
		failCreationAfter: 1,
		creationFailure: () =>
			new StorageUnavailableError({ adapter: "libsql", location: "sessions" }, new Error("offline")),
	});
	const notices: WorkflowLifecycleNoticeDetails[] = [];
	const stopNotices = installWorkflowLifecycleNotifications({
		store,
		state: createWorkflowLifecycleNotificationState(),
		config: { enabled: true, notifyOn: ["blocked"] },
		sendMessage(message) {
			notices.push((message as { details: WorkflowLifecycleNoticeDetails }).details);
		},
	});
	try {
		const blocked = await run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				releaseWhenWaiting: { afterMs: 0 },
				adapters,
				onStageLifecycleEvent: (_runId, event) => {
					if (event.type === "stage_waiting") service.finishAll();
				},
			},
		);
		const id = blocked.runId;
		const source = store.run(id);
		assert.ok(source && source.blockedAt !== undefined);
		assert.equal(blocked.status, "running");
		assert.equal(blocked.failure?.kind, "unknown");

		const owner = { ...captureWorkflowOwnerResources(), store, jobs: createJobTracker() };
		const runtime = createExtensionRuntime({
			...owner,
			definitions: [definition],
			adapters: {
				...detachingAdapters(service, counters(), { resumable: true }),
				sessionStore: adapters.sessionStore,
			},
		});
		const execute = makeExecuteWorkflowTool(runtime, () => undefined, undefined, owner);
		const status = await execute({ action: "status" }, {});
		const detail = await execute({ action: "status", runId: id }, {});
		const item = panelItemsFromSnapshot(store.runs()).find((row) => row.id === `run:${id}`);
		assert.ok(item);
		const actions = createGraphStageActions({ owner, runtime: () => runtime, context: () => undefined });
		let resume: Promise<GraphStageActionResult> | undefined;
		const graph = new GraphView({
			mode: "overlay",
			runId: id,
			store,
			graphTheme: defaultTheme,
			piKeybindings: makeFakeKeybindings(),
			stageActions: { ...actions, resumeRun: (runId) => (resume = actions.resumeRun!(runId)) },
		});
		try {
			const frame = stripVTControlCharacters(graph.render(160).join("\n"));
			assert.deepEqual(
				{
					indicator: runIndicatorStatus(source, store.runs()),
					graphHeader: frame.includes("↑ blocked"),
					graphResume: frame.includes("r resume run"),
					graphPause: frame.includes("p pause run"),
					listing: workflowsListingItems([source])
						.find((row) => row.id === `run:${id}`)
						?.description?.startsWith("blocked · "),
					statusCard: renderResult(status, { plain: true, width: 160 }).includes(`${source.name}  blocked`),
					toolList: renderWorkflowToolContent(status, { action: "status" }).includes(`${source.name}  blocked`),
					toolDetail: detail.action === "statusDetail" && "detail" in detail && detail.detail.status,
					tasks: /‖.*paused/u.test(
						stripVTControlCharacters(renderBoardRow({ kind: "item", id: item.id, item }, false, 120)),
					),
					panelRows: new AgentPanelModel().rows([item]).map((row) => row.id),
					notices: notices.map((n) => [n.kind, n.active, n.status, n.stageName, n.createdAt]),
				},
				{
					indicator: "blocked",
					graphHeader: true,
					graphResume: true,
					graphPause: false,
					listing: true,
					statusCard: true,
					toolList: true,
					toolDetail: "blocked",
					tasks: true,
					panelRows: [],
					notices: [["blocked", true, "blocked", "implement", source.blockedAt]],
				},
			);

			const seen: string[] = [];
			const unsubscribe = store.subscribe(() => {
				const current = store.run(id);
				if (current) seen.push(`${effectiveRunStatus(current)}:${current.blockedAt !== undefined}`);
			});
			try {
				graph.handleInput("r");
				assert.ok(resume, "r invoked resume");
				const admitted = await resume;
				assert.ok(admitted.ok, admitted.message);
				await owner.jobs.get(id)?.promise;
			} finally {
				unsubscribe();
			}
			assert.match(seen[0] ?? "", /^(pending|running):false$/, "the first resumed snapshot no longer has the block");
			assert.equal(seen.at(-1), "completed:false");
			assert.equal(service.dispatches, 1, "resume used the saved tool result");
		} finally {
			graph.dispose();
		}
	} finally {
		stopNotices();
	}
});
