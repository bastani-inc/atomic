import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSessionBusyError, isAgentSessionBusyError } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import type { PoolWork, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { isStaleLeaseError, type Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	isPublicationRejectedError,
	isStaleWorkLeaseError,
	PublicationRejectedError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	isQuarantinedCapacityError,
	isWorkerCleanupUnconfirmedError,
	isWorkerLostError,
	isWorkerRetryLimitError,
	isWorkerStartupError,
	isWorkerStartupTimeoutError,
	QuarantinedCapacityError,
	WorkerStartupTimeoutError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import type { CoordinatorEvent } from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { workerLogDirectory } from "../../packages/workflows/src/workers/pool-coordinator.js";
import type { WorkerReply } from "../../packages/workflows/src/workers/protocol.js";
import type { DeliveryOpId, WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import type { FakeWorker } from "../helpers/fake-pool-worker.js";
import {
	type CoordinatorFixtureOptions,
	coordinatorFixture,
	HEARTBEAT_MS,
	LEASE_MS,
	openCoordinator,
	SOURCE,
} from "../helpers/pool-coordinator.js";
import { poolNotInitialized } from "../helpers/pool-errors.js";

const forked = vi.hoisted((): FakeWorker[] => []);

// Workers with a stderr stream, as forked workers have, so the pool writes their logs.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { FakeWorker } = await import("../helpers/fake-pool-worker.js");
	const { PassThrough } = await import("node:stream");
	return {
		...actual,
		fork(_modulePath: string, args: readonly string[], options: ForkOptions) {
			const worker = new FakeWorker(5_000_000 + forked.length, args, options, new PassThrough());
			forked.push(worker);
			return worker;
		},
	};
});

// A worker log that cannot take a health line is arranged by failing one append.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

afterEach(() => {
	forked.length = 0;
});

const MAX_CHILD_ATTEMPTS = 3;
const MAX_WORKER_REPLACEMENTS = 3;

const fixture = (options: CoordinatorFixtureOptions = {}) => coordinatorFixture(forked, options);

type Fixture = Awaited<ReturnType<typeof fixture>>;

function isEvent<K extends CoordinatorEvent["kind"]>(kind: K) {
	return (event: CoordinatorEvent): event is Extract<CoordinatorEvent, { kind: K }> => event.kind === kind;
}

/** The worker the pool started after `count` workers, readied. */
async function readyReplacement(count: number): Promise<FakeWorker> {
	while (forked.length <= count) await delay(5);
	const worker = forked[count]!;
	await worker.request({ kind: "ready" });
	return worker;
}

function refusal(reply: WorkerReply): Error {
	assert.ok(reply.error, "the request was refused");
	return rehydrateError(reply.error);
}

function childRun(id: string): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", startedAt: 0, stages: [], toolNodes: [] };
}

function assertWorkerLog(f: Fixture, logPath: string | undefined): void {
	assert.ok(logPath !== undefined, "the error names the worker's log");
	assert.ok(logPath.endsWith(".log"), logPath);
	assert.equal(dirname(logPath), workerLogDirectory(f.path, "root"));
}

test("a child whose last attempt was fenced on a pool fault fails alone, with that fault as its retry limit's cause (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		const fault = new QuarantinedCapacityError({ limits: ["processes"], processGroups: [41, 42], waitedMs: 1_500 });
		const claims: PoolWork[] = [];
		for (let attempt = 1; attempt <= MAX_CHILD_ATTEMPTS; attempt++) {
			const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
			assert.equal(claimed.generation, attempt);
			claims.push(claimed);
			const fenced = await worker.request({ kind: "fenced", fault: serializeError(fault) });
			assert.equal(fenced.error, undefined);
		}
		const failed = await f.next(isEvent("work-failure"));
		assert.equal(failed.workId, claims[0]!.id);
		const error = rehydrateError(failed.error);
		assert.ok(isWorkerRetryLimitError(error), String(error));
		assert.equal(error.code, "worker_retry_limit");
		assert.equal(error.reason, "pool-fault");
		assert.equal(error.attempts, MAX_CHILD_ATTEMPTS);
		assert.equal(error.limit, MAX_CHILD_ATTEMPTS);
		assert.equal(error.childRunId, f.descriptor.childRunId);
		assert.equal(error.exportName, SOURCE.exportName);
		assert.equal(error.logPath, undefined);
		assert.ok(isQuarantinedCapacityError(error.cause), String(error.cause));
		assert.deepEqual(error.cause.processGroups, [41, 42]);
		assert.equal(error.cause.waitedMs, 1_500);
		assert.equal(f.events.filter(isEvent("fence")).length, MAX_CHILD_ATTEMPTS, "each fenced attempt ended its views");
		assert.equal(f.events.filter(isEvent("failure")).length, 0, "the pool itself keeps running");
	} finally {
		await f.close();
	}
});

