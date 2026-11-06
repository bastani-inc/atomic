/**
 * In-process stand-ins for a pool's local workers and its journal's group commits, used by
 * test/unit/workflow-pool-pipelined-requests.test.ts (#4315).
 *
 * `JournalRounds` holds every pool journal call the test routes through it until the test runs the next round. A
 * round starts only once nothing in the process can move any more, then lets every held call run, so a request that
 * needs `n` sequential journal transactions takes exactly `n` rounds however the host schedules them: a round stands
 * for one group commit of the coordinator's journal under load, which holds a turn of every caller then waiting.
 *
 * `SimulatedPoolWorker` speaks the worker side of the real IPC protocol (packages/workflows/src/workers/protocol.ts)
 * through a `FakeWorkerProcess` that the pool coordinator receives in place of a forked child. Every message is copied
 * as IPC serializes it. The worker claims one pooled child, creates its stage session, then runs agent steps: an
 * admission check, then the assistant entry and the tool result appended back to back, the second sent before the
 * first is answered, each with the sequence number it predicts. Its coalesced heartbeat stays in flight and is sent
 * again before every round once answered, modeling a loaded journal whose round trip outlasts the heartbeat cadence.
 */
import type { Serializable } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SessionMessageEntry } from "@bastani/atomic";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolControl, PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { PoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { rehydrateError } from "../../packages/workflows/src/shared/error-codec.js";
import type {
	DistributiveOmit,
	WorkerInbound,
	WorkerReply,
	WorkerRequest,
	WorkerStart,
} from "../../packages/workflows/src/workers/protocol.js";
import { sleep } from "./runtime.js";

/** Consecutive event-loop turns without progress after which the process counts as settled. */
const SETTLED_TURNS = 3;
/** How long a worker waits before asking for work again while none is queued yet. */
const CLAIM_RETRY_MS = 25;

/** A fixed time for every entry and checkpoint, so the journal contents are the same on every run. */
const FIXED_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const FIXED_ISO = new Date(FIXED_TIME).toISOString();

/** Journal calls held until the test runs the next round. */
export class JournalRounds {
	/** Rounds run so far. */
	count = 0;
	/** Journal transactions run while calls were held, by operation. */
	readonly transactions = new Map<string, number>();
	/** Successful commits in the order the journal applied them, by work id. */
	readonly applied = new Map<string, string[]>();
	private holding = false;
	private held: (() => void)[] = [];
	private running = 0;
	private progress = 0;

	/** `slowSync` gives each released call a delay before it runs, as a slow fsync does; calls then finish out of order. */
	constructor(private readonly slowSync?: () => number) {}

	/** Holds journal calls from now on. */
	hold(): void {
		this.holding = true;
	}

	/** Lets every held call run and holds none from now on. */
	release(): void {
		this.holding = false;
		for (const run of this.held.splice(0)) run();
	}

	/** Runs `call` in the next round while calls are held, or at once otherwise. */
	async through<T>(operation: string, call: () => Promise<T>): Promise<T> {
		if (!this.holding) return call();
		this.progress++;
		this.transactions.set(operation, (this.transactions.get(operation) ?? 0) + 1);
		await new Promise<void>((run) => this.held.push(run));
		this.running++;
		try {
			const delay = this.slowSync?.() ?? 0;
			if (delay > 0) await sleep(delay);
			return await call();
		} finally {
			this.running--;
			this.progress++;
		}
	}

	/** Records a commit the journal applied for `work`. */
	commitApplied(work: string, operation: string): void {
		const applied = this.applied.get(work) ?? [];
		applied.push(operation);
		this.applied.set(work, applied);
	}

	/** Records a message crossing the worker IPC, which counts as progress. */
	moved(): void {
		this.progress++;
	}

	/** Waits until nothing moves, then runs every held call as one round; false when none was held. */
	async next(): Promise<boolean> {
		for (let quiet = 0; quiet < SETTLED_TURNS; ) {
			const before = this.progress;
			await new Promise<void>((resolve) => setImmediate(resolve));
			quiet = this.running === 0 && this.progress === before ? quiet + 1 : 0;
		}
		if (this.held.length === 0) return false;
		this.count++;
		for (const run of this.held.splice(0)) run();
		return true;
	}

	/** Journal transactions run while calls were held. */
	total(): number {
		let total = 0;
		for (const count of this.transactions.values()) total += count;
		return total;
	}
}

/** The coordinator's handle on one simulated worker, in place of a forked child process. */
export class FakeWorkerProcess extends EventEmitter {
	readonly pid: number | undefined = undefined;
	readonly stderr = null;
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	constructor(
		private readonly toWorker: (message: WorkerInbound) => void,
		private readonly rounds: JournalRounds,
	) {
		super();
	}

	/** A reply or push from the coordinator. */
	send(message: Serializable, callback?: (error: Error | null) => void): boolean {
		const copy = JSON.parse(JSON.stringify(message)) as WorkerInbound;
		queueMicrotask(() => {
			this.rounds.moved();
			this.toWorker(copy);
			callback?.(null);
		});
		return true;
	}

	/** A request from the worker. */
	request(message: WorkerRequest): void {
		const copy = JSON.parse(JSON.stringify(message)) as WorkerRequest;
		queueMicrotask(() => {
			this.rounds.moved();
			if (this.connected) this.emit("message", copy);
		});
	}

	kill(): boolean {
		if (this.exitCode !== null || this.signalCode !== null) return true;
		this.signalCode = "SIGKILL";
		this.disconnect();
		queueMicrotask(() => {
			this.emit("exit", null, "SIGKILL");
			this.emit("close", null, "SIGKILL");
		});
		return true;
	}

	disconnect(): void {
		if (!this.connected) return;
		this.connected = false;
		queueMicrotask(() => this.emit("disconnect"));
	}
}

/** The coordinator refused a simulated worker's request. */
export class SimulatedRequestRefusedError extends Error {
	override readonly name = "SimulatedRequestRefusedError" as const;
	readonly code = "request-refused" as const;
	constructor(
		readonly request: WorkerRequest["kind"],
		refusal: Error,
	) {
		super(`Pool coordinator refused a simulated worker's ${request} request: ${refusal.name}`, { cause: refusal });
	}
}

/** A session append's receipt named another sequence number than the one its worker predicted. */
export class SimulatedAppendOrderError extends Error {
	override readonly name = "SimulatedAppendOrderError" as const;
	readonly code = "append-out-of-order" as const;
	constructor(
		readonly sessionId: string,
		readonly expected: number,
		readonly actual: number | undefined,
	) {
		super(`Session ${sessionId} append landed at sequence ${actual}, not the predicted ${expected}`);
	}
}

type Request = DistributiveOmit<WorkerRequest, "id">;
type HeartbeatKind = "heartbeat";
const HEARTBEAT_KINDS: readonly HeartbeatKind[] = ["heartbeat"];

/** The identity of the child run a pooled child's checkpoints carry, read from its boundary-start checkpoint. */
export interface PooledChildRun {
	readonly runId: string;
	readonly runName: string;
	readonly parentRunId: string;
	readonly parentStageId: string;
	readonly rootRunId: string;
}

/** A session entry, the same for one child index and ordinal on every run. */
function entry(index: number, ordinal: number, message: SessionMessageEntry["message"]): SessionMessageEntry {
	return {
		type: "message",
		id: `entry-${index}-${ordinal}`,
		parentId: ordinal === 0 ? null : `entry-${index}-${ordinal - 1}`,
		timestamp: FIXED_ISO,
		message,
	};
}

/** The entries one simulated child's session holds after `steps` agent steps, in order. */
export function expectedSessionEntries(index: number, steps: number) {
	const entries = [entry(index, 0, { role: "user", content: `task ${index}`, timestamp: FIXED_TIME })];
	for (let step = 0; step < steps; step++) entries.push(...stepEntries(index, step));
	return entries;
}

function stepEntries(index: number, step: number) {
	const callId = `call-${index}-${step}`;
	return [
		entry(index, 1 + 2 * step, {
			role: "assistant",
			content: [
				{ type: "text", text: `step ${step} of child ${index}` },
				{ type: "toolCall", id: callId, name: "bash", arguments: { command: `echo ${index}-${step}` } },
			],
			api: "openai-completions",
			provider: "fixture",
			model: "pipelined-model",
			usage: {
				input: 900,
				output: 300,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_200,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: FIXED_TIME,
		}),
		entry(index, 2 + 2 * step, {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: `${index}-${step}` }],
			isError: false,
			timestamp: FIXED_TIME,
		}),
	];
}

