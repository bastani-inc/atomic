/**
 * A stage on a local worker that asks `ask_user_question` shows the same form an in-process
 * stage shows (#3996): in the attached stage chat, and through an SDK caller's `stageUiBroker`.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, test, vi } from "vitest";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run as engineRun } from "../../packages/workflows/src/engine/run.js";
import { createStore, loadWorkerWorkflow, run } from "../../packages/workflows/src/index.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { POOL_QUESTION } from "../fixtures/pool-question-child.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process and a worker process running a child workflow with an agent stage. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
const CONDITION_TIMEOUT_MS = 60_000;

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { fileURLToPath } = await import("node:url");
	const sourceEntry = fileURLToPath(
		new URL("../../packages/workflows/src/workers/local-worker-entry.mjs", import.meta.url),
	);
	const packagedEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	return {
		...actual,
		fork: (modulePath: string | URL, args: readonly string[], options: ForkOptions) =>
			actual.fork(modulePath === sourceEntry ? packagedEntry : modulePath, args, options),
	};
});

beforeAll(async () => {
	initTheme("dark", false);
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

const childPath = fileURLToPath(new URL("../fixtures/pool-question-child.ts", import.meta.url));

function parentOf(child: Awaited<ReturnType<typeof loadWorkerWorkflow>>) {
	return workflow({
		name: "pool-question-root",
		description: "",
		inputs: {},
		outputs: { text: Type.String() },
		async run(ctx) {
			const result = await ctx.workflow(child, {});
			return { text: String(result.outputs.text) };
		},
	});
}

function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test.skipIf(process.platform === "win32")(
	"an SDK caller's stageUiBroker receives a pooled stage's ask_user_question with its exact form, and its answer reaches the worker (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-question-sdk-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const store = createStore();
		const broker = new StageUiBroker(store);
		const child = await loadWorkerWorkflow(childPath, "child");
		const asked = Promise.withResolvers<{ runId: string; stageId: string }>();
		const stop = broker.onStageRequestRegistered(() => {
			for (const candidate of store.runs())
				for (const stage of candidate.stages)
					if (broker.peekStagePrompt(candidate.id, stage.id) !== undefined)
						asked.resolve({ runId: candidate.id, stageId: stage.id });
		});
		try {
			const execution = run(
				parentOf(child),
				{},
				{
					runId: testRunId("pool-stage-question-sdk"),
					cwd: directory,
					store,
					durableBackend: backend,
					stageUiBroker: broker,
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			const { runId, stageId } = await Promise.race([
				asked.promise,
				execution.then((outcome) => assert.fail(`the run ended first: ${JSON.stringify(outcome)}`)),
			]);
			assert.deepEqual(broker.peekStageQuestionnaire(runId, stageId)?.params, POOL_QUESTION);
			assert.equal(broker.answerStagePrompt(runId, stageId, { optionLabels: ["no"] }), true);
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.text), /answered: .*no/s);
		} finally {
			stop();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"the attached stage chat renders a pooled stage's ask_user_question form and answers it from the keyboard (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-question-chat-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		const store = createStore();
		const broker = new StageUiBroker(store);
		const rootRunId = testRunId("pool-stage-question-chat");
		let pane: WorkflowAttachPane | undefined;
		let clock = 0;
		try {
			const execution = engineRun(
				parentOf(child),
				{},
				{
					runId: rootRunId,
					cwd: directory,
					store,
					durableBackend: backend,
					stageUiBroker: broker,
					usePromptNodesForUi: true,
				},
			);
			let target: { runId: string; stageId: string } | undefined;
			await untilOrRunEnds(
				async () => {
					for (const candidate of store.runs())
						for (const stage of candidate.stages)
							if (stage.inputRequest !== undefined && stage.workerExecution !== undefined)
								target = { runId: candidate.id, stageId: stage.id };
					return target !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(target !== undefined);
			pane = new WorkflowAttachPane({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: rootRunId,
				stageControlRegistry: createStageControlRegistry(),
				stageUiBroker: broker,
				onClose: () => {},
				piTui: { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as unknown as TUI,
				piTheme: theme,
				piKeybindings: {},
				now: () => clock,
			});
			pane.retarget(rootRunId, target.stageId, target.runId);
			const shown = pane;
			await untilOrRunEnds(
				async () => plain(shown.render(120)).includes("Ship the release from the worker?"),
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.match(plain(pane.render(120)), /release-preview-marker/, "the form shows the option's preview");
			// Enter picks the highlighted first option, as in an in-process stage's form.
			// The form ignores Enter for a moment after it opens, against keys meant for something else.
			clock += 1_000;
			pane.handleInput("\r");
			assert.equal(broker.peekStagePrompt(target.runId, target.stageId), undefined, "Enter answered the form");
			await sleep(5000);
			console.log("DBGS", JSON.stringify(store.runs().map((r) => ({ s: r.status, st: r.stages.map((x) => [x.name, x.status, x.inputRequest?.id]) }))), plain(pane.render(120)).slice(-1200));
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.text), /answered: .*yes/s);
		} finally {
			pane?.dispose();
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