test("a child refused as stale on every attempt fails with a retry limit that has no cause (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		for (let attempt = 1; attempt <= MAX_CHILD_ATTEMPTS; attempt++) {
			await worker.request({ kind: "claim" });
			await worker.request({ kind: "fenced" });
		}
		const error = rehydrateError((await f.next(isEvent("work-failure"))).error);
		assert.ok(isWorkerRetryLimitError(error), String(error));
		assert.equal(error.reason, "refused-stale");
		assert.equal(error.attempts, MAX_CHILD_ATTEMPTS);
		assert.equal(error.cause, undefined);
	} finally {
		await f.close();
	}
});

test("a child that lost its worker on every attempt fails with a retry limit naming the last worker's log (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		let worker = f.workers[0]!;
		for (let attempt = 1; attempt <= MAX_CHILD_ATTEMPTS; attempt++) {
			const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
			assert.equal(claimed.generation, attempt);
			const exited = forked.length;
			worker.exit(1);
			if (attempt < MAX_CHILD_ATTEMPTS) worker = await readyReplacement(exited);
		}
		const failed = await f.next(isEvent("work-failure"));
		const error = rehydrateError(failed.error);
		assert.ok(isWorkerRetryLimitError(error), String(error));
		assert.equal(error.reason, "worker-lost");
		assert.equal(error.attempts, MAX_CHILD_ATTEMPTS);
		assert.equal(error.limit, MAX_CHILD_ATTEMPTS);
		assert.equal(error.childRunId, f.descriptor.childRunId);
		assertWorkerLog(f, error.logPath);
		assert.equal(error.logFailure, undefined);
		assert.equal(error.cause, undefined);
	} finally {
		await f.close();
	}
});

test("workers that keep crashing without work fail the pool with a typed retry limit (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		let worker = f.workers[0]!;
		for (let crash = 1; crash <= MAX_WORKER_REPLACEMENTS + 1; crash++) {
			const exited = forked.length;
			worker.exit(1);
			if (crash <= MAX_WORKER_REPLACEMENTS) worker = await readyReplacement(exited);
		}
		const error = rehydrateError((await f.next(isEvent("failure"))).error);
		assert.ok(isWorkerRetryLimitError(error), String(error));
		assert.equal(error.code, "worker_retry_limit");
		assert.equal(error.reason, "worker-crashes");
		assert.equal(error.attempts, MAX_WORKER_REPLACEMENTS + 1);
		assert.equal(error.limit, MAX_WORKER_REPLACEMENTS);
		assert.equal(error.childRunId, undefined);
		assertWorkerLog(f, error.logPath);
		assert.equal(f.events.filter(isEvent("work-failure")).length, 0, "no child failed");
	} finally {
		await f.close();
	}
});

test("a worker that exits before it is ready fails the pool's start with a typed startup error naming its log (#4327)", async () => {
	const f = await fixture({ workers: 1, start: false });
	try {
		const starting = f.command({ kind: "start", sources: [SOURCE], cwd: f.directory, publish: false }).then(
			() => assert.fail("the start succeeded"),
			(error: unknown) => error,
		);
		while (forked.length === 0) await delay(5);
		forked[0]!.exit(1);
		const error = await starting;
		assert.ok(isWorkerStartupError(error), String(error));
		assert.equal(isWorkerStartupTimeoutError(error), false);
		assert.equal(error.code, "worker_startup_failed");
		assertWorkerLog(f, error.logPath);
		assert.equal(error.logFailure, undefined);
	} finally {
		await f.close();
	}
});

