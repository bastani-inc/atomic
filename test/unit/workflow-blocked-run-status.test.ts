import { stripVTControlCharacters } from "node:util";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
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

test("a woken stage whose session store stays unreachable shows a block until the graph resumes it (#5534)", async () => {
	initTheme("dark", false);
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const service = new FakeCiService();
	const definition = workflow({
		name: "reopen-after-wait",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.task("implement", { prompt: "watch ci" });
			return {};
		},
	});
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
					toolList: status.action === "status" && status.runs[0]?.status,
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
					toolList: "blocked",
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
