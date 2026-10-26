/**
 * A stage on a local worker killed twice while its agent works through real tool rounds
 * (#3996): each replacement takes the queued steer and follow-up once, mid-turn, and the chat
 * leaves RECONNECTING as soon as the replacement has them.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@bastani/atomic";
import { Type } from "typebox";
import { beforeAll, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import type { PooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import { acquirePooledStage } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import { ROUNDS_FOLLOW_UP, ROUNDS_RELEASE_FILE, ROUNDS_STEER } from "../fixtures/pool-rounds-child.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/** Structural: a coordinator process, worker processes, real agent tool rounds and two replacements. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 240_000;
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

/** Resolves when `ready` holds, checked now and after every poll of `interval`; names the step when it does not. */
async function step(
	label: string,
	ready: () => boolean | Promise<boolean>,
	execution: Promise<{ readonly status: string; readonly error?: string }>,
	observe: () => string,
): Promise<void> {
	const deadline = AbortSignal.timeout(CONDITION_TIMEOUT_MS);
	let ended: { readonly status: string; readonly error?: string } | undefined;
	void execution.then((outcome) => {
		ended = outcome;
	});
	while (!(await ready())) {
		if (ended !== undefined)
			throw new Error(`the run ended (${ended.status}: ${ended.error ?? ""}) at "${label}": ${observe()}`);
		if (deadline.aborted) throw new Error(`stalled at "${label}": ${observe()}`);
		await sleep(25);
	}
}

async function roundsPool(prefix: string) {
	const directory = makeTempDirectory(prefix);
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const childPath = fileURLToPath(new URL("../fixtures/pool-rounds-child.ts", import.meta.url));
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
	bindStoreDurableBackend(store, backend);
	const controller = new AbortController();
	const execution = run(
		workflow({
			name: `${prefix}root`,
			description: "",
			inputs: {},
			outputs: { text: Type.String() },
			async run(ctx) {
				const result = await ctx.workflow(child, { inputs: { cwd: directory } });
				return { text: String(result.outputs.text) };
			},
		}),
		{},
		{ runId: testRunId(prefix), cwd: directory, store, durableBackend: backend, signal: controller.signal },
	);
	const stage = () =>
		store
			.runs()
			.flatMap((candidate) =>
				candidate.stages
					.filter((entry) => entry.name === "agent" && entry.workerExecution !== undefined)
					.map((entry) => ({ runId: candidate.id, stage: entry })),
			)[0];
	const generation = () => stage()?.stage.workerExecution?.generation ?? 0;
	const kill = (): number => {
		const killed = generation();
		const [worker] = pool.workerPids;
		assert.ok(worker !== undefined, "no worker to kill");
		process.kill(worker, "SIGKILL");
		return killed;
	};
	const close = async () => {
		writeFileSync(join(directory, ROUNDS_RELEASE_FILE), "");
		controller.abort(new Error("test cleanup"));
		await execution.catch(() => {});
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	};
	return { directory, backend, pool, store, execution, stage, generation, kill, close };
}

/** The users' and the stage's own texts in the finished stage's session, in order. */
async function transcript(live: Awaited<ReturnType<typeof roundsPool>>): Promise<string[]> {
	const finished = live.stage()!.stage;
	const sessions = await poolSessionStore(live.backend);
	assert.ok(sessions !== undefined);
	const messages = (await SessionManager.open(sessions, finished.sessionId!)).buildSessionContext().messages;
	await sessions.close();
	return messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => `${message.role}: ${textOf(message)}`)
		.filter((line) => !line.endsWith(": "));
}

/**
 * Waits until the stage's view is bound to an attempt after `killed` and that attempt holds every
 * message sent, logging the attempt the rebind watched.
 */
async function rebound(
	live: Awaited<ReturnType<typeof roundsPool>>,
	handle: PooledStageHandle,
	killed: number,
	targets: string[],
	observe: () => string,
): Promise<void> {
	await step(
		`rebound past generation ${killed}`,
		() => handle.placement.generation > killed && !handle.isReconnecting && !handle.hasPending,
		live.execution,
		observe,
	);
	targets.push(
		`${handle.runId}/${handle.stageId}@${handle.placement.workId}#${handle.placement.generation} via ${handle.watch}`,
	);
}

