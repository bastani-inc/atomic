/**
 * A stage chat open on a pooled stage's prompt when its worker dies (#4022).
 *
 * A real one-worker pool runs a child that asks the user; the real attach pane is open on that
 * prompt. The worker is killed while the chat stays open; the replacement asks again, and the
 * answer typed into the still-open chat reaches the child exactly once.
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
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/index.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import type { WorkflowUIAdapter } from "../../packages/workflows/src/shared/types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { PoolStageHandoff, type PoolStagePublication } from "../../packages/workflows/src/workers/stage-handoff.js";
import type { PooledPromptAnswer, PromptResult } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { createReaskGate, reaskGateStarts, releaseReaskGate } from "../fixtures/pool-reask-gate.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process and two worker processes in turn running a child workflow. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 180_000;
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

const promptChildPath = fileURLToPath(new URL("../fixtures/pool-prompt-child.ts", import.meta.url));
const questionChildPath = fileURLToPath(new URL("../fixtures/pool-question-child.ts", import.meta.url));
const DOWN = "\x1b[B";
const INTERRUPTED = "Tool execution was interrupted after it started";

function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** A host-mode root over a one-worker pool, with the real attach pane mounted on nothing yet. */
async function openRun(prefix: string, childPath: string, exportName: string, gated = false, ui?: WorkflowUIAdapter) {
	const directory = makeTempDirectory(prefix);
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	if (gated) createReaskGate(path);
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName }],
	});
	const store = createStore();
	const broker = new StageUiBroker(store);
	const rootRunId = testRunId(prefix);
	const execution = engineRun(
		workflow({
			name: "pool-open-prompt-root",
			description: "",
			inputs: {},
			outputs: { branch: Type.String() },
			async run(ctx) {
				const result = await ctx.workflow(child, gated ? { inputs: { journalPath: path } } : {});
				return { branch: String(result.outputs.branch ?? result.outputs.text) };
			},
		}),
		{},
		{
			runId: rootRunId,
			cwd: directory,
			store,
			durableBackend: backend,
			stageUiBroker: broker,
			// An SDK caller's `ui` answers ctx.ui prompts; otherwise the host shows them as prompt nodes.
			...(ui === undefined ? { usePromptNodesForUi: true } : { ui }),
		},
	);
	let clock = 0;
	const pane = new WorkflowAttachPane({
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
	const close = async () => {
		pane.dispose();
		// A failed test leaves the child waiting for an answer: closing the pool ends it.
		await pool.close();
		await execution.catch(() => {});
		await backend.close();
		removeTempDirectory(directory);
	};
	/** Moves the pane's clock past the Enter quarantine a freshly shown prompt applies. */
	const advance = () => {
		clock += 1_000;
	};
	return { store, broker, pool, pane, rootRunId, execution, close, advance, path };
}

/** The pooled stage with a pending ctx.ui prompt, and its attempt generation. */
function pendingPrompt(store: ReturnType<typeof createStore>) {
	for (const candidate of store.runs())
		for (const stage of candidate.stages)
			if (stage.pendingPrompt !== undefined && stage.workerExecution !== undefined)
				return {
					runId: candidate.id,
					stageId: stage.id,
					promptId: stage.pendingPrompt.id,
					generation: stage.workerExecution.generation,
				};
	return undefined;
}

/** The run's outcome; an answer that never reached the child fails here instead of hanging. */
function settled<T>(execution: Promise<T>): Promise<T> {
	return Promise.race([
		execution,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("the run did not settle: the submitted answer never reached the child")),
				CONDITION_TIMEOUT_MS,
			).unref(),
		),
	]);
}

/** Kills the pool's one worker and waits for its replacement to publish the re-asked prompt. */
async function killAndAwaitReask(
	run: Awaited<ReturnType<typeof openRun>>,
	first: { readonly generation: number },
	reasked: (generation: number) => boolean,
) {
	const [worker] = run.pool.workerPids;
	assert.ok(worker !== undefined);
	process.kill(worker, "SIGKILL");
	await untilValue(() => (reasked(first.generation) ? true : undefined), run.execution);
}