test("a coordinator not prepared for its root refuses to start workers or take a child, typed (#4327)", async () => {
	const f = await fixture({ workers: 1, start: false });
	const unprepared = openCoordinator();
	const refusedPrepare = openCoordinator();
	try {
		const start = { kind: "start", sources: [SOURCE], cwd: f.directory, publish: false } as const;
		const enqueue = { kind: "enqueue", descriptor: f.descriptor, boundary: f.boundary } as const;
		await assert.rejects(unprepared.command(start), poolNotInitialized(undefined));
		await assert.rejects(unprepared.command(enqueue), poolNotInitialized(undefined));
		// A lease the root no longer holds fails the preparation after the coordinator took the root, before its queue.
		await assert.rejects(
			refusedPrepare.command({
				kind: "prepare",
				root: "root",
				lease: { ...f.lease, holderId: "another-holder" },
				options: {
					journalPath: f.path,
					workers: 1,
					leaseMs: LEASE_MS,
					heartbeatMs: HEARTBEAT_MS,
					startupTimeoutMs: 30_000,
					workerEntry: "fake-worker",
				},
			}),
			(error) => isStaleLeaseError(error),
		);
		await assert.rejects(refusedPrepare.command(start), poolNotInitialized("root"));
		await assert.rejects(refusedPrepare.command(enqueue), poolNotInitialized("root"));
		assert.equal(forked.length, 0, "no worker started");
	} finally {
		for (const coordinator of [unprepared, refusedPrepare]) {
			await coordinator.command({ kind: "close" });
			await coordinator.coordinator.shutdown();
		}
		await f.close();
	}
});

const SHORT_STARTUP_TIMEOUT_MS = 50;

test("a worker that misses its startup deadline is stopped and fails the start with a typed timeout (#4327)", async () => {
	const f = await fixture({ workers: 1, start: false, startupTimeoutMs: SHORT_STARTUP_TIMEOUT_MS });
	try {
		const error = await f.command({ kind: "start", sources: [SOURCE], cwd: f.directory, publish: false }).then(
			() => assert.fail("the start succeeded"),
			(failure: unknown) => failure,
		);
		assert.ok(error instanceof WorkerStartupTimeoutError, String(error));
		assert.equal(error.code, "worker_startup_failed");
		assert.equal(error.phase, "startup");
		assert.equal(error.timeoutMs, SHORT_STARTUP_TIMEOUT_MS);
		assert.ok(error.elapsedMs >= SHORT_STARTUP_TIMEOUT_MS, `${error.elapsedMs} ms`);
		assertWorkerLog(f, error.logPath);
		assert.equal(forked[0]!.killedWith, "SIGKILL");
	} finally {
		await f.close();
	}
});

test("a worker log the pool cannot write is reported once, and the startup error names why (#4327)", async () => {
	const f = await fixture({ workers: 2, start: false });
	try {
		const logs = workerLogDirectory(f.path, "root");
		mkdirSync(dirname(logs), { recursive: true });
		writeFileSync(logs, "not a directory");
		const starting = f.command({ kind: "start", sources: [SOURCE], cwd: f.directory, publish: false }).then(
			() => assert.fail("the start succeeded"),
			(error: unknown) => error,
		);
		while (forked.length < 2) await delay(5);
		forked[0]!.exit(1);
		forked[1]!.exit(1);
		const error = await starting;
		assert.ok(isWorkerStartupError(error), String(error));
		assert.ok(error.logFailure === "EEXIST" || error.logFailure === "ENOTDIR", error.logFailure);
		const health = f.events.filter(isEvent("health"));
		assert.equal(health.length, 1, "one warning for the pool, not one per worker");
		assert.ok(health[0]!.message.includes(error.logFailure!), health[0]!.message);
		assert.ok(health[0]!.message.includes(error.logPath), "the warning names the first log that failed");
	} finally {
		await f.close();
	}
});

