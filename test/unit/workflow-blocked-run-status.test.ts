import { stripVTControlCharacters } from "node:util";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { workflowsListingItems } from "../../packages/workflows/src/tui/workflows-listing.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { defaultTheme } from "./overlay-graph-helpers.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

test("live views show a woken stage's recorded session-store block without changing saved status (#5534)", async () => {
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
	const blocked = await run(
		definition,
		{},
		{
			store,
			durableBackend: backend,
			releaseWhenWaiting: { afterMs: 0 },
			adapters: detachingAdapters(service, counters(), {
				resumable: true,
				failCreationAfter: 1,
				creationFailure: () =>
					new StorageUnavailableError({ adapter: "libsql", location: "sessions" }, new Error("offline")),
			}),
			onStageLifecycleEvent: (_runId, event) => {
				if (event.type === "stage_waiting") service.finishAll();
			},
		},
	);
	const id = blocked.runId;
	const source = store.run(id)!;
	assert.equal(blocked.failure?.kind, "unknown");
	assert.ok(source.blockedAt !== undefined);
	const called: string[] = [];
	const graph = new GraphView({
		mode: "overlay",
		runId: id,
		store,
		graphTheme: defaultTheme,
		piKeybindings: makeFakeKeybindings(),
		stageActions: {
			pauseRun: async () => {
				called.push("pause");
				return { ok: true, message: "paused" };
			},
			resumeRun: async (target) => {
				called.push(target);
				return { ok: false, message: "not admitted" };
			},
		},
	});
	try {
		const frame = stripVTControlCharacters(graph.render(160).join("\n"));
		const item = panelItemsFromSnapshot(store.runs()).find((row) => row.id === `run:${id}`)!;
		const execute = makeExecuteWorkflowTool(
			() => {
				throw Error("unexpected runtime lookup");
			},
			() => undefined,
			undefined,
			{ ...captureWorkflowOwnerResources(), store },
		);
		const all = await execute({ action: "status" }, {});
		const exact = await execute({ action: "status", runId: id }, {});
		const filtered = await execute({ action: "status", statusFilter: "blocked" }, {});
		const working = await execute({ action: "status", statusFilter: "running" }, {});
		assert.deepEqual(
			{
				indicator: runIndicatorStatus(source, store.runs()),
				header: frame.includes("↑ blocked"),
				resume: frame.includes("r resume run"),
				pause: frame.includes("p pause run"),
				list: workflowsListingItems([source])[0]?.description?.startsWith("blocked · "),
				card: renderStatusList([source], { width: 160 }).includes("↑ blocked"),
				tasks: /‖.*paused/u.test(
					stripVTControlCharacters(renderBoardRow({ kind: "item", id: item.id, item }, false, 120)),
				),
				panelRows: new AgentPanelModel().rows([item]).map((row) => row.id),
				text: renderWorkflowToolContent(all, { action: "status" }).includes(`${source.name}  blocked`),
				detailText: JSON.parse(renderWorkflowToolContent(exact, { action: "status", runId: id })).detail.status,
				savedList: all.action === "status" && all.runs[0]?.status,
				savedDetail: exact.action === "statusDetail" && "detail" in exact && exact.detail.status,
				blockedFilter: filtered.action === "status" && filtered.runs.length,
				runningFilter: renderWorkflowToolContent(working, { action: "status", statusFilter: "running" }).includes(
					`${source.name}  running`,
				),
			},
			{
				indicator: "blocked",
				header: true,
				resume: true,
				pause: false,
				list: true,
				card: true,
				tasks: true,
				panelRows: [],
				text: true,
				detailText: "blocked",
				savedList: "running",
				savedDetail: "running",
				blockedFilter: 0,
				runningFilter: true,
			},
		);
		graph.handleInput("p");
		graph.handleInput("r");
		assert.deepEqual(called, [id]);
	} finally {
		graph.dispose();
		await backend.close();
	}
});
