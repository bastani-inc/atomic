/**
 * A message to a pooled stage that the replacement attempt finishes before the root resends it is reported to its
 * sender (#4884): one notice in the parent session and one in the stage chat name the message and the stage.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@bastani/atomic";
import { beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	installUndeliveredStageMessageNotifications,
	UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE,
} from "../../packages/workflows/src/extension/undelivered-stage-message-notifications.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import type { PooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import { acquirePooledStage } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import {
	UNDELIVERED_STAGE_FINISH,
	UNDELIVERED_STAGE_FIRST_DELTA,
	UNDELIVERED_STAGE_KILLED,
} from "../fixtures/pool-stage-undelivered-child.js";
import { rootOf, testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/** Structural: a coordinator process, two worker processes, a real agent stage, and a worker replacement. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 180_000;
const CONDITION_TIMEOUT_MS = 90_000;
const LEASE_MS = 2_000;
const STEER = "steer-pending-when-the-attempt-ends";

useTemporaryAgentDir();

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

type Block = { readonly type: string; readonly text?: string };
type SentMessage = { readonly customType: string; readonly content: string };

function textOf(message: object): string {
	const content = "content" in message ? (message.content as string | readonly Block[] | undefined) : undefined;
	return typeof content === "string"
		? content
		: (content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function agentStages(store: Store): { readonly runId: string; readonly stage: StageSnapshot }[] {
	return store
		.runs()
		.flatMap((candidate) =>
			candidate.stages
				.filter((stage) => stage.name === "agent" && stage.workerExecution !== undefined)
				.map((stage) => ({ runId: candidate.id, stage })),
		);
}

function agentStage(store: Store): { readonly runId: string; readonly stage: StageSnapshot } | undefined {
	return agentStages(store)[0];
}

async function until(
	label: string,
	done: () => boolean | Promise<boolean>,
	execution: Promise<{ readonly status: string; readonly error?: string }>,
	observe: () => string,
	allowEnded = false,
): Promise<void> {
	let ended: string | undefined;
	void execution.then((outcome) => {
		ended = `${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`;
	});
	const deadline = Date.now() + CONDITION_TIMEOUT_MS;
	while (!(await done())) {
		if (ended !== undefined && !allowEnded) throw new Error(`the run ended (${ended}) at "${label}": ${observe()}`);
		if (Date.now() > deadline) throw new Error(`stalled at "${label}": ${observe()}`);
		await sleep(25);
	}
}

/**
 * Runs the fixture child on a two-worker pool, steers its held stage, kills the attempt holding the steer, and lets the
 * replacement either finish the stage without a turn (`replayFinishes`) or take the resent steer.
 */
async function steerThenReplace(prefix: string, replayFinishes: boolean) {
	const directory = makeTempDirectory(prefix);
	const path = join(directory, "journal.sqlite");
	const gate = (name: string) => writeFileSync(join(directory, name), "");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const childPath = fileURLToPath(new URL("../fixtures/pool-stage-undelivered-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 2,
		leaseMs: LEASE_MS,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
	});
	const store = createStore();
	bindStoreDurableBackend(store, backend);
	const sent: SentMessage[] = [];
	const stopNotices = installUndeliveredStageMessageNotifications({
		store,
		sendMessage: (message) => {
			sent.push(message as SentMessage);
		},
	});
	const controller = new AbortController();
	const execution = run(
		workflow({
			name: `${prefix}root`,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child, { inputs: { directory, replayFinishes } });
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
				notices: agentStage(store)?.stage.notices,
				sent,
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
				if (textOf(lease.handle.streamingMessage?.() ?? {}) !== UNDELIVERED_STAGE_FIRST_DELTA) {
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
		const view = handle;
		const firstGeneration = view.placement.generation;
		// The sender hears `steer` at once; the steer waits in the held turn's queue.
		assert.equal(await view.sendUserMessage(STEER, { deliverAs: "steer" }), "steer");
		gate(UNDELIVERED_STAGE_KILLED);
		const worker = agentStage(store)?.stage.workerExecution?.worker;
		const pid = pool.workerPids.find((candidate) => worker?.includes(String(candidate))) ?? pool.workerPids[0];
		assert.ok(pid !== undefined);
		process.kill(pid, "SIGKILL");
		if (!replayFinishes) {
			await until(
				"the replacement took the resent steer",
				() =>
					view.placement.generation > firstGeneration &&
					view.placement.reconnecting === undefined &&
					!view.hasPending,
				execution,
				observe,
			);
			gate(UNDELIVERED_STAGE_FINISH);
		}
		const outcome = await execution;
		assert.equal(outcome.status, "completed", JSON.stringify(outcome));
		release();
		await until("the stage's outbox settled", () => !replayFinishes || sent.length > 0, execution, observe, true);
		// The replacement may hold the stage under a new id, or not start its session: read every copy of the stage.
		const copies = agentStages(store);
		const sessions = await poolSessionStore(backend, rootOf(backend, copies[0]!.runId));
		assert.ok(sessions !== undefined);
		const users: string[] = [];
		for (const sessionId of new Set(copies.flatMap(({ stage }) => stage.sessionId ?? [])))
			users.push(
				...(await SessionManager.open(sessions, sessionId))
					.buildSessionContext()
					.messages.filter((message) => message.role === "user")
					.map(textOf),
			);
		await sessions.close();
		const notices = copies.flatMap(({ stage }) => stage.notices ?? []);
		return { users, sent: [...sent], notices };
	} finally {
		stopNotices();
		gate(UNDELIVERED_STAGE_KILLED);
		gate(UNDELIVERED_STAGE_FINISH);
		controller.abort(new Error("test cleanup"));
		await execution.catch(() => {});
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"a steer the replacement's replay finishes the stage before resending tells its sender once, naming it and the stage (#4884)",
	async () => {
		const { users, sent, notices: all } = await steerThenReplace("pool-stage-undelivered-replay-", true);
		assert.ok(!users.includes(STEER), `the steer was delivered after all: ${JSON.stringify(users)}`);
		assert.equal(sent.length, 1, `one parent-session notice: ${JSON.stringify(sent)}`);
		assert.equal(sent[0]!.customType, UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE);
		assert.match(sent[0]!.content, new RegExp(STEER));
		assert.match(sent[0]!.content, /"agent"/);
		const notices = all.filter((notice) => notice.kind === "undelivered");
		assert.equal(notices.length, 1, `one stage-chat notice: ${JSON.stringify(all)}`);
		assert.equal(notices[0]!.to, STEER);
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a steer the replacement takes on resend reaches it once and tells its sender nothing (#4884)",
	async () => {
		const { users, sent, notices } = await steerThenReplace("pool-stage-undelivered-resend-", false);
		assert.deepEqual(
			users.filter((text) => text === STEER),
			[STEER],
			`the resent steer reached the replacement once: ${JSON.stringify(users)}`,
		);
		assert.deepEqual(sent, []);
		assert.deepEqual(
			notices.filter((notice) => notice.kind === "undelivered"),
			[],
		);
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