async function untilValue<T>(read: () => T | undefined, execution: Promise<unknown>): Promise<T> {
	let value: T | undefined;
	await untilOrRunEnds(
		async () => {
			value = read();
			return value !== undefined;
		},
		execution as Parameters<typeof untilOrRunEnds>[1],
		CONDITION_TIMEOUT_MS,
	);
	assert.ok(value !== undefined);
	return value;
}

test.skipIf(process.platform === "win32")(
	"#4022: a stage chat open on a pooled ctx.ui.input prompt when its worker dies delivers the answer typed afterwards, once",
	async () => {
		const run = await openRun("pool-open-prompt-input-", promptChildPath, "child");
		try {
			const first = await untilValue(() => pendingPrompt(run.store), run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which branch should the worker use?") ? true : undefined),
				run.execution,
			);
			// Explicit signal: the replacement attempt published its own re-asked prompt.
			await killAndAwaitReask(run, first, (generation) => (pendingPrompt(run.store)?.generation ?? 0) > generation);
			assert.notEqual(pendingPrompt(run.store)?.promptId, first.promptId);
			assert.match(plain(run.pane.render(120)), /Which branch should the worker use\?/);
			run.advance();
			for (const key of "after-kill") run.pane.handleInput(key);
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "after-kill" });
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: a stage chat open on a pooled ctx.ui.select prompt when its worker dies delivers the choice made afterwards, once",
	async () => {
		const run = await openRun("pool-open-prompt-select-", promptChildPath, "selectChild");
		try {
			const first = await untilValue(() => pendingPrompt(run.store), run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(() => (plain(run.pane.render(120)).includes("develop") ? true : undefined), run.execution);
			await killAndAwaitReask(run, first, (generation) => (pendingPrompt(run.store)?.generation ?? 0) > generation);
			assert.match(plain(run.pane.render(120)), /Which branch should the worker use\?/);
			run.advance();
			run.pane.handleInput(DOWN);
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "release" });
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: a stage chat open on a pooled ask_user_question form when its worker dies answers the re-asked form once, without the interrupted line",
	async () => {
		const run = await openRun("pool-open-prompt-question-", questionChildPath, "noReaskChild");
		try {
			const asked = () => {
				for (const candidate of run.store.runs())
					for (const stage of candidate.stages) {
						const generation = stage.workerExecution?.generation;
						if (
							generation !== undefined &&
							run.broker.peekStageQuestionnaire(candidate.id, stage.id) !== undefined
						)
							return { runId: candidate.id, stageId: stage.id, generation };
					}
				return undefined;
			};
			const first = await untilValue(asked, run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Ship the release from the worker?") ? true : undefined),
				run.execution,
			);
			await killAndAwaitReask(run, first, (generation) => (asked()?.generation ?? 0) > generation);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Ship the release from the worker?") ? true : undefined),
				run.execution,
			);
			const shown = plain(run.pane.render(120));
			assert.ok(!shown.includes(INTERRUPTED), `the re-asked form shows no interrupted line:\n${shown}`);
			run.advance();
			run.pane.handleInput(DOWN);
			run.pane.handleInput("\r");
			const again = asked();
			assert.equal(
				again === undefined ? undefined : run.broker.peekStagePrompt(again.runId, again.stageId),
				undefined,
				"Enter answered the re-asked form",
			);
			// The stage then asks whether to move on; that form takes Enter too.
			await untilValue(
				() =>
					plain(run.pane.render(120)).includes("Are you ready to move on to the next stage?") ? true : undefined,
				run.execution,
			);
			run.advance();
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.branch), /answered: .*no/s);
			assert.doesNotMatch(String(outcome.result?.branch), /interrupted/);
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: a ctx.ui answer submitted after the worker died but before the replacement asks reaches the replacement's prompt once, without asking again",
	async () => {
		const run = await openRun("pool-open-prompt-gap-", promptChildPath, "gatedChild", true);
		try {
			const first = await untilValue(() => pendingPrompt(run.store), run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which branch should the worker use?") ? true : undefined),
				run.execution,
			);
			run.advance();
			for (const key of "gap-answer") run.pane.handleInput(key);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// Submitted in the same tick as the kill: the answer can only reach the dead attempt.
			run.pane.handleInput("\r");
			// Explicit signal: the replacement attempt started and waits at the gate before it asks.
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			releaseReaskGate(run.path);
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "gap-answer" });
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: a stage chat open on a pooled prompt follows the replacement when it asks a different question at the same point, and its answer reaches the child once",
	async () => {
		const run = await openRun("pool-open-prompt-changed-", promptChildPath, "gatedChangedChild", true);
		try {
			const first = await untilValue(() => pendingPrompt(run.store), run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which branch should the worker use?") ? true : undefined),
				run.execution,
			);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			releaseReaskGate(run.path);
			// The replacement's different question shows in the chat that is still open.
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which tag should the worker use?") ? true : undefined),
				run.execution,
			);
			run.advance();
			for (const key of "v2.0") run.pane.handleInput(key);
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "v2.0" });
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: an answer held across a worker death is discarded when the replacement asks a different question, which is still asked and answered once",
	async () => {
		const run = await openRun("pool-open-prompt-gap-changed-", promptChildPath, "gatedChangedChild", true);
		try {
			const first = await untilValue(() => pendingPrompt(run.store), run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which branch should the worker use?") ? true : undefined),
				run.execution,
			);
			run.advance();
			for (const key of "stale-answer") run.pane.handleInput(key);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// Submitted in the same tick as the kill: the answer can only reach the dead attempt.
			run.pane.handleInput("\r");
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			releaseReaskGate(run.path);
			// The replacement's different question is asked, and the held answer does not answer it.
			const again = await untilValue(() => {
				const prompt = pendingPrompt(run.store);
				return prompt !== undefined && prompt.generation > first.generation ? prompt : undefined;
			}, run.execution);
			run.pane.retarget(run.rootRunId, again.stageId, again.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which tag should the worker use?") ? true : undefined),
				run.execution,
			);
			assert.equal(pendingPrompt(run.store)?.promptId, again.promptId, "the held answer did not answer it");
			run.advance();
			for (const key of "v2.0") run.pane.handleInput(key);
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "v2.0" });
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: an ask_user_question answer submitted after the worker died but before the replacement asks reaches the re-asked form once, without showing it again",
	async () => {
		const run = await openRun("pool-open-prompt-gap-question-", questionChildPath, "gatedNoReaskChild", true);
		try {
			const asked = () => {
				for (const candidate of run.store.runs())
					for (const stage of candidate.stages) {
						const generation = stage.workerExecution?.generation;
						if (
							generation !== undefined &&
							run.broker.peekStageQuestionnaire(candidate.id, stage.id) !== undefined
						)
							return { runId: candidate.id, stageId: stage.id, generation };
					}
				return undefined;
			};
			const first = await untilValue(asked, run.execution);
			let reshown = 0;
			const stop = run.broker.onStageRequestRegistered(() => {
				const current = asked();
				const params =
					current === undefined
						? undefined
						: run.broker.peekStageQuestionnaire(current.runId, current.stageId)?.params;
				if (
					current !== undefined &&
					current.generation > first.generation &&
					JSON.stringify(params).includes("Ship the release from the worker?")
				)
					reshown++;
			});
			try {
				run.pane.retarget(run.rootRunId, first.stageId, first.runId);
				await untilValue(
					() => (plain(run.pane.render(120)).includes("Ship the release from the worker?") ? true : undefined),
					run.execution,
				);
				run.advance();
				run.pane.handleInput(DOWN);
				const [worker] = run.pool.workerPids;
				assert.ok(worker !== undefined);
				process.kill(worker, "SIGKILL");
				// Submitted in the same tick as the kill: the answer can only reach the dead attempt.
				run.pane.handleInput("\r");
				await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
				releaseReaskGate(run.path);
				// The stage then asks whether to move on; only that form takes the next Enter.
				await untilValue(
					() =>
						plain(run.pane.render(120)).includes("Are you ready to move on to the next stage?")
							? true
							: undefined,
					run.execution,
				);
				assert.equal(reshown, 0, "the re-asked question is answered by the held answer, not shown again");
				run.advance();
				run.pane.handleInput("\r");
				const outcome = await settled(run.execution);
				assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
				assert.match(String(outcome.result?.branch), /answered: .*no/s);
				assert.doesNotMatch(String(outcome.result?.branch), /interrupted/);
			} finally {
				stop();
			}
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: an SDK ui answer to the dead attempt's prompt, refused after the replacement asked the same prompt, answers the replacement once",
	async () => {
		const asks: { readonly prompt: string; readonly answer: PromiseWithResolvers<string> }[] = [];
		const asked = new EventTarget();
		const ui: WorkflowUIAdapter = {
			input(prompt) {
				const answer = Promise.withResolvers<string>();
				asks.push({ prompt, answer });
				asked.dispatchEvent(new Event("ask"));
				return answer.promise;
			},
			confirm: async () => false,
			select: async (_message, options) => options[0]!,
			editor: async (initial) => initial ?? "",
			custom: async () => {
				throw new Error("not used");
			},
		};
		const run = await openRun("pool-open-prompt-sdk-race-", promptChildPath, "gatedChild", true, ui);
		try {
			await untilValue(() => (asks.length === 1 ? true : undefined), run.execution);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			releaseReaskGate(run.path);
			// Explicit signal: the replacement asked the same prompt, and the root asked the SDK ui again.
			await untilValue(() => (asks.length === 2 ? true : undefined), run.execution);
			assert.equal(asks[1]!.prompt, asks[0]!.prompt);
			// Only now does the first ask get its answer: it reaches the dead attempt and is refused.
			asks[0]!.answer.resolve("first-answer");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "first-answer" });
			assert.equal(asks.length, 2, "the user's one answer was enough");
		} finally {
			for (const ask of asks) ask.answer.resolve("unused");
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: an ask_user_question answer refused after the replacement showed the same form closes that form, answers the replacement once, and the next form opens",
	async () => {
		// Holds the refusal of the dead attempt's answer until the replacement shows its form.
		const refusalGate = Promise.withResolvers<void>();
		const refusalHeld = Promise.withResolvers<void>();
		const answer = LocalWorkerPool.prototype.answerPooledStagePrompt;
		let held = false;
		const intercepted = vi
			.spyOn(LocalWorkerPool.prototype, "answerPooledStagePrompt")
			.mockImplementation(async function (
				this: LocalWorkerPool,
				runId: string,
				stageId: string,
				reply: PooledPromptAnswer,
			): Promise<PromptResult> {
				const result = await answer.call(this, runId, stageId, reply);
				if (reply.kind !== "input" || result.ok || held) return result;
				held = true;
				refusalHeld.resolve();
				await refusalGate.promise;
				return result;
			});
		// A replacement may publish its stage before it asks again; that ends the dead attempt's route
		// while its answer is in flight. Publish the replacement's first view of the stage that way.
		const publish = PoolStageHandoff.prototype.publishBatch;
		let splitOnce = true;
		const publications = vi.spyOn(PoolStageHandoff.prototype, "publishBatch").mockImplementation(async function (
			this: PoolStageHandoff,
			batch: readonly PoolStagePublication[],
		) {
			const list = batch as PoolStagePublication[];
			const index = list.findIndex(
				(entry) =>
					entry.work.generation > 1 &&
					entry.runs.some((run) => run.stages.some((stage) => stage.inputRequest !== undefined)),
			);
			if (splitOnce && index >= 0) {
				splitOnce = false;
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
		const run = await openRun("pool-open-prompt-question-race-", questionChildPath, "gatedNoReaskChild", true);
		try {
			const asked = () => {
				for (const candidate of run.store.runs())
					for (const stage of candidate.stages) {
						const generation = stage.workerExecution?.generation;
						if (
							generation !== undefined &&
							run.broker.peekStageQuestionnaire(candidate.id, stage.id) !== undefined
						)
							return { runId: candidate.id, stageId: stage.id, generation };
					}
				return undefined;
			};
			const first = await untilValue(asked, run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Ship the release from the worker?") ? true : undefined),
				run.execution,
			);
			run.advance();
			run.pane.handleInput(DOWN);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// Submitted in the same tick as the kill: the answer can only reach the dead attempt.
			run.pane.handleInput("\r");
			let shownAgain = 0;
			const stopCounting = run.broker.onStageRequestRegistered(() => {
				shownAgain++;
			});
			await refusalHeld.promise;
			// Explicit signal: the replacement's stage started and waits before it asks again.
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			releaseReaskGate(run.path);
			// Explicit signal: the replacement asked again and the root shows its form.
			await untilValue(() => (shownAgain > 0 ? true : undefined), run.execution);
			stopCounting();
			refusalGate.resolve();
			// The held answer answers the replacement; its form closes and the readiness gate opens next.
			await untilValue(
				() =>
					plain(run.pane.render(120)).includes("Are you ready to move on to the next stage?") ? true : undefined,
				run.execution,
			);
			run.advance();
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.branch), /answered: .*no/s);
		} finally {
			refusalGate.resolve();
			intercepted.mockRestore();
			publications.mockRestore();
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

/** Records each failure the root sends a pooled stage, and resolves once one has come back. */
function watchFailures() {
	const answer = LocalWorkerPool.prototype.answerPooledStagePrompt;
	const returned = Promise.withResolvers<PromptResult>();
	const spy = vi.spyOn(LocalWorkerPool.prototype, "answerPooledStagePrompt").mockImplementation(async function (
		this: LocalWorkerPool,
		runId: string,
		stageId: string,
		reply: PooledPromptAnswer,
	): Promise<PromptResult> {
		const result = await answer.call(this, runId, stageId, reply);
		if (reply.kind === "failed") returned.resolve(result);
		return result;
	});
	return { returned: returned.promise, restore: () => spy.mockRestore() };
}

test.skipIf(process.platform === "win32")(
	"#4022: an ask_user_question whose root form host fails after the worker died, before the replacement asks again, fails the re-asked call without showing the form again",
	async () => {
		const failures = watchFailures();
		const run = await openRun("pool-open-prompt-question-fail-gap-", questionChildPath, "gatedNoReaskChild", true);
		const hostFails = Promise.withResolvers<never>();
		let requests = 0;
		// The question's form host fails; the readiness gate the stage shows afterwards is shown as usual.
		const show = run.broker.requestCustomUi.bind(run.broker);
		const host = vi.spyOn(run.broker, "requestCustomUi").mockImplementation((runId, stageId, ...rest) => {
			const stage = run.store
				.runs()
				.find((candidate) => candidate.id === runId)
				?.stages.find((candidate) => candidate.id === stageId);
			if (stage?.inputRequest?.id !== "question-call") return show(runId, stageId, ...rest);
			requests++;
			return hostFails.promise;
		});
		try {
			const first = await untilValue(() => {
				if (requests !== 1) return undefined;
				for (const candidate of run.store.runs())
					for (const stage of candidate.stages)
						if (stage.inputRequest?.id === "question-call") return { runId: candidate.id, stageId: stage.id };
				return undefined;
			}, run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// Explicit signal: the replacement started and waits before it asks again.
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			hostFails.reject(new Error("the root's form host failed"));
			// Explicit signal: the failure reached the pool, which no attempt could take yet.
			const refused = await settled(failures.returned);
			assert.equal(refused.ok, false, "no attempt had the question pending");
			releaseReaskGate(run.path);
			// The stage then asks whether to move on; that form is shown and answered.
			await untilValue(
				() =>
					plain(run.pane.render(120)).includes("Are you ready to move on to the next stage?") ? true : undefined,
				run.execution,
			);
			run.advance();
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.branch), /answered: .*the root's form host failed/s);
			assert.equal(requests, 1, "the failed form is not shown again");
		} finally {
			hostFails.reject(new Error("closed"));
			host.mockRestore();
			failures.restore();
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: an SDK ui that rejects a ctx.ui prompt after the worker died, before the replacement asks again, fails the re-asked prompt without asking the ui again",
	async () => {
		const failures = watchFailures();
		const asks: PromiseWithResolvers<string>[] = [];
		const ui: WorkflowUIAdapter = {
			input() {
				const answer = Promise.withResolvers<string>();
				asks.push(answer);
				return answer.promise;
			},
			confirm: async () => false,
			select: async (_message, options) => options[0]!,
			editor: async (initial) => initial ?? "",
			custom: async () => {
				throw new Error("not used");
			},
		};
		const run = await openRun("pool-open-prompt-sdk-fail-gap-", promptChildPath, "gatedChild", true, ui);
		try {
			await untilValue(() => (asks.length === 1 ? true : undefined), run.execution);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// Explicit signal: the replacement started and waits before it asks again.
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			asks[0]!.reject(new Error("the SDK ui failed"));
			// Explicit signal: the failure reached the pool, which no attempt could take yet.
			const refused = await settled(failures.returned);
			assert.equal(refused.ok, false, "no attempt had the prompt pending");
			releaseReaskGate(run.path);
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "failed");
			assert.match(JSON.stringify(outcome.error), /the SDK ui failed/);
			assert.equal(asks.length, 1, "the failed prompt is not asked again");
		} finally {
			for (const ask of asks) ask.resolve("unused");
			failures.restore();
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: a root resumed after its pooled child completed on a replacement that asked a different question replays the cached child without running it again",
	async () => {
		const directory = makeTempDirectory("pool-open-prompt-changed-resume-");
		const path = join(directory, "journal.sqlite");
		createReaskGate(path);
		const exportName = "gatedChangedChild";
		const child = await loadWorkerDefinition({
			path: promptChildPath,
			exportName,
			digest: await definitionDigest(promptChildPath),
		});
		const rootRunId = testRunId("pool-open-prompt-changed-resume");
		const parent = workflow({
			name: "pool-open-prompt-resume-root",
			description: "",
			inputs: {},
			outputs: { branch: Type.String(), note: Type.String() },
			async run(ctx) {
				const result = await ctx.workflow(child, { inputs: { journalPath: path } });
				// The root waits on a prompt of its own after the child completed, so it can be quit there.
				const note = await ctx.ui.input("Root note after the child");
				return { branch: String(result.outputs.branch), note };
			},
		});
		const open = async () => {
			const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
			const pool = new LocalWorkerPool(backend, {
				journalPath: path,
				workers: 1,
				definitions: [{ definition: child, path: promptChildPath, exportName }],
			});
			const store = createStore();
			const execution = engineRun(
				parent,
				{},
				{ runId: rootRunId, cwd: directory, store, durableBackend: backend, usePromptNodesForUi: true },
			);
			return {
				store,
				pool,
				execution,
				async close() {
					await pool.close();
					await execution.catch(() => {});
					await backend.close();
				},
			};
		};
		const rootPrompt = (store: ReturnType<typeof createStore>) => {
			const stage = store
				.runs()
				.find((candidate) => candidate.id === rootRunId)
				?.stages.find((candidate) => candidate.pendingPrompt?.message === "Root note after the child");
			return stage?.pendingPrompt === undefined
				? undefined
				: { stageId: stage.id, promptId: stage.pendingPrompt.id };
		};
		let first: Awaited<ReturnType<typeof open>> | undefined;
		let resumed: Awaited<ReturnType<typeof open>> | undefined;
		try {
			first = await open();
			const opened = first;
			const asked = await untilValue(() => pendingPrompt(opened.store), opened.execution);
			const [worker] = opened.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			await untilValue(() => (reaskGateStarts(path) > 1 ? true : undefined), opened.execution);
			releaseReaskGate(path);
			// The replacement asks a different question; answering it completes the child.
			const again = await untilValue(() => {
				const prompt = pendingPrompt(opened.store);
				return prompt !== undefined && prompt.generation > asked.generation ? prompt : undefined;
			}, opened.execution);
			assert.equal(opened.store.resolveStagePendingPrompt(again.runId, again.stageId, again.promptId, "v2.0"), true);
			await untilValue(() => rootPrompt(opened.store), opened.execution);
			await toolControlRegistry.runControl(rootRunId)!.quit();
			assert.equal((await opened.execution).status, "paused");
			await first.close();
			first = undefined;

			const starts = reaskGateStarts(path);
			resumed = await open();
			const reopened = resumed;
			const note = await untilValue(() => rootPrompt(reopened.store), reopened.execution);
			assert.equal(reopened.store.resolveStagePendingPrompt(rootRunId, note.stageId, note.promptId, "done"), true);
			const outcome = await settled(reopened.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "v2.0", note: "done" });
			assert.equal(reaskGateStarts(path), starts, "the completed child was replayed, not run again");
		} finally {
			await first?.close();
			await resumed?.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

/**
 * Delays the first answer of `kind` the root sends to a pooled stage until `release` settles, so
 * a test can send it while the replacement attempt runs but has not yet recreated the stage.
 */
function delayFirstAnswer(kind: PooledPromptAnswer["kind"], release: Promise<void>) {
	const answer = LocalWorkerPool.prototype.answerPooledStagePrompt;
	const sent = Promise.withResolvers<void>();
	const results: PromptResult[] = [];
	let delayed = false;
	const spy = vi.spyOn(LocalWorkerPool.prototype, "answerPooledStagePrompt").mockImplementation(async function (
		this: LocalWorkerPool,
		runId: string,
		stageId: string,
		reply: PooledPromptAnswer,
	): Promise<PromptResult> {
		if (reply.kind !== kind || delayed) return answer.call(this, runId, stageId, reply);
		delayed = true;
		sent.resolve();
		await release;
		const result = await answer.call(this, runId, stageId, reply);
		results.push(result);
		return result;
	});
	return { sent: sent.promise, results, restore: () => spy.mockRestore() };
}

test.skipIf(process.platform === "win32")(
	"#4022: a ctx.ui answer that reaches the replacement before it recreated the prompt's stage is held and answers its prompt once",
	async () => {
		const window = Promise.withResolvers<void>();
		const delayed = delayFirstAnswer("prompt", window.promise);
		const run = await openRun("pool-open-prompt-window-", promptChildPath, "gatedChild", true);
		try {
			const first = await untilValue(() => pendingPrompt(run.store), run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which branch should the worker use?") ? true : undefined),
				run.execution,
			);
			run.advance();
			for (const key of "window-answer") run.pane.handleInput(key);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			run.pane.handleInput("\r");
			await delayed.sent;
			// Explicit signal: the replacement runs the child and waits at the gate, before its prompt stage exists.
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			window.resolve();
			await untilValue(() => (delayed.results.length > 0 ? true : undefined), run.execution);
			assert.equal(delayed.results[0]?.ok, false, "the replacement had no such prompt yet");
			releaseReaskGate(run.path);
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "window-answer" });
		} finally {
			window.resolve();
			delayed.restore();
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: an ask_user_question answer that reaches the replacement before it recreated the stage is held and answers the re-asked form once",
	async () => {
		const window = Promise.withResolvers<void>();
		const delayed = delayFirstAnswer("input", window.promise);
		const run = await openRun("pool-open-prompt-window-question-", questionChildPath, "gatedNoReaskChild", true);
		try {
			const asked = () => {
				for (const candidate of run.store.runs())
					for (const stage of candidate.stages)
						if (run.broker.peekStageQuestionnaire(candidate.id, stage.id) !== undefined)
							return { runId: candidate.id, stageId: stage.id };
				return undefined;
			};
			const first = await untilValue(asked, run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Ship the release from the worker?") ? true : undefined),
				run.execution,
			);
			run.advance();
			run.pane.handleInput(DOWN);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			run.pane.handleInput("\r");
			await delayed.sent;
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			window.resolve();
			await untilValue(() => (delayed.results.length > 0 ? true : undefined), run.execution);
			assert.equal(delayed.results[0]?.ok, false, "the replacement had no such stage yet");
			let reshown = 0;
			const stop = run.broker.onStageRequestRegistered(() => {
				const current = asked();
				if (
					current !== undefined &&
					JSON.stringify(run.broker.peekStageQuestionnaire(current.runId, current.stageId)?.params).includes(
						"Ship the release from the worker?",
					)
				)
					reshown++;
			});
			try {
				releaseReaskGate(run.path);
				await untilValue(
					() =>
						plain(run.pane.render(120)).includes("Are you ready to move on to the next stage?")
							? true
							: undefined,
					run.execution,
				);
				assert.equal(reshown, 0, "the held answer answered the re-asked question; it was not shown again");
			} finally {
				stop();
			}
			run.advance();
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.match(String(outcome.result?.branch), /answered: .*no/s);
		} finally {
			window.resolve();
			delayed.restore();
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: a replacement that runs an agent stage where the replaced attempt asked a prompt is refused as a different path, in plain words",
	async () => {
		const run = await openRun("pool-open-prompt-divergent-", promptChildPath, "gatedDivergentChild", true);
		try {
			await untilValue(() => pendingPrompt(run.store), run.execution);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			releaseReaskGate(run.path);
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "failed", JSON.stringify(outcome));
			assert.match(
				JSON.stringify(outcome.error),
				/took different steps when it ran again on a replacement worker \(direct child source orders are not unique\)/,
			);
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"#4022: a stage chat hidden while the replacement asks a different question shows that question when shown again, and its answer reaches the child once",
	async () => {
		// Once the replacement's question is pending, the root applies no more publications, so only
		// showing the chat can move it to that question (no later store activity does it instead).
		let frozen = false;
		const publish = PoolStageHandoff.prototype.publishBatch;
		const publications = vi.spyOn(PoolStageHandoff.prototype, "publishBatch").mockImplementation(async function (
			this: PoolStageHandoff,
			batch: readonly PoolStagePublication[],
		) {
			return frozen ? batch.map(() => undefined) : publish.call(this, batch);
		});
		const run = await openRun("pool-open-prompt-hidden-", promptChildPath, "gatedChangedChild", true);
		try {
			const first = await untilValue(() => pendingPrompt(run.store), run.execution);
			run.pane.retarget(run.rootRunId, first.stageId, first.runId);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which branch should the worker use?") ? true : undefined),
				run.execution,
			);
			run.pane.setVisible(false);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			await untilValue(() => (reaskGateStarts(run.path) > 1 ? true : undefined), run.execution);
			releaseReaskGate(run.path);
			// Explicit signal: the replacement's different question is pending while the chat is hidden.
			await untilValue(() => {
				const prompt = pendingPrompt(run.store);
				return prompt !== undefined && prompt.generation > first.generation ? prompt : undefined;
			}, run.execution);
			frozen = true;
			run.pane.setVisible(true);
			await untilValue(
				() => (plain(run.pane.render(120)).includes("Which tag should the worker use?") ? true : undefined),
				run.execution,
			);
			frozen = false;
			run.advance();
			for (const key of "v3.0") run.pane.handleInput(key);
			run.pane.handleInput("\r");
			const outcome = await settled(run.execution);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "v3.0" });
		} finally {
			publications.mockRestore();
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
