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
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run as engineRun } from "../../packages/workflows/src/engine/run.js";
import type { PiCustomOverlayFactory, PiCustomOverlayOptions } from "../../packages/workflows/src/extension/wiring.js";
import { createStore, loadWorkerWorkflow, run } from "../../packages/workflows/src/index.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { PoolStageHandoff, type PoolStagePublication } from "../../packages/workflows/src/workers/stage-handoff.js";
import { FOLLOW_UP_MARKER, POOL_QUESTION } from "../fixtures/pool-question-child.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
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
			// The stage then asks whether to move on, as an interactive stage does: that form takes Enter too.
			const ready = target;
			await untilOrRunEnds(
				async () => plain(shown.render(120)).includes("Are you ready to move on to the next stage?"),
				execution,
				CONDITION_TIMEOUT_MS,
			);
			clock += 1_000;
			shown.handleInput("\r");
			assert.equal(broker.peekStagePrompt(ready.runId, ready.stageId), undefined, "Enter passed the readiness gate");
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

test.skipIf(process.platform === "win32")(
	"a pooled stage's readiness gate offers Chat about this without an editor, as an in-process gate does, and a follow-up typed in the stage composer reaches the stage once (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-readiness-chat-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "chatChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "chatChild" }],
		});
		const store = createStore();
		const broker = new StageUiBroker(store);
		const rootRunId = testRunId("pool-stage-readiness-chat");
		let pane: WorkflowAttachPane | undefined;
		let clock = 0;
		const UP = "\x1b[A";
		const DOWN = "\x1b[B";
		const followUp = `${FOLLOW_UP_MARKER} also update the changelog`;
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
			const { runId, stageId } = target;
			pane = new WorkflowAttachPane({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: rootRunId,
				stageControlRegistry: createStageControlRegistry(),
				stageUiBroker: broker,
				onClose: () => {},
				piTui: { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as unknown as TUI,
				piTheme: theme,
				piKeybindings: new KeybindingsManager({}),
				now: () => clock,
			});
			pane.retarget(rootRunId, stageId, runId);
			const shown = pane;
			const showsForm = (question: string) =>
				untilOrRunEnds(
					async () =>
						broker.peekStagePrompt(runId, stageId) !== undefined && plain(shown.render(120)).includes(question),
					execution,
					CONDITION_TIMEOUT_MS,
				);
			// Keys go to a form a moment after it opens.
			const press = (...keys: string[]) => {
				clock += 1_000;
				for (const key of keys) shown.handleInput(key);
			};
			const QUESTION = "Ship the release from the worker?";
			const READY = "Are you ready to move on to the next stage?";
			await showsForm(QUESTION);
			press("\r");
			await showsForm(READY);
			// Up from the first option focuses "Chat about this"; as in-process, it is a choice, not an editor.
			press(UP, ..."hold on");
			assert.doesNotMatch(plain(shown.render(120)), /hold on/, "the readiness gate's chat row takes no text");
			press("\r");
			// The stage stays and chats: it asks again, and the next gate takes "I have more to explore".
			await showsForm(QUESTION);
			press("\r");
			await showsForm(READY);
			press(DOWN, "\r");
			await untilOrRunEnds(
				async () => broker.peekStagePrompt(runId, stageId) === undefined,
				execution,
				CONDITION_TIMEOUT_MS,
			);
			// The follow-up goes through the stage's own composer.
			press(...followUp, "\r");
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.equal(String(outcome.result?.text), `heard 1x: ${followUp}`);
		} finally {
			pane?.dispose();
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"an ask_user_question pending when its worker dies is asked again on the replacement, and its one answer reaches the stage (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-question-kill-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "noReaskChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "noReaskChild" }],
		});
		const store = createStore();
		const broker = new StageUiBroker(store);
		try {
			const execution = engineRun(
				parentOf(child),
				{},
				{
					runId: testRunId("pool-stage-question-kill"),
					cwd: directory,
					store,
					durableBackend: backend,
					stageUiBroker: broker,
				},
			);
			const asked = (afterGeneration: number) => {
				for (const candidate of store.runs())
					for (const stage of candidate.stages) {
						const generation = stage.workerExecution?.generation;
						if (generation === undefined || generation <= afterGeneration) continue;
						if (broker.peekStageQuestionnaire(candidate.id, stage.id) !== undefined)
							return { runId: candidate.id, stageId: stage.id, generation };
					}
				return undefined;
			};
			let first: ReturnType<typeof asked>;
			await untilOrRunEnds(
				async () => {
					first = asked(0);
					return first !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(first !== undefined);
			const [worker] = pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// The replacement shows the same form again.
			let again: ReturnType<typeof asked>;
			await untilOrRunEnds(
				async () => {
					again = asked(first!.generation);
					return again !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(again !== undefined);
			assert.deepEqual(broker.peekStageQuestionnaire(again.runId, again.stageId)?.params, POOL_QUESTION);
			assert.equal(broker.answerStagePrompt(again.runId, again.stageId, { optionLabels: ["no"] }), true);
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.text), /answered: .*no/s);
			assert.doesNotMatch(String(outcome.result?.text), /interrupted/);
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

/**
 * Kills the worker of a stage showing its ask_user_question, then fails the root's form host while
 * the replacement's question is shown. With `withdrawFirst`, the replacement's first publication of
 * the stage does not ask yet, which withdraws the dead attempt's form before the replacement shows its own.
 */
async function failReaskedForm(prefix: string, withdrawFirst: boolean): Promise<void> {
	const directory = makeTempDirectory(prefix);
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "noReaskChild",
		digest: await definitionDigest(childPath),
	});
	const publish = PoolStageHandoff.prototype.publishBatch;
	let split = withdrawFirst;
	const publications = vi.spyOn(PoolStageHandoff.prototype, "publishBatch").mockImplementation(async function (
		this: PoolStageHandoff,
		batch: readonly PoolStagePublication[],
	) {
		// In place: the pool reads each publication's outcome by its index in this batch.
		const list = batch as PoolStagePublication[];
		const index = list.findIndex(
			(entry) =>
				entry.work.generation > 1 && entry.runs.some((run) => run.stages.some((stage) => stage.inputRequest)),
		);
		if (split && index >= 0) {
			split = false;
			const asking = list[index]!;
			list.splice(index, 0, {
				work: asking.work,
				runs: asking.runs.map((run) => ({
					...run,
					stages: run.stages.map(({ inputRequest: _asked, ...stage }) => stage),
				})),
			});
		}
		return publish.call(this, list);
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "noReaskChild" }],
	});
	const store = createStore();
	const hostFails = Promise.withResolvers<never>();
	const forms: AbortSignal[] = [];
	/** A form host that stays open until the test fails it; a withdrawn form closes, as a real host's does. */
	class FailingBroker extends StageUiBroker {
		override requestCustomUi<T>(
			_runId: string,
			_stageId: string,
			_factory: PiCustomOverlayFactory<T>,
			_options?: PiCustomOverlayOptions,
			signal?: AbortSignal,
		): Promise<T> {
			const form = signal ?? new AbortController().signal;
			forms.push(form);
			if (form.aborted) return Promise.reject(form.reason);
			const withdrawn = Promise.withResolvers<never>();
			form.addEventListener("abort", () => withdrawn.reject(form.reason), { once: true });
			return Promise.race([hostFails.promise, withdrawn.promise]);
		}
	}
	try {
		const execution = engineRun(
			parentOf(child),
			{},
			{
				runId: testRunId(prefix),
				cwd: directory,
				store,
				durableBackend: backend,
				stageUiBroker: new FailingBroker(store),
			},
		);
		await untilOrRunEnds(async () => forms.length > 0, execution, CONDITION_TIMEOUT_MS);
		const [worker] = pool.workerPids;
		assert.ok(worker !== undefined);
		const shownBeforeKill = forms.length;
		process.kill(worker, "SIGKILL");
		// Explicit signals: the replacement asks the same question again, and the root shows a form for it:
		// the dead attempt's form, kept open, or the replacement's own once the dead attempt's was withdrawn.
		await untilOrRunEnds(
			async () =>
				forms.some((signal) => !signal.aborted) &&
				(!withdrawFirst || forms.length > shownBeforeKill) &&
				store
					.runs()
					.some((candidate) =>
						candidate.stages.some(
							(stage) =>
								(stage.workerExecution?.generation ?? 0) > 1 && stage.inputRequest?.id === "question-call",
						),
					),
			execution,
			CONDITION_TIMEOUT_MS,
		);
		const shown = forms.length;
		hostFails.reject(new Error("the replacement's form host failed"));
		// Explicit: the run settles on its own; a stage whose session the failure disposed does not.
		const outcome = await Promise.race([
			execution,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("the run did not settle")), CONDITION_TIMEOUT_MS).unref(),
			),
		]);
		assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
		assert.match(String(outcome.result?.text), /answered: .*the replacement's form host failed/s);
		assert.equal(forms.length, shown, "the failed form is not shown again");
	} finally {
		publications.mockRestore();
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"an ask_user_question asked again on the replacement whose form host fails records that failure as the call's result, and the stage goes on (#3996)",
	() => failReaskedForm("pool-stage-question-kill-reject-", false),
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a replacement that publishes its stage before asking again withdraws the dead attempt's form, and its own form's failure is the call's result, shown once (#3996)",
	() => failReaskedForm("pool-stage-question-kill-withdraw-", true),
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a root stageUiBroker that rejects a pooled stage's ask_user_question fails that question in the worker with its error, and the root settles (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-question-reject-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const store = createStore();
		let shown = 0;
		class RejectingBroker extends StageUiBroker {
			override requestCustomUi<T>(): Promise<T> {
				shown++;
				return Promise.reject(new Error("the caller's form host failed"));
			}
		}
		const child = await loadWorkerWorkflow(childPath, "child");
		try {
			const execution = run(
				parentOf(child),
				{},
				{
					runId: testRunId("pool-stage-question-reject"),
					cwd: directory,
					store,
					durableBackend: backend,
					stageUiBroker: new RejectingBroker(store),
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			// Explicit: the run settles on its own; without the failure reaching the worker it waits forever.
			const outcome = await Promise.race([
				execution,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("the run did not settle")), CONDITION_TIMEOUT_MS).unref(),
				),
			]);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.text), /the caller's form host failed/);
			assert.equal(shown, 1, "the rejected form is not shown again");
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