/** The usage one simulated child reports after `steps` agent steps. */
export function expectedUsage(steps: number): PoolUsage {
	return { input: 900 * steps, output: 300 * steps, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function sessionIdOf(index: number): string {
	return `pipelined-session-${index}`;
}

export function usageKeyOf(index: number): string {
	return `pipelined-usage-${index}`;
}

/** One local worker, simulated in this process at the level of its IPC requests. */
export class SimulatedPoolWorker {
	readonly process: FakeWorkerProcess;
	/** Rounds each agent step took, from its first request to its last answer. */
	readonly stepRounds: number[] = [];
	/** Commit operations in the order this worker sent them. */
	readonly sentCommits: string[] = [];
	/** Failures of this worker's requests; a correct pool leaves it empty. */
	readonly failures: Error[] = [];
	/** Lease renewals its heartbeat sent while it ran its steps. */
	renewals = 0;
	work?: PoolWork;
	private sequence = 0;
	private readonly pending = new Map<
		number,
		{ readonly kind: WorkerRequest["kind"]; readonly reply: PromiseWithResolvers<WorkerReply["value"]> }
	>();
	private readonly heartbeats = new Map<HeartbeatKind, Promise<void>>();
	private heartbeating = false;
	private lastSeq = 0;
	private stepsDone = 0;

	constructor(
		private readonly start: WorkerStart,
		private readonly rounds: JournalRounds,
		private readonly childRun: (scope: string) => PooledChildRun,
	) {
		this.process = new FakeWorkerProcess((message) => this.receive(message), rounds);
	}

	/** The child index the root enqueued this worker's work with. */
	get index(): number {
		return Number(this.work!.inputs.index);
	}

	/** Becomes ready, claims one pooled child and creates its stage session. */
	async attach(): Promise<void> {
		await this.request({ kind: "ready" });
		const control = (await this.request({ kind: "control" })) as PoolControl;
		await this.request({ kind: "controlled", revision: control.revision });
		for (;;) {
			const work = (await this.request({ kind: "claim" })) as PoolWork | undefined;
			if (work) {
				this.work = work;
				break;
			}
			await sleep(CLAIM_RETRY_MS);
		}
		const run = this.childRun(this.work.scope);
		const scope = this.work.scope;
		const stageId = `stage-${this.index}`;
		await this.commit("tool-0", {
			kind: "checkpoint",
			checkpoint: {
				kind: "tool",
				workflowId: this.start.root,
				checkpointId: `${scope}:tool:0`,
				name: "step-0",
				args: { ordinal: 0 },
				argsHash: `${scope}:tool-args:0`,
				output: `tool output of child ${this.index}`,
				completedAt: FIXED_TIME,
				topology: {
					version: 1,
					nodeId: "tool-0",
					ordinal: 0,
					order: 0,
					parentIds: [],
					startedAt: FIXED_TIME,
					endedAt: FIXED_TIME,
					run,
				},
			},
		});
		const created = await this.commit("session-create", {
			kind: "session-create",
			checkpoint: {
				kind: "stage",
				workflowId: this.start.root,
				checkpointId: `${scope}:session:${sessionIdOf(this.index)}`,
				replayKey: `${scope}:agent`,
				name: "agent",
				sessionId: sessionIdOf(this.index),
				completedAt: FIXED_TIME,
				startedAt: FIXED_TIME,
				model: "fixture/pipelined-model",
				topology: { version: 1, stageId, parentIds: ["tool-0"], order: 1, sourceOrder: 0, status: "running", run },
			},
			header: {
				id: sessionIdOf(this.index),
				version: 4,
				createdAt: FIXED_ISO,
				cwd: String(this.work.execution.cwd),
				internal: true,
				workflow: { runId: run.runId, stageId, stageName: "agent" },
			},
			entries: [expectedSessionEntries(this.index, 0)[0]!],
		});
		this.lastSeq = created!;
	}

	/** Runs `steps` agent steps with the heartbeat in flight, then reports the child's final usage. */
	async measure(steps: number): Promise<void> {
		this.heartbeating = true;
		this.tick();
		for (let step = 0; step < steps; step++) {
			const began = this.rounds.count;
			await this.request({ kind: "budget" });
			const [assistant, result] = stepEntries(this.index, step);
			await Promise.all([this.append(`assistant-${step}`, assistant!), this.append(`result-${step}`, result!)]);
			this.stepRounds.push(this.rounds.count - began);
			this.stepsDone++;
		}
		this.heartbeating = false;
		await Promise.all(this.heartbeats.values());
		await this.request({ kind: "heartbeat", reports: [{ key: usageKeyOf(this.index), usage: this.usage() }] });
	}

	/** Sends again each heartbeat request that was answered, as the worker's heartbeat timer does. */
	tick(): void {
		if (!this.heartbeating) return;
		for (const kind of HEARTBEAT_KINDS) {
			if (this.heartbeats.has(kind)) continue;
			this.renewals++;
			const request = this.request({ kind, reports: [{ key: usageKeyOf(this.index), usage: this.usage() }] });
			this.heartbeats.set(
				kind,
				request.then(
					() => {
						this.heartbeats.delete(kind);
					},
					(error: Error) => {
						this.heartbeats.delete(kind);
						this.failures.push(error);
					},
				),
			);
		}
	}

	private usage(): PoolUsage {
		return expectedUsage(this.stepsDone);
	}

	/** Appends one entry with the sequence number it must land at if every earlier append landed first. */
	private async append(label: string, value: SessionMessageEntry): Promise<void> {
		const expectSeq = this.lastSeq;
		this.lastSeq += 1;
		const lastSeq = await this.commit(label, {
			kind: "session-append",
			sessionId: sessionIdOf(this.index),
			entries: [value],
			expectSeq,
		});
		if (lastSeq !== expectSeq + 1)
			throw new SimulatedAppendOrderError(sessionIdOf(this.index), expectSeq + 1, lastSeq);
	}

	/** Sends one commit and resolves the session sequence number its receipt names, if any. */
	private async commit(label: string, mutation: PoolMutation): Promise<number | undefined> {
		const operation = `${this.work!.id}:${label}`;
		this.sentCommits.push(operation);
		const receipt = await this.request({ kind: "commit", operation, mutation });
		return typeof receipt === "object" &&
			receipt !== null &&
			"lastSeq" in receipt &&
			typeof receipt.lastSeq === "number"
			? receipt.lastSeq
			: undefined;
	}

	private request(message: Request): Promise<WorkerReply["value"]> {
		const id = ++this.sequence;
		const reply = Promise.withResolvers<WorkerReply["value"]>();
		this.pending.set(id, { kind: message.kind, reply });
		this.process.request({ ...message, id });
		return reply.promise;
	}

	private receive(message: WorkerInbound): void {
		if ("kind" in message) return;
		const pending = this.pending.get(message.id);
		if (pending === undefined) return;
		this.pending.delete(message.id);
		if (message.error === undefined) pending.reply.resolve(message.value);
		else pending.reply.reject(new SimulatedRequestRefusedError(pending.kind, rehydrateError(message.error)));
	}
}
