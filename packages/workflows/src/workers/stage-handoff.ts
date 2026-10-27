import { pendingStageMessagesForDurableRun } from "../durable/backend.js";
import type { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import type { PoolWork, SqlPoolQueue } from "../durable/journal/sql-pool-queue.js";
import type { Lease } from "../durable/journal/types.js";
import { parseWorkflowChildResult } from "../durable/workflow-child-result.js";
import type { RunResult } from "../runs/foreground/executor-types.js";
import { createWorkflowPendingStageDelivery } from "../runs/foreground/pending-stage-delivery.js";
import {
	rotateWorkflowPendingStageRouteCapability,
	workflowPendingStageRouteCapability,
} from "../shared/pending-stage-route-capability.js";
import { workflowPendingStageRouteReady } from "../shared/pending-stage-route-readiness.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { authoritativeWorkflowChildRunId } from "../shared/workflow-run-ownership.js";

type PendingDelivery = ReturnType<typeof createWorkflowPendingStageDelivery>;
type PendingDeliver = Parameters<PendingDelivery["deliverPending"]>[0];
type PendingRecipient = NonNullable<Parameters<PendingDelivery["deliverPending"]>[1]>;

export type PoolStageTransport = (...args: Parameters<PendingDeliver>) => Promise<void>;

/** The work-lease checks the handoff needs; a coordinator-driven pool answers them from its own attempt state. */
export type PoolStageQueue = Pick<SqlPoolQueue, "assertCurrent" | "withCurrentAppend" | "result">;

export interface PoolStagePublication {
	readonly work: PoolWork;
	readonly runs: readonly RunSnapshot[];
}

interface Attempt {
	readonly generation: number;
	readonly runs: Set<string>;
	readonly deliveries: Map<string, PendingDelivery>;
	readonly sessions: Map<string, string>;
	fenced: boolean;
}

const STALE = "Stale work lease";

export class PoolStageHandoff {
	private readonly attempts = new Map<string, Attempt>();
	private readonly owners = new Map<string, string>();
	private readonly publications = new Map<string, Promise<void>>();
	private readonly drains = new Map<string, Promise<void>>();

	constructor(
		private readonly backend: JournalDurableBackend,
		private readonly store: Store,
		private readonly queue: PoolStageQueue,
		private readonly lease: Lease,
		/** Called for every accepted run before it reaches the store, e.g. to route it elsewhere. */
		private readonly claimRun?: (runId: string) => void,
	) {}

	publish(work: PoolWork, runs: readonly RunSnapshot[]): Promise<void> {
		const previous = this.publications.get(work.id) ?? Promise.resolve();
		const publication = previous
			.catch(() => undefined)
			.then(async () => {
				const commit = await this.prepare(work, runs);
				this.store.batch(commit);
			});
		const settled = publication.catch(() => undefined);
		this.publications.set(work.id, settled);
		void settled.then(() => {
			if (this.publications.get(work.id) === settled) this.publications.delete(work.id);
		});
		return publication;
	}

	/**
	 * Publish the latest activity of several attempts with one store invalidation, in order.
	 * Returns each publication's rejection, or undefined for an accepted one.
	 */
	async publishBatch(publications: readonly PoolStagePublication[]): Promise<(Error | undefined)[]> {
		const prepared: ((() => void) | Error)[] = [];
		for (const { work, runs } of publications)
			prepared.push(await this.prepare(work, runs).catch((error: Error) => error));
		return this.store.batch(() =>
			prepared.map((commit) => {
				if (commit instanceof Error) return commit;
				try {
					commit();
					return undefined;
				} catch (error) {
					return error instanceof Error ? error : new Error(String(error));
				}
			}),
		);
	}

	async route(work: PoolWork, runId: string): Promise<string> {
		this.requireOwned(await this.begin(work), runId);
		const readiness = workflowPendingStageRouteReady(this.store, runId);
		await readiness?.completion;
		readiness?.assertCurrent();
		this.requireOwned(await this.begin(work), runId);
		return workflowPendingStageRouteCapability(this.store, runId);
	}

	async ready(work: PoolWork, runId: string, stageId: string, stageName: string, sessionId?: string): Promise<void> {
		const attempt = await this.begin(work);
		this.requireOwned(attempt, runId);
		await this.delivery(attempt, work, runId, stageId, stageName).ready(sessionId);
	}

	async deliver(
		work: PoolWork,
		runId: string,
		stageId: string,
		stageName: string,
		recipient: PendingRecipient,
		transport: PoolStageTransport,
	): Promise<void> {
		const attempt = await this.begin(work);
		this.requireOwned(attempt, runId);
		const stage = JSON.stringify([runId, stageId]);
		if (attempt.sessions.get(stage) !== recipient.sessionId)
			throw new Error(`Session ${recipient.sessionId} is not the published session of stage ${stageId}`);
		const assertSession = () => {
			if (this.attempts.get(work.id) !== attempt || attempt.fenced) throw new Error(STALE);
			if (attempt.sessions.get(stage) !== recipient.sessionId)
				throw new Error(`Stage session ${recipient.sessionId} was replaced before it acknowledged delivery`);
		};
		const previous = this.drains.get(stage) ?? Promise.resolve();
		const drain = previous
			.catch(() => undefined)
			.then(async () => {
				await this.queue.assertCurrent(this.lease, work);
				assertSession();
				await this.delivery(attempt, work, runId, stageId, stageName).deliverPending(async (from, message) => {
					await transport(from, message);
					await this.queue.assertCurrent(this.lease, work);
					assertSession();
				}, recipient);
			});
		this.drains.set(stage, drain);
		try {
			await drain;
		} finally {
			if (this.drains.get(stage) === drain) this.drains.delete(stage);
		}
	}

	async complete(work: Pick<PoolWork, "id" | "childRunId">): Promise<void> {
		const root = this.lease.runId;
		const result = (await this.queue.result(root, work.id)) as RunResult | undefined;
		await this.backend.catchUpWorkflow(root);
		if (result === undefined) return;
		const terminals = new Map<string, { status: RunSnapshot["status"]; outputs: RunSnapshot["result"] }>();
		// Terminal boundaries settle the child's own nested runs; a child without any skips the scan of every
		// root checkpoint, which made the completion of a wide fan-out quadratic in its width.
		const nested = this.store
			.runs()
			.some((run) => run.endedAt === undefined && run.id !== work.childRunId && this.owners.get(run.id) === work.id);
		for (const checkpoint of nested ? this.backend.listCheckpoints(root) : []) {
			const boundary = checkpoint.kind === "stage" ? checkpoint.topology?.boundary : undefined;
			if (checkpoint.kind !== "stage" || boundary?.event !== "terminal") continue;
			const child = parseWorkflowChildResult(checkpoint.output);
			if (child?.runId === boundary.child.runId)
				terminals.set(child.runId, { status: child.status, outputs: child.outputs });
		}
		this.store.batch(() => this.settle(work, result, terminals));
	}

	private settle(
		work: Pick<PoolWork, "id" | "childRunId">,
		result: RunResult,
		terminals: ReadonlyMap<string, { status: RunSnapshot["status"]; outputs: RunSnapshot["result"] }>,
	): void {
		for (const run of this.store.runs()) {
			if (run.endedAt !== undefined || this.owners.get(run.id) !== work.id) continue;
			if (run.id === work.childRunId) {
				const execution = run.stages.find((stage) => stage.workerExecution !== undefined)?.workerExecution;
				this.store.recordRunStart({
					...run,
					stages: result.stages.map((stage) =>
						execution === undefined ? stage : { ...stage, workerExecution: execution },
					),
					toolNodes: result.toolNodes,
				});
				this.store.recordRunEnd(run.id, result.status, result.result, result.error);
				continue;
			}
			const terminal = terminals.get(run.id);
			if (terminal !== undefined) this.store.recordRunEnd(run.id, terminal.status, terminal.outputs);
		}
	}

	fence(work: Pick<PoolWork, "id" | "generation">): void {
		const current = this.attempts.get(work.id);
		if (current !== undefined && current.generation > work.generation) return;
		const attempt = current?.generation === work.generation ? current : this.start(work, current);
		this.store.batch(() => this.release(attempt));
		attempt.fenced = true;
	}

	/** Validates a publication and returns the store update that applies it; the update re-checks ownership. */
	private async prepare(work: PoolWork, runs: readonly RunSnapshot[]): Promise<() => void> {
		const subtree = this.subtree(work, runs);
		const root = this.lease.runId;
		const owned = (known: ReadonlyMap<string, RunSnapshot>) => {
			for (const run of subtree) {
				const existing = known.get(run.id);
				const owner = this.owners.get(run.id);
				if (
					(owner !== undefined && owner !== work.id) ||
					(owner === undefined &&
						existing !== undefined &&
						(existing.parentRunId !== run.parentRunId || existing.parentStageId !== run.parentStageId))
				)
					throw outside(run.id);
			}
		};
		const before = new Map(this.store.runs().map((run) => [run.id, run]));
		owned(before);
		if (subtree.some((run) => before.get(run.id) === undefined)) await this.backend.catchUpWorkflow(root);
		await this.queue.assertCurrent(this.lease, work);
		return () => this.commit(work, subtree, owned);
	}

	private commit(
		work: PoolWork,
		subtree: readonly RunSnapshot[],
		owned: (known: ReadonlyMap<string, RunSnapshot>) => void,
	): void {
		const root = this.lease.runId;
		const known = new Map(this.store.runs().map((run) => [run.id, run]));
		owned(known);
		const attempt = this.enter(work);
		const execution = {
			worker: work.worker ?? "",
			generation: work.generation,
			renewedAt: work.renewedAt,
			expiresAt: work.expiresAt,
		};
		const published = subtree.map((run) => ({
			...run,
			rootRunId: root,
			pendingStageMessages: [
				...(known.get(run.id)?.pendingStageMessages ??
					pendingStageMessagesForDurableRun(this.backend, run.id, root)),
			],
			stages: withReconnectingStages(
				known.get(run.id),
				run,
				run.stages.map((stage) => ({ ...stage, workerExecution: execution })),
				work.generation,
			),
		}));
		const changed = published.some((run) => activity(known.get(run.id)) !== activity(run));
		for (const run of published) this.claimRun?.(run.id);
		for (const run of published) {
			attempt.runs.add(run.id);
			this.owners.set(run.id, work.id);
			for (const stage of run.stages) {
				const key = JSON.stringify([run.id, stage.id]);
				if (attempt.sessions.get(key) !== stage.sessionId) {
					attempt.deliveries.get(key)?.fail(new Error(`Stage session ${attempt.sessions.get(key)} was replaced`));
					attempt.deliveries.delete(key);
				}
				if (stage.sessionId === undefined) attempt.sessions.delete(key);
				else attempt.sessions.set(key, stage.sessionId);
			}
			// Whether a chat in this process is attached to a stage is the root's own state: a worker's
			// republished run never knows it, and dropping it would stop the chat answering prompts.
			const previous = this.store.runs().find((candidate) => candidate.id === run.id);
			for (const stage of run.stages)
				if (previous?.stages.find((candidate) => candidate.id === stage.id)?.attached === true)
					stage.attached = true;
			this.store.recordRunStart(run);
		}
		if (changed) this.store.recordRunExecutionState(root, { lastProgressAt: Date.now() });
	}

	private subtree(work: PoolWork, runs: readonly RunSnapshot[]): readonly RunSnapshot[] {
		const root = this.lease.runId;
		const byId = new Map<string, RunSnapshot>();
		for (const run of runs) {
			if (run.id === root || byId.has(run.id)) throw outside(run.id);
			byId.set(run.id, run);
		}
		if (runs.length === 0) return [];
		const rootRun = this.store.runs().find((run) => run.id === root);
		const boundary = rootRun?.stages.find((stage) => stage.id === work.boundaryId);
		if (authoritativeWorkflowChildRunId(boundary) !== work.childRunId)
			throw new Error(`Pool work boundary ${work.boundaryId} is not linked to ${work.childRunId} in the root run`);
		const ordered: RunSnapshot[] = [];
		const top = byId.get(work.childRunId);
		if (top !== undefined) {
			if (top.parentRunId !== root || top.parentStageId !== work.boundaryId) throw outside(top.id);
			const pending = [top];
			for (let run = pending.shift(); run !== undefined; run = pending.shift()) {
				if (run.rootRunId !== undefined && run.rootRunId !== root) throw outside(run.id);
				ordered.push(run);
				for (const child of runs) {
					if (child.parentRunId !== run.id) continue;
					const parentStage = run.stages.find((stage) => stage.id === child.parentStageId);
					if (authoritativeWorkflowChildRunId(parentStage) !== child.id) throw outside(child.id);
					pending.push(child);
				}
			}
		}
		const stray = runs.find((run) => !ordered.includes(run));
		if (stray !== undefined) throw outside(stray.id);
		return ordered;
	}

	private async begin(work: PoolWork): Promise<Attempt> {
		await this.queue.assertCurrent(this.lease, work);
		return this.enter(work);
	}

	private enter(work: PoolWork): Attempt {
		const current = this.attempts.get(work.id);
		if (current !== undefined && work.generation < current.generation) throw new Error(STALE);
		if (current?.generation === work.generation) {
			if (current.fenced) throw new Error(STALE);
			return current;
		}
		return this.start(work, current);
	}

	private start(work: Pick<PoolWork, "id" | "generation">, previous: Attempt | undefined): Attempt {
		if (previous !== undefined) this.release(previous);
		const attempt: Attempt = {
			generation: work.generation,
			runs: previous?.runs ?? new Set(),
			deliveries: new Map(),
			sessions: new Map(),
			fenced: false,
		};
		this.attempts.set(work.id, attempt);
		return attempt;
	}

	private release(attempt: Attempt): void {
		for (const delivery of attempt.deliveries.values()) delivery.fail(new Error(STALE));
		attempt.deliveries.clear();
		attempt.sessions.clear();
		for (const id of attempt.runs) rotateWorkflowPendingStageRouteCapability(this.store, id);
		for (const id of attempt.runs) {
			const run = this.store.runs().find((candidate) => candidate.id === id);
			if (run?.stages.some((stage) => isLive(stage)) !== true) continue;
			this.store.recordRunStart({
				...run,
				stages: run.stages.map((stage) => {
					if (!isLive(stage)) return stage;
					const { sessionId: _session, sessionFile: _file, ...rest } = stage;
					return { ...rest, attachable: false, attached: false };
				}),
			});
		}
	}

	private requireOwned(attempt: Attempt, runId: string): void {
		if (!attempt.runs.has(runId)) throw outside(runId);
	}

	private delivery(
		attempt: Attempt,
		work: PoolWork,
		runId: string,
		stageId: string,
		stageName: string,
	): PendingDelivery {
		const key = JSON.stringify([runId, stageId]);
		let delivery = attempt.deliveries.get(key);
		if (delivery === undefined) {
			const sessionId = attempt.sessions.get(key);
			delivery = createWorkflowPendingStageDelivery(this.store, runId, stageId, stageName, (action) =>
				this.queue.withCurrentAppend(
					this.lease,
					work,
					() => {
						if (this.attempts.get(work.id) !== attempt || attempt.fenced) throw new Error(STALE);
						if (attempt.sessions.get(key) !== sessionId)
							throw new Error(`Stage session ${sessionId} was replaced before it acknowledged delivery`);
					},
					action,
				),
			);
			attempt.deliveries.set(key, delivery);
		}
		return delivery;
	}
}

function outside(runId: string): Error {
	return new Error(`Pool stage publication is outside the work subtree: ${runId}`);
}

function isLive(stage: StageSnapshot): boolean {
	return (
		(stage.sessionId !== undefined || stage.sessionFile !== undefined) &&
		stage.status !== "completed" &&
		stage.status !== "failed" &&
		stage.status !== "skipped"
	);
}

/**
 * A replacement attempt replays its child from the start, so its first publications can carry
 * fewer stages than the store knows from the attempt before it. Until the replacement
 * republishes them (by id or, as replay may assign new ids, by replay key) or the run ends, the
 * stages of earlier attempts stay as last known, marked as reconnecting, instead of the run
 * briefly showing no stages (#4009).
 */
function withReconnectingStages(
	previous: RunSnapshot | undefined,
	run: RunSnapshot,
	stages: StageSnapshot[],
	generation: number,
): StageSnapshot[] {
	if (previous === undefined || run.endedAt !== undefined || isTerminalRunStatus(run.status)) return stages;
	const ids = new Set(stages.map((stage) => stage.id));
	const replayKeys = new Set(stages.flatMap((stage) => (stage.replayKey === undefined ? [] : [stage.replayKey])));
	const previousIds = new Set(previous.stages.map((stage) => stage.id));
	// Positions where this attempt asks a prompt the earlier attempt did not: an unanswered prompt the
	// earlier attempt asked there was superseded (#4022), not left behind, and is not kept.
	const newPromptPositions = new Set(
		stages.flatMap((stage, index) =>
			stage.promptFootprint !== undefined && !previousIds.has(stage.id) ? [index] : [],
		),
	);
	const reconnecting = previous.stages.filter(
		(stage, index) =>
			!ids.has(stage.id) &&
			(stage.replayKey === undefined || !replayKeys.has(stage.replayKey)) &&
			stage.workerExecution !== undefined &&
			stage.workerExecution.generation < generation &&
			!(stage.promptFootprint !== undefined && stage.endedAt === undefined && newPromptPositions.has(index)),
	);
	if (reconnecting.length === 0) return stages;
	// A stage republished under a new id with the same replay key keeps its edges: retained
	// stages that hung from its old id hang from the new one.
	const replacementIdByReplayKey = new Map(
		stages.flatMap((stage) => (stage.replayKey === undefined ? [] : [[stage.replayKey, stage.id] as const])),
	);
	const renamed = new Map<string, string>();
	for (const stage of previous.stages) {
		const replacement = stage.replayKey === undefined ? undefined : replacementIdByReplayKey.get(stage.replayKey);
		if (replacement !== undefined && replacement !== stage.id && !ids.has(stage.id))
			renamed.set(stage.id, replacement);
	}
	return [
		...stages,
		...reconnecting.map((stage) => {
			const parentIds = stage.parentIds.some((id) => renamed.has(id))
				? stage.parentIds.map((id) => renamed.get(id) ?? id)
				: stage.parentIds;
			if (stage.workerExecution?.reconnecting === true && parentIds === stage.parentIds) return stage;
			return { ...stage, parentIds, workerExecution: { ...stage.workerExecution!, reconnecting: true as const } };
		}),
	];
}

function activity(run: RunSnapshot | undefined): string | undefined {
	if (run === undefined) return undefined;
	const { pendingStageMessages: _queue, ...rest } = run;
	const stages = run.stages.map((stage) => {
		const { workerExecution: _worker, ...others } = stage;
		return others;
	});
	return JSON.stringify({ ...rest, stages });
}
