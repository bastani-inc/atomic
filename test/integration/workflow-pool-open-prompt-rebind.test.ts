/**
 * A stage chat open on a pooled stage's prompt when its worker dies (#4022).
 *
 * A real one-worker pool runs a child that asks the user; the real attach pane is open on that
 * prompt. The worker is killed while the chat stays open; the replacement asks again, and the
 * answer typed into the still-open chat reaches the child exactly once.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, test } from "vitest";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run as engineRun } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/index.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import type { WorkflowUIAdapter } from "../../packages/workflows/src/shared/types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { createReaskGate, reaskGateStarts, releaseReaskGate } from "../fixtures/pool-reask-gate.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process and two worker processes in turn running a child workflow. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 180_000;
const CONDITION_TIMEOUT_MS = 60_000;

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