test("the root's refusal of a published attempt reaches its worker typed, on its next activity and delivery (#4327)", async () => {
	const f = await fixture({ workers: 1, publish: true });
	try {
		const [worker] = f.workers as [FakeWorker];
		const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
		await worker.request({ kind: "activity", runs: [childRun("child-run")] });
		const batch = await f.next(isEvent("activity"));
		const rejection = new PublicationRejectedError({
			root: "root",
			workId: claimed.id,
			generation: claimed.generation,
			reason: "outside-subtree",
			runId: "child-run",
		});
		f.notice({
			kind: "published",
			batch: batch.batch,
			rejected: [{ workId: claimed.id, generation: claimed.generation, error: serializeError(rejection) }],
		});
		for (const refused of [
			await worker.request({ kind: "activity", runs: [childRun("child-run")] }),
			await worker.request({ kind: "delivery-ready", runId: "child-run", stageId: "stage", stageName: "stage" }),
		]) {
			const error = refusal(refused);
			assert.ok(isPublicationRejectedError(error), String(error));
			assert.equal(error.reason, "outside-subtree");
			assert.equal(error.workId, claimed.id);
			assert.equal(error.generation, claimed.generation);
			assert.equal(error.runId, "child-run");
		}
	} finally {
		await f.close();
	}
});

test("the root's typed refusal of a readiness or delivery request reaches the worker typed (#4327)", async () => {
	const f = await fixture({ workers: 1, publish: true });
	try {
		const [worker] = f.workers as [FakeWorker];
		const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
		const stale = new PublicationRejectedError({
			root: "root",
			workId: claimed.id,
			generation: claimed.generation,
			reason: "stale-lease",
		});
		const ready = worker.ask({ kind: "delivery-ready", runId: "child-run", stageId: "stage", stageName: "stage" });
		const readiness = await f.rootRequest();
		assert.equal(readiness.request.kind, "ready");
		f.answer(readiness.id, { error: serializeError(stale) });
		const readyError = refusal(await ready.reply);
		assert.ok(isPublicationRejectedError(readyError), String(readyError));
		assert.equal(readyError.reason, "stale-lease");
		assert.equal(readyError.retryable, true);

		const after = f.events.length;
		const delivery = worker.ask({
			kind: "delivery",
			runId: "child-run",
			stageId: "stage",
			stageName: "stage",
			recipient: { sessionId: "session", receivedMessageIds: [] },
		});
		const deliver = await f.rootRequest(after);
		assert.equal(deliver.request.kind, "deliver");
		f.answer(deliver.id, { error: serializeError(new AgentSessionBusyError()) });
		const deliveryError = refusal(await delivery.reply);
		assert.ok(isAgentSessionBusyError(deliveryError), String(deliveryError));
	} finally {
		await f.close();
	}
});

const SENDER = {
	id: "sender",
	cwd: "/",
	model: "model",
	pid: 1,
	startedAt: 0,
	lastActivity: 0,
};

/** A delivery request of `worker` the root holds open, and its transport command for one message. */
async function openDelivery(f: Fixture, worker: FakeWorker) {
	const after = f.events.length;
	const delivery = worker.ask({
		kind: "delivery",
		runId: "child-run",
		stageId: "stage",
		stageName: "stage",
		recipient: { sessionId: "session", receivedMessageIds: [] },
	});
	const deliver = await f.rootRequest(after);
	const transport = f
		.command({
			kind: "transport",
			request: deliver.id,
			from: SENDER,
			message: { id: "message", timestamp: 0, content: { text: "hello" } },
		})
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	return { delivery, deliver, transport };
}

test("a delivery its worker refused, or lost with its worker, fails the root's transport typed (#4327)", async () => {
	const f = await fixture({ workers: 1, publish: true });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		const refused = await openDelivery(f, worker);
		while (worker.deliveries.length === 0) await delay(5);
		worker.tell({
			id: 0,
			kind: "delivery-ack",
			deliveryId: worker.deliveries[0]!.id,
			error: serializeError(new AgentSessionBusyError()),
		});
		assert.ok(isAgentSessionBusyError(await refused.transport));

		const lost = await openDelivery(f, worker);
		while (worker.deliveries.length < 2) await delay(5);
		worker.exit(null, "SIGKILL");
		const error = await lost.transport;
		assert.ok(isWorkerLostError(error), String(error));
		assert.equal(error.code, "worker_lost");
		assert.equal(error.phase, "delivery");
		assert.equal(error.pid, worker.pid);
		assert.equal(error.exitCode, undefined);
		assert.equal(error.signal, "SIGKILL");

		const late = await f
			.command({
				kind: "transport",
				request: lost.deliver.id,
				from: SENDER,
				message: { id: "late", timestamp: 0, content: { text: "late" } },
			})
			.then(
				() => undefined,
				(failure: unknown) => failure,
			);
		assert.ok(isWorkerLostError(late), String(late));
		assert.equal(late.phase, "delivery");
		assert.equal(late.pid, worker.pid);
	} finally {
		await f.close();
	}
});

