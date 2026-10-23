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
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { authoritativeWorkflowChildRunId } from "../shared/workflow-run-ownership.js";

type PendingDelivery = ReturnType<typeof createWorkflowPendingStageDelivery>;
type PendingDeliver = Parameters<PendingDelivery["deliverPending"]>[0];
type PendingRecipient = NonNullable<Parameters<PendingDelivery["deliverPending"]>[1]>;

export type PoolStageTransport = (...args: Parameters<PendingDeliver>) => Promise<void>;

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

	constructor(
		private readonly backend: JournalDurableBackend,
		private readonly store: Store,
		private readonly queue: SqlPoolQueue,
		private readonly lease: Lease,
	) {}

	publish(work: PoolWork, runs: readonly RunSnapshot[]): Promise<void> {
		const previous = this.publications.get(work.id) ?? Promise.resolve();
		const publication = previous.catch(() => undefined).then(() => this.apply(work, runs));
		const settled = publication.catch(() => undefined);
		this.publications.set(work.id, settled);
		void settled.then(() => {
			if (this.publications.get(work.id) === settled) this.publications.delete(work.id);
		});
		return publication;
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
		await this.delivery(attempt, runId, stageId, stageName).ready(sessionId);
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
		await this.delivery(attempt, runId, stageId, stageName).deliverPending(async (from, message) => {
			await transport(from, message);
			await this.queue.assertCurrent(this.lease, work);
			if (this.attempts.get(work.id) !== attempt || attempt.fenced) throw new Error(STALE);
			if (attempt.sessions.get(stage) !== recipient.sessionId)
				throw new Error(`Stage session ${recipient.sessionId} was replaced before it acknowledged delivery`);
		}, recipient);
	}

	async complete(work: Pick<PoolWork, "id" | "childRunId">): Promise<void> {
		const root = this.lease.runId;
		const result = (await this.queue.result(root, work.id)) as RunResult | undefined;
		if (result === undefined) return;
		await this.backend.hydrateWorkflow(root);
		const terminals = new Map<string, { status: RunSnapshot["status"]; outputs: RunSnapshot["result"] }>();
		for (const checkpoint of this.backend.listCheckpoints(root)) {
			const boundary = checkpoint.kind === "stage" ? checkpoint.topology?.boundary : undefined;
			if (checkpoint.kind !== "stage" || boundary?.event !== "terminal") continue;
			const child = parseWorkflowChildResult(checkpoint.output);
			if (child?.runId === boundary.child.runId)
				terminals.set(child.runId, { status: child.status, outputs: child.outputs });
		}
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
		this.release(attempt);
		attempt.fenced = true;
	}

	private async apply(work: PoolWork, runs: readonly RunSnapshot[]): Promise<void> {
		const subtree = this.subtree(work, runs);
		const root = this.lease.runId;
		const known = new Map(this.store.runs().map((run) => [run.id, run]));
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
		if (subtree.some((run) => known.get(run.id) === undefined)) await this.backend.hydrateWorkflow(root);
		await this.queue.assertCurrent(this.lease, work);
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
				...(this.store.runs().find((current) => current.id === run.id)?.pendingStageMessages ??
					pendingStageMessagesForDurableRun(this.backend, run.id, root)),
			],
			stages: run.stages.map((stage) => ({ ...stage, workerExecution: execution })),
		}));
		const changed = published.some((run) => activity(known.get(run.id)) !== activity(run));
		for (const run of published) {
			attempt.runs.add(run.id);
			this.owners.set(run.id, work.id);
			for (const stage of run.stages) {
				const key = JSON.stringify([run.id, stage.id]);
				if (stage.sessionId === undefined) attempt.sessions.delete(key);
				else attempt.sessions.set(key, stage.sessionId);
			}
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

	private delivery(attempt: Attempt, runId: string, stageId: string, stageName: string): PendingDelivery {
		const key = JSON.stringify([runId, stageId]);
		let delivery = attempt.deliveries.get(key);
		if (delivery === undefined) {
			delivery = createWorkflowPendingStageDelivery(this.store, runId, stageId, stageName);
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

function activity(run: RunSnapshot | undefined): string | undefined {
	if (run === undefined) return undefined;
	const { pendingStageMessages: _queue, ...rest } = run;
	const stages = run.stages.map((stage) => {
		const { workerExecution: _worker, ...others } = stage;
		return others;
	});
	return JSON.stringify({ ...rest, stages });
}
