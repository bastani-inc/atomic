/**
 * A message to a pooled stage whose attempt ends while the stage saves it reaches the replacement exactly once (#4839):
 * its receipt is written with the message, and the root forgets it only once that write landed.
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@bastani/atomic";
import { beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import type { PooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import { acquirePooledStage } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import {
	RECEIPT_STAGE_FINISH,
	RECEIPT_STAGE_FIRST_DELTA,
	RECEIPT_STAGE_KILLED,
	RECEIPT_STAGE_RELEASE,
	RECEIPT_STAGE_STEER,
} from "../fixtures/pool-stage-receipt-child.js";
import { rootOf, testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/** Structural: a coordinator process, worker processes, a real agent stage, and a worker replacement. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 180_000;
const CONDITION_TIMEOUT_MS = 90_000;
const LEASE_MS = 2_000;

useTemporaryAgentDir();

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

type Block = { readonly type: string; readonly text?: string };

function textOf(message: object): string {
	const content = "content" in message ? (message.content as string | readonly Block[] | undefined) : undefined;
	return typeof content === "string"
		? content
		: (content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function agentStage(store: Store): { readonly runId: string; readonly stage: StageSnapshot } | undefined {
	for (const candidate of store.runs())
		for (const stage of candidate.stages)
			if (stage.name === "agent" && stage.workerExecution !== undefined) return { runId: candidate.id, stage };
	return undefined;
}

/** Waits for `done` to hold, failing with what the test could see when it does not, or when the run ends first. */
async function until(
	label: string,
	done: () => boolean | Promise<boolean>,
	execution: Promise<{ readonly status: string; readonly error?: string }>,
	observe: () => string,
): Promise<void> {
	let ended: string | undefined;
	void execution.then((outcome) => {
		ended = `${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`;
	});
	const deadline = Date.now() + CONDITION_TIMEOUT_MS;
	while (!(await done())) {
		if (ended !== undefined) throw new Error(`the run ended (${ended}) at "${label}": ${observe()}`);
		if (Date.now() > deadline) throw new Error(`stalled at "${label}": ${observe()}`);
		await sleep(25);
	}
}

/** Runs the fixture child on one local worker, steers its held stage, and returns the user texts its session holds. */
async function steerWhileTheAttemptEnds(prefix: string, killAt: "before-commit" | "after-message-commit") {
	const directory = makeTempDirectory(prefix);
	const path = join(directory, "journal.sqlite");
	const gate = (name: string) => writeFileSync(join(directory, name), "");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const childPath = fileURLToPath(new URL("../fixtures/pool-stage-receipt-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		leaseMs: LEASE_MS,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
	});
	const store = createStore();
	bindStoreDurableBackend(store, backend);
	const controller = new AbortController();
	const execution = run(
		workflow({
			name: `${prefix}root`,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child, { inputs: { directory, killAt } });
				return {};
			},
		}),
		{},
		{ runId: testRunId(prefix), cwd: directory, store, durableBackend: backend, signal: controller.signal },
	);
	try {
		const observe = () =>
			JSON.stringify({
				stage: agentStage(store)?.stage.status,
				generation: agentStage(store)?.stage.workerExecution?.generation,
				killed: existsSync(join(directory, RECEIPT_STAGE_KILLED)),
			});
		let handle: PooledStageHandle | undefined;
		let release: (() => void) | undefined;
		await until(
			"the stage streams its held turn",
			async () => {
				const target = agentStage(store);
				if (target === undefined) return false;
				const lease = await acquirePooledStage(store, target.runId, target.stage.id);
				if (lease === undefined) return false;
				if (textOf(lease.handle.streamingMessage?.() ?? {}) !== RECEIPT_STAGE_FIRST_DELTA) {
					lease.release();
					return false;
				}
				handle = lease.handle as PooledStageHandle;
				release = lease.release;
				return true;
			},
			execution,
			observe,
		);
		assert.ok(handle !== undefined && release !== undefined);
		const firstGeneration = handle.placement.generation;
		assert.equal(await handle.sendUserMessage(RECEIPT_STAGE_STEER, { deliverAs: "steer" }), "steer");
		// The held turn finishes; the steer enters the session, and the attempt ends while that is saved.
		gate(RECEIPT_STAGE_RELEASE);
		await until(
			"the first attempt ends",
			() => existsSync(join(directory, RECEIPT_STAGE_KILLED)),
			execution,
			observe,
		);
		const view = handle;
		await until(
			"the replacement took what the root still had for it",
			() =>
				view.placement.generation > firstGeneration &&
				view.placement.reconnecting === undefined &&
				!view.hasPending,
			execution,
			observe,
		);
		release();
		gate(RECEIPT_STAGE_FINISH);
		const outcome = await execution;
		assert.equal(outcome.status, "completed", JSON.stringify(outcome));
		const finished = agentStage(store)!;
		const sessions = await poolSessionStore(backend, rootOf(backend, finished.runId));
		assert.ok(sessions !== undefined);
		const users = (await SessionManager.open(sessions, finished.stage.sessionId!))
			.buildSessionContext()
			.messages.filter((message) => message.role === "user")
			.map(textOf);
		await sessions.close();
		return users;
	} finally {
		gate(RECEIPT_STAGE_RELEASE);
		gate(RECEIPT_STAGE_FINISH);
		controller.abort(new Error("test cleanup"));
		await execution.catch(() => {});
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"a steer whose attempt ends after its message ends but before the session saves it reaches the replacement exactly once (#4839)",
	async () => {
		const users = await steerWhileTheAttemptEnds("pool-stage-receipt-before-commit-", "before-commit");
		assert.deepEqual(
			users.filter((text) => text === RECEIPT_STAGE_STEER),
			[RECEIPT_STAGE_STEER],
			`the root kept the steer and sent it again: ${JSON.stringify(users)}`,
		);
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a steer whose attempt ends right after the session saved its message is not delivered again to the replacement (#4839)",
	async () => {
		const users = await steerWhileTheAttemptEnds("pool-stage-receipt-after-commit-", "after-message-commit");
		assert.deepEqual(
			users.filter((text) => text === RECEIPT_STAGE_STEER),
			[RECEIPT_STAGE_STEER],
			`the saved steer was delivered a second time: ${JSON.stringify(users)}`,
		);
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