test("a delivery acknowledged by a worker that then exits with a code reports that code (#4327)", async () => {
	const f = await fixture({ workers: 1, publish: true });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		const pending = await openDelivery(f, worker);
		while (worker.deliveries.length === 0) await delay(5);
		worker.exit(3);
		const error = await pending.transport;
		assert.ok(isWorkerLostError(error), String(error));
		assert.equal(error.exitCode, 3);
		assert.equal(error.signal, undefined);
	} finally {
		await f.close();
	}
});

/** Answers the next stage command pushed to `worker` with `result`. */
async function answerStageCommand(
	worker: FakeWorker,
	seen: number,
	result: { readonly error?: ReturnType<typeof serializeError>; readonly snapshot?: object },
): Promise<void> {
	while (worker.pushed.filter((message) => message.kind === "stage-command").length <= seen) await delay(5);
	const command = worker.pushed.filter((message) => message.kind === "stage-command")[seen]!;
	assert.equal(command.kind, "stage-command");
	worker.tell({ id: 0, kind: "stage-command-result", commandId: command.commandId, ...result } as never);
}

test("a stage command the worker refused with an error fails the root's command with that error, typed (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		await worker.request({ kind: "activity", runs: [childRun("child-run")] });
		const busy = serializeError(new AgentSessionBusyError());
		const watch = "watch" as WatchId;
		const watching = f.command({ kind: "stage-watch", watch, runId: "child-run", stageId: "stage" });
		await answerStageCommand(worker, 0, {
			snapshot: {
				sessionId: "session",
				status: "running",
				isStreaming: false,
				messages: [],
				pendingToolExecutionEvents: [],
				queued: { steering: [], followUp: [] },
			},
		});
		assert.deepEqual(((await watching) as { ok: boolean }).ok, true);
		const commands = [
			f.command({
				kind: "stage-answer",
				runId: "child-run",
				stageId: "stage",
				answer: { kind: "prompt", promptId: "p", response: "yes" },
			}),
			f.command({ kind: "stage-deliver", watch, op: "op" as DeliveryOpId, text: "hi", intent: "steer" }),
			f.command({ kind: "stage-pause", watch }),
			f.command({ kind: "stage-session", watch, command: { kind: "compact" } }),
		];
		for (let index = 0; index < commands.length; index++)
			await answerStageCommand(worker, index + 1, { error: busy });
		for (const settled of await Promise.allSettled(commands)) {
			assert.equal(settled.status, "rejected");
			assert.ok(isAgentSessionBusyError(settled.reason), String(settled.reason));
		}
	} finally {
		await f.close();
	}
});

/** A watch the worker opened on stage `stage` of `child-run`, after the worker published that run. */
async function openWatch(f: Fixture, worker: FakeWorker): Promise<WatchId> {
	await worker.request({ kind: "activity", runs: [childRun("child-run")] });
	const watch = "watch" as WatchId;
	const watching = f.command({ kind: "stage-watch", watch, runId: "child-run", stageId: "stage" });
	await answerStageCommand(worker, 0, {
		snapshot: {
			sessionId: "session",
			status: "running",
			isStreaming: false,
			messages: [],
			pendingToolExecutionEvents: [],
			queued: { steering: [], followUp: [] },
		},
	});
	assert.equal(((await watching) as { ok: boolean }).ok, true);
	return watch;
}