for (const scenario of ["chat closed at the first kill", "chat open throughout"] as const)
	test.skipIf(process.platform === "win32")(
		`killed twice mid-turn (${scenario}), the stage takes its steer and follow-up once each, mid-turn, and leaves RECONNECTING (#3996)`,
		async () => {
			const live = await roundsPool(`pool-stage-rekill-${scenario === "chat open throughout" ? "open" : "closed"}-`);
			const targets: string[] = [];
			let handle: PooledStageHandle | undefined;
			const observe = () =>
				JSON.stringify({
					targets,
					placement: handle?.placement,
					reconnecting: handle?.isReconnecting,
					pending: handle?.hasPending,
					queued: handle?.queuedUserMessages(),
					generation: live.generation(),
					status: live.stage()?.stage.status,
				});
			let lease: Awaited<ReturnType<typeof acquirePooledStage>>;
			const attach = async () => {
				const target = live.stage()!;
				lease = await acquirePooledStage(live.store, target.runId, target.stage.id);
				assert.ok(lease !== undefined, "the stage's view opens");
				handle = lease.handle as PooledStageHandle;
			};
			try {
				// The first round's tool call finished and the agent holds before the next one.
				await step(
					"first round done",
					async () => {
						const target = live.stage();
						if (target === undefined || live.generation() !== 1) return false;
						const view = await acquirePooledStage(live.store, target.runId, target.stage.id);
						const done = view?.handle.messages.some((message) => message.role === "toolResult") === true;
						view?.release();
						return done;
					},
					live.execution,
					observe,
				);
				if (scenario === "chat open throughout") {
					await attach();
					await handle!.steer(`${ROUNDS_STEER}-1`);
					await handle!.followUp(`${ROUNDS_FOLLOW_UP}-1`);
					await rebound(live, handle!, 0, targets, observe);
					await rebound(live, handle!, live.kill(), targets, observe);
				} else {
					const killed = live.kill();
					await step("replacement running", () => live.generation() > killed, live.execution, observe);
					await attach();
					await handle!.steer(`${ROUNDS_STEER}-1`);
					await handle!.followUp(`${ROUNDS_FOLLOW_UP}-1`);
					await rebound(live, handle!, killed, targets, observe);
				}
				// The second kill: the text was admitted by the replacement but not consumed yet.
				await rebound(live, handle!, live.kill(), targets, observe);
				assert.equal(live.stage()?.stage.status, "running", "the stage still works its rounds");
				writeFileSync(join(live.directory, ROUNDS_RELEASE_FILE), "");
				await step(
					"stage finished",
					async () => await Promise.race([live.execution.then(() => true), sleep(0).then(() => false)]),
					live.execution.then(() => new Promise(() => {})),
					observe,
				);
				lease?.release();
				const outcome = await live.execution;
				assert.equal(outcome.status, "completed", JSON.stringify(outcome));
				const lines = await transcript(live);
				console.log(`[pool-stage-rekill ${scenario}] rebind targets`, targets, lines);
				assert.equal(
					new Set(targets.map((target) => target.split("@")[0])).size,
					1,
					"every rebind watched the same stage",
				);
				const steerAt = lines.indexOf(`user: ${ROUNDS_STEER}-1`);
				assert.ok(steerAt >= 0, `the steer arrived: ${JSON.stringify(lines)}`);
				assert.equal(
					lines.filter((line) => line === `user: ${ROUNDS_STEER}-1`).length,
					1,
					"the steer arrived once",
				);
				assert.equal(
					lines.filter((line) => line === `user: ${ROUNDS_FOLLOW_UP}-1`).length,
					1,
					"the follow-up arrived once",
				);
				assert.match(
					lines[steerAt + 1] ?? "",
					new RegExp(`^assistant: ack ${ROUNDS_STEER}-1 after`),
					"the steer was answered in the turn it joined",
				);
				assert.ok(
					lines.indexOf(`user: ${ROUNDS_FOLLOW_UP}-1`) > steerAt,
					"the follow-up came after the steer's turn",
				);
			} finally {
				lease?.release();
				await live.close();
			}
		},
		LOCAL_WORKER_PROCESS_TIMEOUT_MS,
	);
