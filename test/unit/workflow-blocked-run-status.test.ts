import { stripVTControlCharacters } from "node:util";
import { describe } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { inspectRun, statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { isTerminalOrBlockedRun } from "../../packages/workflows/src/tui/run-display-state.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { workflowsListingItems } from "../../packages/workflows/src/tui/workflows-listing.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { defaultTheme, makeStore } from "./overlay-graph-helpers.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** The session store's own failure while it is unreachable, as its adapter reports it. */
function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

const definition = workflow({
	name: "reopen-after-wait",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.task("implement", { prompt: "watch ci" });
		return {};
	},
});

/**
 * Runs the workflow until its released stage wakes and cannot reopen its session store: the engine blocks the run
 * resumably on that stage (#4309).
 */
async function blockOnUnreachableSessionStore() {
	const service = new FakeCiService();
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const notices: WorkflowLifecycleNoticeDetails[] = [];
	const stopNotices = installWorkflowLifecycleNotifications({
		store,
		state: createWorkflowLifecycleNotificationState(),
		config: { enabled: true, notifyOn: ["completed", "failed", "blocked", "awaiting_input"] },
		sendMessage(message) {
			const details = (message as { readonly details?: WorkflowLifecycleNoticeDetails }).details;
			if (details !== undefined) notices.push(details);
		},
	});
	const onStageLifecycleEvent = (_runId: string, event: StageLifecycleEvent) => {
		if (event.type === "stage_waiting") service.finishAll();
	};
	const adapters = detachingAdapters(service, counters(), {
		failCreationAfter: 1,
		creationFailure: () => storeUnavailable(),
		resumable: true,
	});
	const blocked = await run(
		definition,
		{},
		{ store, durableBackend: backend, releaseWhenWaiting: { afterMs: 0 }, adapters, onStageLifecycleEvent },
	);
	const source = store.run(blocked.runId);
	assert.ok(source);
	assert.equal(source.status, "running", "the block keeps the run live for a resume");
	assert.ok(source.blockedAt !== undefined);
	return {
		store,
		source,
		notices,
		stopNotices,
		resume: () =>
			run(
				definition,
				{},
				{
					runId: source.id,
					store,
					durableBackend: backend,
					releaseWhenWaiting: { afterMs: 0 },
					continuation: { source, resumeFromStageId: source.failedStageId },
					adapters: {
						...detachingAdapters(service, counters(), { resumable: true }),
						sessionStore: adapters.sessionStore,
					},
					onStageLifecycleEvent,
				},
			),
	};
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

/** The graph's footer keys for a run, with both run controls available. */
function graphFooter(target: RunSnapshot): string {
	const view = new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: target.id,
		store: makeStore({ runs: [target], notices: [], version: 1 }),
		graphTheme: defaultTheme,
		stageActions: {
			pauseRun: async () => ({ ok: true, message: "paused" }),
			resumeRun: async () => ({ ok: true, message: "resumed" }),
		},
	});
	try {
		return plain(view.render(160).join("\n"));
	} finally {
		view.dispose();
	}
}

describe("a run blocked on a stage whose session store stays unreachable reads as blocked everywhere", () => {
	test("its status, indicator, graph, status list, listing, workflow status, panel and notices all say blocked", async () => {
		const { store, source, notices, stopNotices } = await blockOnUnreachableSessionStore();
		try {
			const runId = source.id;
			assert.equal(effectiveRunStatus(source), "blocked");
			assert.equal(runIndicatorStatus(source, store.runs()), "blocked", "the run indicator");
			assert.equal(isTerminalOrBlockedRun(source), true);

			assert.match(
				plain(renderHeader(source, { width: 120, theme: defaultTheme })[1]!),
				/↑ blocked/,
				"graph header",
			);
			const footer = graphFooter(source);
			assert.match(footer, /r resume run/, "the graph offers to resume the run");
			assert.doesNotMatch(footer, /p pause run/, "and not to pause a run that is not working");
			const statusRow = plain(renderStatusList([source], { theme: defaultTheme, width: 100 }))
				.split("\n")
				.find((line) => line.includes(source.name));
			assert.match(statusRow ?? "", /↑ blocked/, "status list");
			const listing = workflowsListingItems([source]).find((item) => item.id === `run:${runId}`);
			assert.match(listing?.description ?? "", /^blocked · /, "/workflows listing");

			assert.equal(statusRuns({ store }).find((entry) => entry.runId === runId)?.status, "blocked", "status");
			const inspected = inspectRun(runId, { store });
			assert.ok(inspected.ok);
			assert.equal(inspected.detail.status, "blocked", "status of one run");

			const item = panelItemsFromSnapshot(store.runs()).find((candidate) => candidate.id === `run:${runId}`);
			assert.equal(item?.state, "paused", "the agent panel and /tasks rest it like a paused run");

			const blockedNotices = notices.filter((notice) => notice.runId === runId && notice.kind === "blocked");
			assert.equal(blockedNotices.length, 1, "one blocked notice");
			assert.equal(blockedNotices[0]?.status, "blocked");
			assert.equal(blockedNotices[0]?.active, true);
			assert.equal(blockedNotices[0]?.stageName, "implement");
			assert.equal(blockedNotices[0]?.createdAt, source.blockedAt);
		} finally {
			stopNotices();
		}
	});

	test("a resume clears the block in its first update, and the resumed run completes", async () => {
		const { store, source, stopNotices, resume } = await blockOnUnreachableSessionStore();
		stopNotices();
		const seen: string[] = [];
		const unsubscribe = store.subscribe(() => {
			const current = store.run(source.id);
			if (current === undefined) return;
			const state = `${effectiveRunStatus(current)}|${runIndicatorStatus(current, store.runs())}`;
			if (seen.at(-1) !== state) seen.push(state);
		});
		try {
			const resumed = await resume();
			assert.equal(resumed.status, "completed", resumed.error);
		} finally {
			unsubscribe();
		}
		assert.ok(seen.length > 0);
		assert.ok(
			seen.every((state) => !state.includes("blocked")),
			`no update of the resumed run reads blocked: ${seen.join(", ")}`,
		);
		assert.equal(seen.at(-1), "completed|completed");
	});
});