test("stage commands a worker carried out report what it did, and one its worker took down is refused (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		const watch = await openWatch(f, worker);
		const answered = f.command({
			kind: "stage-answer",
			runId: "child-run",
			stageId: "stage",
			answer: { kind: "prompt", promptId: "p", response: "yes" },
		});
		await answerStageCommand(worker, 1, {});
		assert.deepEqual(await answered, { ok: true });
		const delivered = f.command({
			kind: "stage-deliver",
			watch,
			op: "op" as DeliveryOpId,
			text: "hi",
			intent: "steer",
		});
		await answerStageCommand(worker, 2, { action: "steer" } as never);
		assert.deepEqual(await delivered, { ok: true, action: "steer" });
		const paused = f.command({ kind: "stage-pause", watch });
		await answerStageCommand(worker, 3, {});
		assert.deepEqual(await paused, { ok: true });
		const compacted = f.command({ kind: "stage-session", watch, command: { kind: "compact" } });
		await answerStageCommand(worker, 4, {});
		assert.deepEqual(await compacted, { ok: true });

		const inFlight = f.command({
			kind: "stage-answer",
			runId: "child-run",
			stageId: "stage",
			answer: { kind: "prompt", promptId: "p2", response: "no" },
		});
		while (worker.pushed.filter((message) => message.kind === "stage-command").length < 6) await delay(5);
		worker.exit(1);
		assert.deepEqual(await inFlight, { ok: false, refusal: "StaleAttempt" });
	} finally {
		await f.close();
	}
});

test("a delivery its worker acknowledged completes the transport, and stray answers are ignored (#4327)", async () => {
	const f = await fixture({ workers: 1, publish: true });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		const ready = worker.ask({ kind: "delivery-ready", runId: "child-run", stageId: "stage", stageName: "stage" });
		const readiness = await f.rootRequest();
		f.answer(readiness.id, { value: "ready" });
		const answered = await ready.reply;
		assert.equal(answered.error, undefined);
		assert.equal(answered.value, "ready");
		assert.doesNotThrow(() => f.answer(9_999, { error: serializeError(new AgentSessionBusyError()) }));

		const pending = await openDelivery(f, worker);
		while (worker.deliveries.length === 0) await delay(5);
		worker.tell({ id: 0, kind: "delivery-ack", deliveryId: worker.deliveries[0]!.id });
		assert.equal(await pending.transport, undefined, "the acknowledged delivery succeeded");
		assert.doesNotThrow(() =>
			worker.tell({
				id: 0,
				kind: "delivery-ack",
				deliveryId: "never-sent",
				error: serializeError(new AgentSessionBusyError()),
			}),
		);
	} finally {
		await f.close();
	}
});

test("a request the pool refused for its own reasons does not end the root's hold: the worker is replaced (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		const refused = refusal(await worker.request({ kind: "heartbeat", reports: [] }));
		assert.equal(isStaleLeaseError(refused), false);
		worker.exit(1);
		const replacement = await readyReplacement(1);
		assert.notEqual(replacement, worker);
	} finally {
		await f.close();
	}
});

test("a child that lost its worker on every attempt names the log that could not be written (#4327)", async () => {
	const f = await fixture({ workers: 1, start: false });
	try {
		const logs = workerLogDirectory(f.path, "root");
		mkdirSync(dirname(logs), { recursive: true });
		writeFileSync(logs, "not a directory");
		const starting = f.command({ kind: "start", sources: [SOURCE], cwd: f.directory, publish: false });
		let worker = await readyReplacement(0);
		await starting;
		await f.command({ kind: "enqueue", descriptor: f.descriptor, boundary: f.boundary });
		for (let attempt = 1; attempt <= MAX_CHILD_ATTEMPTS; attempt++) {
			await worker.request({ kind: "claim" });
			const exited = forked.length;
			worker.exit(1);
			if (attempt < MAX_CHILD_ATTEMPTS) worker = await readyReplacement(exited);
		}
		const error = rehydrateError((await f.next(isEvent("work-failure"))).error);
		assert.ok(isWorkerRetryLimitError(error), String(error));
		assert.equal(error.reason, "worker-lost");
		assertWorkerLog(f, error.logPath);
		assert.ok(error.logFailure === "EEXIST" || error.logFailure === "ENOTDIR", error.logFailure);
	} finally {
		await f.close();
	}
});

test("a route asked for a run the attempt never published is refused typed (#4327)", async () => {
	const f = await fixture({ workers: 1, publish: true });
	try {
		const [worker] = f.workers as [FakeWorker];
		const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
		const missing = refusal(await worker.request({ kind: "route", runId: "child-run" }));
		assert.ok(isStaleWorkLeaseError(missing), String(missing));
		assert.deepEqual(
			[missing.root, missing.workId, missing.generation, missing.reason],
			["root", claimed.id, claimed.generation, "missing"],
		);
		await worker.request({ kind: "activity", runs: [childRun("child-run")] });
		const batch = await f.next(isEvent("activity"));
		f.notice({ kind: "published", batch: batch.batch, rejected: [] });
		const outside = refusal(await worker.request({ kind: "route", runId: "another-run" }));
		assert.ok(isPublicationRejectedError(outside), String(outside));
		assert.deepEqual(
			[outside.reason, outside.workId, outside.generation, outside.runId],
			["outside-subtree", claimed.id, claimed.generation, "another-run"],
		);
	} finally {
		await f.close();
	}
});

/** The coordinator's own pool queue, to arrange what its recovery reads. */
function coordinatorQueue(f: Fixture): SqlPoolQueue {
	return (f.coordinator as unknown as { readonly queue: SqlPoolQueue }).queue;
}

/** Lets the claimed attempt's work lease lapse, so the next recovery pass looks at it. */
async function lapse(f: Fixture): Promise<void> {
	await f.database.run("UPDATE wf_runs_work SET expires_at = 0");
}

/** Longer than a few recovery passes of the coordinator (each 500 ms apart). */
const RECOVERY_PASSES_MS = 2_000;

test("a recovery pass refused because the root's lease is gone fails the pool with that refusal (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		await lapse(f);
		await f.journal.release(f.lease);
		const error = rehydrateError((await f.next(isEvent("failure"))).error);
		assert.ok(isStaleLeaseError(error), String(error));
		assert.equal(error.runId, "root");
	} finally {
		await f.close().catch(() => {});
	}
});

test("a recovery pass refused while the root renews late waits for the renewal instead of failing (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		vi.spyOn(coordinatorQueue(f), "rootLease").mockResolvedValueOnce("current");
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		await lapse(f);
		await delay(RECOVERY_PASSES_MS);
		await f.database.run("UPDATE wf_leases SET renewed_at = ?", Date.now());
		await delay(RECOVERY_PASSES_MS);
		assert.deepEqual(f.events.filter(isEvent("failure")), [], "a late renewal fails nothing");
	} finally {
		vi.restoreAllMocks();
		await f.close();
	}
});

test("a recovery pass that fails for another reason fails the pool with that error (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		vi.spyOn(coordinatorQueue(f), "inspect").mockRejectedValueOnce(new AgentSessionBusyError());
		const error = rehydrateError((await f.next(isEvent("failure"))).error);
		assert.ok(isAgentSessionBusyError(error), String(error));
	} finally {
		vi.restoreAllMocks();
		await f.close().catch(() => {});
	}
});

test("a recovery pass whose wait for the root's renewal fails fails the pool with the lease refusal (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		await worker.request({ kind: "claim" });
		vi.spyOn(coordinatorQueue(f), "rootLease")
			.mockResolvedValueOnce("current")
			.mockRejectedValueOnce(new AgentSessionBusyError());
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		await lapse(f);
		const error = rehydrateError((await f.next(isEvent("failure"))).error);
		assert.ok(isStaleLeaseError(error), String(error));
	} finally {
		vi.restoreAllMocks();
		await f.close().catch(() => {});
	}
});

test("a resumed root replays a child whose recorded result failed on the pool, and keeps any other result (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		const [worker] = f.workers as [FakeWorker];
		const claimed = (await worker.request({ kind: "claim" })).value as PoolWork;
		const result = {
			runId: claimed.childRunId,
			status: "failed",
			stages: [{ id: "stage", status: "failed", failureCode: "stale_work_lease" }],
			toolNodes: [],
		};
		assert.equal((await worker.request({ kind: "complete", result: result as never })).error, undefined);
		await f.stop();
		await f.journal.release(f.lease);
		const acquired = await f.journal.acquire("root", "root-holder");
		assert.equal(acquired.status, "acquired");
		const resumed = await f.resume((acquired as { lease: Lease }).lease);
		const enqueued = (await resumed.command({
			kind: "enqueue",
			descriptor: f.descriptor,
			boundary: f.boundary,
		})) as { readonly work: PoolWork; readonly result?: unknown };
		assert.equal(enqueued.work.state, "ready", "the child replays under the resumed root");
		assert.equal(enqueued.result, undefined);
	} finally {
		await f.close();
	}
});

/** The admission of a coordinator whose stopped workers' process groups all survive their reap. */
function survivingReap(f: Fixture): void {
	(f.coordinator as unknown as { admission?: object }).admission = {
		releaseStoppedSessions: async () => 1,
		reapStoppedProcesses: async () => [4_242],
		reconcile: async () => {},
	};
}

const LOG_MARKER = " (worker log: ";

test("a worker whose process groups survive its reap is a health event its log keeps, or reports the log it could not write (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		survivingReap(f);
		f.workers[0]!.exit(1);
		const health = await f.next(isEvent("health"));
		assert.ok(health.message.includes(LOG_MARKER), health.message);
		const logPath = health.message.slice(health.message.lastIndexOf(LOG_MARKER) + LOG_MARKER.length, -1);
		const recorded = health.message.slice(0, health.message.lastIndexOf(LOG_MARKER));
		assert.ok(recorded.startsWith("Local worker process cleanup unconfirmed"), recorded);
		assertWorkerLog(f, logPath);
		await vi.waitFor(() => {
			const line = readFileSync(logPath, "utf8")
				.split("\n")
				.find((entry) => entry.endsWith(`] ${recorded}`));
			assert.ok(line?.startsWith("[atomic "), line);
		});

		const replacement = await readyReplacement(1);
		vi.mocked(appendFile).mockRejectedValueOnce(Object.assign(new Error("no space"), { code: "ENOSPC" }));
		const after = f.events.length;
		replacement.exit(1);
		const unwritable = await f.next(
			(event): event is Extract<CoordinatorEvent, { kind: "health" }> =>
				isEvent("health")(event) && event.message.includes("could not be written"),
			after,
		);
		assert.ok(unwritable.message.includes("(ENOSPC)"), unwritable.message);
	} finally {
		vi.mocked(appendFile).mockClear();
		await f.close().catch(() => {});
	}
});

test("workers lost while they held a child never count toward the pool's limit of crashing idle workers (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		let worker = f.workers[0]!;
		for (let attempt = 1; attempt <= MAX_CHILD_ATTEMPTS; attempt++) {
			await worker.request({ kind: "claim" });
			const exited = forked.length;
			worker.exit(1);
			worker = await readyReplacement(exited);
		}
		await f.next(isEvent("work-failure"));
		// One idle crash after three lost attempts is the pool's first, so the worker is replaced.
		const exited = forked.length;
		worker.exit(1);
		await readyReplacement(exited);
		assert.deepEqual(f.events.filter(isEvent("failure")), [], "the pool did not fail");
	} finally {
		await f.close();
	}
});

test("a child whose last worker left process groups running fails on losing it, with that cleanup beside the fault (#4327)", async () => {
	const f = await fixture({ workers: 1 });
	try {
		survivingReap(f);
		let worker = f.workers[0]!;
		for (let attempt = 1; attempt <= MAX_CHILD_ATTEMPTS; attempt++) {
			await worker.request({ kind: "claim" });
			const exited = forked.length;
			worker.exit(1);
			if (attempt < MAX_CHILD_ATTEMPTS) worker = await readyReplacement(exited);
		}
		const error = rehydrateError((await f.next(isEvent("work-failure"))).error);
		assert.ok(isWorkerRetryLimitError(error), String(error));
		assert.equal(error.reason, "worker-lost");
		assert.equal(error.cause, undefined, "losing the worker is the fault; nothing caused it");
		const cleanup = error.cleanupCause;
		assert.ok(isWorkerCleanupUnconfirmedError(cleanup), String(cleanup));
		assert.deepEqual(cleanup.processGroups, [4_242]);
	} finally {
		await f.close().catch(() => {});
	}
});
