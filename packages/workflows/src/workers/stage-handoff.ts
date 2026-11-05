import { setImmediate } from "node:timers";
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
import { isTerminalRunStatus, isTerminalStageStatus } from "../shared/store-internal.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import { authoritativeWorkflowChildRunId } from "../shared/workflow-run-ownership.js";
import { isRunChanges, type PublishedRun, type RunChanges, type RunHeader } from "./run-changes.js";

type PendingDelivery = ReturnType<typeof createWorkflowPendingStageDelivery>;
type PendingDeliver = Parameters<PendingDelivery["deliverPending"]>[0];
type PendingRecipient = NonNullable<Parameters<PendingDelivery["deliverPending"]>[1]>;

export type PoolStageTransport = (...args: Parameters<PendingDeliver>) => Promise<void>;

/** The work-lease checks the handoff needs; a coordinator-driven pool answers them from its own attempt state. */
export type PoolStageQueue = Pick<SqlPoolQueue, "assertCurrent" | "withCurrentAppend" | "result">;

export interface PoolStagePublication {
	readonly work: PoolWork;
	readonly runs: readonly PublishedRun[];
}

/**
 * Stage and tool-node snapshots a batch writes to the store before it lets the event loop turn (#4317): a large
 * batch takes several turns, so the root's lease renewals and other timers run between them.
 */
export const PUBLICATION_TURN_WRITES = 1_000;

/** What the handoff wrote of one run, to apply the run's next changes without reading its other stages. */
interface RunView {
	readonly stages: readonly StageSnapshot[];
	readonly stagePositions: Map<string, number>;
	stageCount: number;
	readonly toolNodes: readonly ToolNodeSnapshot[];
	readonly toolPositions: Map<string, number>;
	toolCount: number;
	/** Stages the attempt has not ended, which each lease renewal relabels. */
	readonly open: Set<string>;
	/** Stages of earlier attempts the replacement has not republished yet (#4009). */
	readonly reconnecting: number;
}

/** A published run as validation sees it: its parent links, the store's for a run published as changes. */
interface Member {
	readonly published: PublishedRun;
	readonly id: string;
	readonly parentRunId: string | undefined;
	readonly parentStageId: string | undefined;
	readonly rootRunId: string | undefined;
}

interface Attempt {
	readonly generation: number;
	readonly runs: Set<string>;
	readonly deliveries: Map<string, PendingDelivery>;
	readonly sessions: Map<string, string>;
	readonly views: Map<string, RunView>;
	/** The run each published run hangs from a stage of, by that run and stage, as the last full publication showed. */
	readonly hosts: Map<string, string>;
	/** Runs with stages the attempt has not ended: a renewal relabels them whether a publication names them or not. */
	readonly openRuns: Set<string>;
	fenced: boolean;
}

type Execution = NonNullable<StageSnapshot["workerExecution"]>;

const STALE = "Stale work lease";

export class PoolStageHandoff {
	private readonly attempts = new Map<string, Attempt>();
	private readonly owners = new Map<string, string>();
	private readonly publications = new Map<string, Promise<void>>();
	private readonly drains = new Map<string, Promise<void>>();
	/** Where each work's boundary stage stood in the root run's stages when last found. */
	private readonly boundaryPositions = new Map<string, number>();
	/** The attempt of each work that had a publication refused, and the reason (#4317). */
	private readonly refusals = new Map<string, { readonly generation: number; readonly error: Error }>();
	/** Failed stage drains of this root, summarized on its run by {@link recordDeliveryIssue}. */
	private deliveryIssues = 0;

	constructor(
		private readonly backend: JournalDurableBackend,
		private readonly store: Store,
		private readonly queue: PoolStageQueue,
		private readonly lease: Lease,
		/** Called for every accepted run before it reaches the store, e.g. to route it elsewhere. */
		private readonly claimRun?: (runId: string) => void,
	) {}

	publish(work: PoolWork, runs: readonly PublishedRun[]): Promise<void> {
		const previous = this.publications.get(work.id) ?? Promise.resolve();
		const publication = previous
			.catch(() => undefined)
			.then(async () => {
				try {
					const commit = await this.prepare(work, runs);
					this.store.batch(commit);
					this.rebase(work, runs);
				} catch (error) {
					this.refuse(work, error as Error);
					throw error;
				}
			});
		const settled = publication.catch(() => undefined);
		this.publications.set(work.id, settled);
		void settled.then(() => {
			if (this.publications.get(work.id) === settled) this.publications.delete(work.id);
		});
		return publication;
	}

	/**
	 * Publish the latest activity of several attempts, in order, with one store invalidation per turn of the event
	 * loop: the batch yields once a turn wrote {@link PUBLICATION_TURN_WRITES} snapshots, and stops with `signal`'s
	 * reason before any turn that starts once it was aborted, the first included. Returns each publication's
	 * rejection, or undefined for an accepted one.
	 */
	async publishBatch(
		publications: readonly PoolStagePublication[],
		signal?: AbortSignal,
	): Promise<(Error | undefined)[]> {
		const prepared: ((() => number) | Error)[] = [];
		for (const { work, runs } of publications)
			prepared.push(await this.prepare(work, runs).catch((error: Error) => error));
		const outcomes: (Error | undefined)[] = [];
		while (outcomes.length < prepared.length) {
			if (outcomes.length > 0) await nextTurn();
			signal?.throwIfAborted();
			this.store.batch(() => {
				for (let written = 0; written < PUBLICATION_TURN_WRITES && outcomes.length < prepared.length; ) {
					const { work, runs } = publications[outcomes.length]!;
					const commit = this.refusal(work, runs) ?? prepared[outcomes.length]!;
					try {
						if (commit instanceof Error) throw commit;
						written += 1 + commit();
						this.rebase(work, runs);
						outcomes.push(undefined);
					} catch (error) {
						const refused = error instanceof Error ? error : new Error(String(error));
						this.refuse(work, refused);
						outcomes.push(refused);
					}
				}
			});
		}
		return outcomes;
	}

	/**
	 * Records that a publication of this attempt was refused, and why. Changes apply to what the attempt published
	 * before them, so the attempt's later changes are refused with this first reason until it publishes in full (#4317).
	 */
	refuse(work: Pick<PoolWork, "id" | "generation">, error: Error): void {
		const known = this.refusals.get(work.id);
		if (known === undefined || known.generation < work.generation)
			this.refusals.set(work.id, { generation: work.generation, error });
	}

	/** An accepted publication in full is what the attempt's next changes apply to, refused or not before it. */
	private rebase(work: Pick<PoolWork, "id" | "generation">, runs: readonly PublishedRun[]): void {
		if (this.refusals.get(work.id)?.generation === work.generation && !runs.some(isRunChanges))
			this.refusals.delete(work.id);
	}

	/** Why a publication carrying changes is refused: an earlier publication of its attempt was. */
	private refusal(work: Pick<PoolWork, "id" | "generation">, runs: readonly PublishedRun[]): Error | undefined {
		const known = this.refusals.get(work.id);
		return known?.generation === work.generation && runs.some(isRunChanges) ? known.error : undefined;
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
		} catch (error) {
			// An attempt that was fenced, or a session that was replaced, ends its drain by design.
			const current = this.attempts.get(work.id) === attempt && !attempt.fenced;
			if (current && attempt.sessions.get(stage) === recipient.sessionId && (error as Error).message !== STALE)
				this.recordDeliveryIssue(error as Error);
			throw error;
		} finally {
			if (this.drains.get(stage) === drain) this.drains.delete(stage);
		}
	}

	/**
	 * A pooled stage starts without waiting for the root's drain, so the root reports a failed drain itself: as one
	 * summary on the root run, however many stages it reaches, never as a message per stage.
	 */
	private recordDeliveryIssue(error: Error): void {
		this.deliveryIssues++;
		const drains = this.deliveryIssues === 1 ? "1 stage drain" : `${this.deliveryIssues} stage drains`;
		this.store.recordRunExecutionState(this.lease.runId, {
			intercomDeliveryIssue: `${drains} on local workers failed; undelivered messages stay queued and arrive live or on the stage's next drain (last: ${error.message})`,
		});
	}

	async complete(work: Pick<PoolWork, "id" | "childRunId">): Promise<void> {
		const root = this.lease.runId;
		const result = (await this.queue.result(root, work.id)) as RunResult | undefined;
		await this.backend.catchUpWorkflow(root);
		if (result === undefined) return;
		const terminals = new Map<string, { status: RunSnapshot["status"]; outputs: RunSnapshot["result"] }>();
		// Terminal boundaries settle the child's own nested runs; a child without any skips the scan of every
		// root checkpoint, which made the completion of a wide fan-out quadratic in its width.
		const nested = this.ownedRunIds(work).some((id) => id !== work.childRunId && this.unended(id) !== undefined);
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
		for (const id of this.ownedRunIds(work)) {
			const run = this.unended(id);
			if (run === undefined) continue;
			if (run.id === work.childRunId) {
				// Each stage keeps the worker lease it showed; a stage only the result has takes the attempt's.
				const executions = new Map(run.stages.map((stage) => [stage.id, stage.workerExecution]));
				const attempt = run.stages
					.flatMap((stage) => (stage.workerExecution === undefined ? [] : [stage.workerExecution]))
					.reduce<StageSnapshot["workerExecution"]>(
						(latest, execution) =>
							latest === undefined || execution.renewedAt > latest.renewedAt ? execution : latest,
						undefined,
					);
				this.store.recordRunStart({
					...run,
					stages: result.stages.map((stage) => {
						const execution = executions.get(stage.id) ?? attempt;
						return execution === undefined ? stage : { ...stage, workerExecution: execution };
					}),
					toolNodes: result.toolNodes,
				});
				this.store.recordRunEnd(run.id, result.status, result.result, result.error);
				continue;
			}
			const terminal = terminals.get(run.id);
			if (terminal !== undefined) this.store.recordRunEnd(run.id, terminal.status, terminal.outputs);
		}
	}

	/**
	 * The runs this work published and the store still holds, in store order: a completion costs what the work
	 * owns, not what the store holds, which in a long-lived host is thousands of finished runs (#4190).
	 */
	private ownedRunIds(work: Pick<PoolWork, "id">): string[] {
		const held: { readonly id: string; readonly position: number }[] = [];
		for (const id of this.attempts.get(work.id)?.runs ?? []) {
			const position = this.store.runPosition(id);
			if (position !== undefined) held.push({ id, position });
		}
		return held.sort((left, right) => left.position - right.position).map(({ id }) => id);
	}

	private unended(runId: string): RunSnapshot | undefined {
		const run = this.store.run(runId);
		return run?.endedAt === undefined ? run : undefined;
	}

	fence(work: Pick<PoolWork, "id" | "generation">): void {
		const current = this.attempts.get(work.id);
		if (current !== undefined && current.generation > work.generation) return;
		const attempt = current?.generation === work.generation ? current : this.start(work, current);
		this.store.batch(() => this.release(attempt));
		attempt.fenced = true;
	}

	/** Validates a publication and returns the store update that applies it; the update re-checks ownership. */
	private async prepare(work: PoolWork, runs: readonly PublishedRun[]): Promise<() => number> {
		const refused = this.refusal(work, runs);
		if (refused !== undefined) throw refused;
		const subtree = this.subtree(work, runs);
		const root = this.lease.runId;
		const owned = (known: ReadonlyMap<string, RunSnapshot>) => {
			for (const run of subtree) {
				const existing = known.get(run.id);
				const owner = this.owners.get(run.id);
				if (
					(owner !== undefined && owner !== work.id) ||
					(isRunChanges(run.published) && (existing === undefined || !this.holds(work, run.id))) ||
					(owner === undefined &&
						existing !== undefined &&
						(existing.parentRunId !== run.parentRunId || existing.parentStageId !== run.parentStageId))
				)
					throw outside(run.id);
			}
		};
		const before = this.known(subtree);
		owned(before);
		if (subtree.some((run) => before.get(run.id) === undefined)) await this.backend.catchUpWorkflow(root);
		await this.queue.assertCurrent(this.lease, work);
		return () => this.commit(work, subtree, owned);
	}

	/** Whether the work's current attempt published the run in full, which its changes apply to. */
	private holds(work: Pick<PoolWork, "id" | "generation">, runId: string): boolean {
		const attempt = this.attempts.get(work.id);
		return attempt?.generation === work.generation && attempt.views.has(runId);
	}

	/**
	 * The store's current copy of each published run, looked up by id: a publication costs what it publishes, not
	 * what the store holds, which in a long-lived host is thousands of finished runs (#4182).
	 */
	private known(subtree: readonly Member[]): ReadonlyMap<string, RunSnapshot> {
		const known = new Map<string, RunSnapshot>();
		for (const run of subtree) {
			const existing = this.store.run(run.id);
			if (existing !== undefined) known.set(run.id, existing);
		}
		return known;
	}

	/** Applies a validated publication and returns how many stage and tool-node snapshots it wrote. */
	private commit(
		work: PoolWork,
		subtree: readonly Member[],
		owned: (known: ReadonlyMap<string, RunSnapshot>) => void,
	): number {
		const known = this.known(subtree);
		owned(known);
		const attempt = this.enter(work);
		const execution: Execution = {
			worker: work.worker ?? "",
			generation: work.generation,
			renewedAt: work.renewedAt,
			expiresAt: work.expiresAt,
		};
		for (const run of subtree) this.claimRun?.(run.id);
		const full = !subtree.some((run) => isRunChanges(run.published));
		if (full) hold(attempt, subtree);
		let changed = false;
		let written = 0;
		for (const { published } of subtree) {
			attempt.runs.add(published.id);
			this.owners.set(published.id, work.id);
			const stored = known.get(published.id);
			const outcome = isRunChanges(published)
				? this.change(attempt, stored!, published, execution)
				: this.replace(attempt, stored, published, execution);
			changed ||= outcome.changed;
			written += outcome.written;
		}
		if (!full) {
			// Runs a publication of changes leaves out did not change, but their open stages show the attempt's lease.
			const named = new Set(subtree.map((run) => run.id));
			for (const id of [...attempt.openRuns]) if (!named.has(id)) written += this.relabel(attempt, id, execution);
		}
		if (changed) this.store.recordRunExecutionState(this.lease.runId, { lastProgressAt: Date.now() });
		return written;
	}

	/** Replaces the store's copy of a run published in full. */
	private replace(
		attempt: Attempt,
		known: RunSnapshot | undefined,
		run: RunSnapshot,
		execution: Execution,
	): { readonly changed: boolean; readonly written: number } {
		const root = this.lease.runId;
		const previous = known === undefined ? new Map<string, StageSnapshot>() : byId(known.stages);
		const published: RunSnapshot = {
			...run,
			rootRunId: root,
			pendingStageMessages: [
				...(known?.pendingStageMessages ?? pendingStageMessagesForDurableRun(this.backend, run.id, root)),
			],
			stages: withReconnectingStages(
				known,
				run,
				run.stages.map((stage) => ({
					...stage,
					workerExecution: endedUnder(previous.get(stage.id), stage, execution),
				})),
				attempt.generation,
			),
		};
		const changed = activity(known) !== activity(published);
		for (const stage of published.stages) this.trackSession(attempt, run.id, stage);
		// Whether a chat in this process is attached to a stage is the root's own state: a worker's
		// republished run never knows it, and dropping it would stop the chat answering prompts.
		for (const stage of published.stages) if (previous.get(stage.id)?.attached === true) stage.attached = true;
		this.store.recordRunStart(published);
		open(attempt, run.id, viewOf(published));
		return { changed, written: published.stages.length + published.toolNodes.length };
	}

	/** Relabels the open stages of a run the attempt holds with its current lease, as a publication without changes. */
	private relabel(attempt: Attempt, runId: string, execution: Execution): number {
		const stored = this.store.run(runId);
		if (stored === undefined) {
			attempt.openRuns.delete(runId);
			return 0;
		}
		return this.change(attempt, stored, { kind: "changes", id: runId, stages: [], toolNodes: [] }, execution).written;
	}

	/**
	 * Applies a run's changes to the store's copy in place: only the changed stages, and the open stages a lease
	 * renewal relabels, are written. A run still showing stages of an earlier attempt is replaced instead.
	 */
	private change(
		attempt: Attempt,
		stored: RunSnapshot,
		changes: RunChanges,
		execution: Execution,
	): { readonly changed: boolean; readonly written: number } {
		const view = this.view(attempt, stored, changes);
		if (view.reconnecting > 0) return this.replace(attempt, stored, workerRun(stored, changes), execution);
		const stageIds: string[] = [];
		const toolNodeIds: string[] = [];
		this.store.editRun(stored.id, (run) => {
			if (changes.header !== undefined) replaceHeader(run, changes.header, this.lease.runId);
			for (const stage of changes.stages) {
				const position = view.stagePositions.get(stage.id) ?? run.stages.length;
				const previous = run.stages[position];
				const published: StageSnapshot = {
					...stage,
					workerExecution: endedUnder(previous, stage, execution),
				};
				if (previous?.attached === true) published.attached = true;
				this.trackSession(attempt, run.id, published);
				view.stagePositions.set(stage.id, position);
				run.stages[position] = published;
				if (isTerminalStageStatus(published.status)) view.open.delete(stage.id);
				else view.open.add(stage.id);
				stageIds.push(stage.id);
			}
			const changed = new Set(stageIds);
			for (const id of view.open) {
				const position = view.stagePositions.get(id)!;
				const stage = run.stages[position]!;
				if (changed.has(id) || sameExecution(stage.workerExecution, execution)) continue;
				run.stages[position] = { ...stage, workerExecution: execution };
				stageIds.push(id);
			}
			for (const node of changes.toolNodes) {
				const position = view.toolPositions.get(node.id) ?? run.toolNodes.length;
				view.toolPositions.set(node.id, position);
				run.toolNodes[position] = node;
				toolNodeIds.push(node.id);
			}
			return { run: changes.header !== undefined, stageIds, toolNodeIds };
		});
		view.stageCount = stored.stages.length;
		view.toolCount = stored.toolNodes.length;
		open(attempt, stored.id, view);
		return {
			changed: changes.header !== undefined || changes.stages.length > 0 || changes.toolNodes.length > 0,
			written: stageIds.length + toolNodeIds.length,
		};
	}

	/**
	 * The view of a stored run, rebuilt when the store replaced or grew its stages or tool nodes, or moved one the
	 * changes or a lease renewal write, since the handoff last wrote it.
	 */
	private view(attempt: Attempt, run: RunSnapshot, changes: RunChanges): RunView {
		const known = attempt.views.get(run.id);
		const placed = (
			positions: ReadonlyMap<string, number>,
			nodes: readonly { readonly id: string }[],
			id: string,
		) => {
			const position = positions.get(id);
			return position === undefined || nodes[position]!.id === id;
		};
		if (
			known !== undefined &&
			known.stages === run.stages &&
			known.stageCount === run.stages.length &&
			known.toolNodes === run.toolNodes &&
			known.toolCount === run.toolNodes.length &&
			changes.stages.every((stage) => placed(known.stagePositions, run.stages, stage.id)) &&
			[...known.open].every((id) => placed(known.stagePositions, run.stages, id)) &&
			changes.toolNodes.every((node) => placed(known.toolPositions, run.toolNodes, node.id))
		)
			return known;
		return open(attempt, run.id, viewOf(run));
	}

	private trackSession(attempt: Attempt, runId: string, stage: StageSnapshot): void {
		const key = JSON.stringify([runId, stage.id]);
		if (attempt.sessions.get(key) !== stage.sessionId) {
			attempt.deliveries.get(key)?.fail(new Error(`Stage session ${attempt.sessions.get(key)} was replaced`));
			attempt.deliveries.delete(key);
		}
		if (stage.sessionId === undefined) attempt.sessions.delete(key);
		else attempt.sessions.set(key, stage.sessionId);
	}

	private subtree(work: PoolWork, runs: readonly PublishedRun[]): readonly Member[] {
		const root = this.lease.runId;
		const ids = new Set<string>();
		for (const run of runs) {
			if (run.id === root || ids.has(run.id)) throw outside(run.id);
			ids.add(run.id);
		}
		if (runs.length === 0) return [];
		const boundary = this.boundary(work.boundaryId);
		if (authoritativeWorkflowChildRunId(boundary) !== work.childRunId)
			throw new Error(`Pool work boundary ${work.boundaryId} is not linked to ${work.childRunId} in the root run`);
		return runs.some(isRunChanges) ? this.changed(work, runs) : this.tree(work, runs as readonly RunSnapshot[]);
	}

	/** The runs of a full publication in the order they hang from the work's boundary, each reached once. */
	private tree(work: PoolWork, runs: readonly RunSnapshot[]): readonly Member[] {
		const root = this.lease.runId;
		const children = new Map<string | undefined, RunSnapshot[]>();
		for (const run of runs) {
			const siblings = children.get(run.parentRunId);
			if (siblings === undefined) children.set(run.parentRunId, [run]);
			else siblings.push(run);
		}
		const ordered = runs.filter((run) => run.id === work.childRunId);
		for (const top of ordered)
			if (top.parentRunId !== root || top.parentStageId !== work.boundaryId) throw outside(top.id);
		for (let index = 0; index < ordered.length; index++) {
			const run = ordered[index]!;
			if (run.rootRunId !== undefined && run.rootRunId !== root) throw outside(run.id);
			let stages: ReadonlyMap<string | undefined, StageSnapshot> | undefined;
			for (const child of children.get(run.id) ?? []) {
				stages ??= byId(run.stages);
				if (authoritativeWorkflowChildRunId(stages.get(child.parentStageId)) !== child.id) throw outside(child.id);
				ordered.push(child);
			}
		}
		const reached = new Set(ordered);
		const stray = runs.find((run) => !reached.has(run));
		if (stray !== undefined) throw outside(stray.id);
		return ordered.map((run) => this.member(run));
	}

	/**
	 * The runs of a publication of changes, each checked on its own: its links cannot move and every run in it was
	 * published in full by the attempt, so only a changed stage that other runs hang from can break the tree.
	 */
	private changed(work: PoolWork, runs: readonly PublishedRun[]): readonly Member[] {
		const root = this.lease.runId;
		const hosts = this.attempts.get(work.id)?.hosts;
		return runs.map((run) => {
			if (!isRunChanges(run)) throw outside(run.id);
			const member = this.member(run);
			if (member.rootRunId !== undefined && member.rootRunId !== root) throw outside(run.id);
			for (const stage of run.stages) {
				const hosted = hosts?.get(hostKey(run.id, stage.id));
				if (hosted !== undefined && authoritativeWorkflowChildRunId(stage) !== hosted) throw outside(hosted);
			}
			return member;
		});
	}

	/**
	 * A published run as validation sees it. A run published as changes keeps the parent links of the store's copy,
	 * which a change to its own fields may not move.
	 */
	private member(published: PublishedRun): Member {
		if (!isRunChanges(published))
			return {
				published,
				id: published.id,
				parentRunId: published.parentRunId,
				parentStageId: published.parentStageId,
				rootRunId: published.rootRunId,
			};
		const stored = this.store.run(published.id);
		const header = published.header;
		if (
			stored === undefined ||
			(header !== undefined &&
				(header.parentRunId !== stored.parentRunId || header.parentStageId !== stored.parentStageId))
		)
			throw outside(published.id);
		return {
			published,
			id: published.id,
			parentRunId: stored.parentRunId,
			parentStageId: stored.parentStageId,
			rootRunId: header === undefined ? stored.rootRunId : header.rootRunId,
		};
	}

	/** The root's boundary stage of a work, found by its last known position before any scan of the root's stages. */
	private boundary(boundaryId: string): StageSnapshot | undefined {
		const stages = this.store.run(this.lease.runId)?.stages ?? [];
		const known = stages[this.boundaryPositions.get(boundaryId) ?? -1];
		if (known?.id === boundaryId) return known;
		const position = stages.findIndex((stage) => stage.id === boundaryId);
		this.boundaryPositions.set(boundaryId, position);
		return stages[position];
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
			views: new Map(),
			hosts: new Map(),
			openRuns: new Set(),
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
			const run = this.store.run(id);
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
			delivery = createWorkflowPendingStageDelivery(
				this.store,
				runId,
				stageId,
				stageName,
				(action) =>
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
				// A drain's transport is the worker's delivery request, which `deliver` answers: it must stay open for as
				// long as the drain runs, however slowly a starved worker acknowledges. The stage does not wait for it.
				{ holdUntilDrained: true },
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
 * The worker lease a published stage shows: the attempt's current one, except for a stage that had already ended
 * under this attempt, which keeps the lease it ended under. The attempt goes on renewing for its other stages, and a
 * renewal after a stage ended must not read as that stage still holding its worker.
 */
function endedUnder(previous: StageSnapshot | undefined, stage: StageSnapshot, execution: Execution): Execution {
	if (!isTerminalStageStatus(stage.status)) return execution;
	return previous !== undefined &&
		isTerminalStageStatus(previous.status) &&
		previous.workerExecution?.generation === execution.generation &&
		previous.workerExecution.worker === execution.worker
		? previous.workerExecution
		: execution;
}

function sameExecution(shown: StageSnapshot["workerExecution"], execution: Execution): boolean {
	return shown?.renewedAt === execution.renewedAt && shown.expiresAt === execution.expiresAt;
}

/** Each node by id, the first one where several share an id. */
function byId<T extends { readonly id: string }>(nodes: readonly T[]): ReadonlyMap<string | undefined, T> {
	const found = new Map<string | undefined, T>();
	for (const node of nodes) if (!found.has(node.id)) found.set(node.id, node);
	return found;
}

function hostKey(runId: string | undefined, stageId: string | undefined): string {
	return JSON.stringify([runId, stageId]);
}

/**
 * A full publication is the attempt's runs from now on: it records their views anew, and each run's link to the stage
 * hosting it is its. The work's own run hangs from the root's boundary, which no publication of changes can name.
 */
function hold(attempt: Attempt, subtree: readonly Member[]): void {
	attempt.views.clear();
	attempt.openRuns.clear();
	attempt.hosts.clear();
	for (const run of subtree) attempt.hosts.set(hostKey(run.parentRunId, run.parentStageId), run.id);
}

/** Records a run's view, and whether the run still has open stages a renewal relabels. */
function open(attempt: Attempt, runId: string, view: RunView): RunView {
	attempt.views.set(runId, view);
	if (view.open.size > 0) attempt.openRuns.add(runId);
	else attempt.openRuns.delete(runId);
	return view;
}

function positionsOf(nodes: readonly { readonly id: string }[]): Map<string, number> {
	const positions = new Map<string, number>();
	nodes.forEach((node, position) => {
		if (!positions.has(node.id)) positions.set(node.id, position);
	});
	return positions;
}

function viewOf(run: RunSnapshot): RunView {
	const open = new Set<string>();
	let reconnecting = 0;
	for (const stage of run.stages) {
		if (stage.workerExecution?.reconnecting === true) reconnecting++;
		else if (!isTerminalStageStatus(stage.status)) open.add(stage.id);
	}
	return {
		stages: run.stages,
		stagePositions: positionsOf(run.stages),
		stageCount: run.stages.length,
		toolNodes: run.toolNodes,
		toolPositions: positionsOf(run.toolNodes),
		toolCount: run.toolNodes.length,
		open,
		reconnecting,
	};
}

/** The run as its worker holds it: the store's copy with the changes applied and no stage of an earlier attempt. */
function workerRun(stored: RunSnapshot, changes: RunChanges): RunSnapshot {
	const { stages, toolNodes, pendingStageMessages: _queue, ...header } = stored;
	return {
		...(changes.header ?? header),
		stages: upserted(
			stages.filter((stage) => stage.workerExecution?.reconnecting !== true),
			changes.stages,
		),
		toolNodes: upserted(toolNodes, changes.toolNodes),
	};
}

/** `nodes` with each changed node in the place of the node with its id, or after them all when none has it. */
function upserted<T extends { readonly id: string }>(nodes: readonly T[], changed: readonly T[]): T[] {
	const next = [...nodes];
	const positions = positionsOf(next);
	for (const node of changed) next[positions.get(node.id) ?? next.length] = node;
	return next;
}

/** Replaces a run's own fields with a worker's, keeping its stages, tool nodes and the root's queue of messages. */
function replaceHeader(run: RunSnapshot, header: RunHeader, root: string): void {
	const fields = run as Partial<RunSnapshot>;
	for (const key of Object.keys(run) as (keyof RunSnapshot)[])
		if (!(key in header) && key !== "stages" && key !== "toolNodes" && key !== "pendingStageMessages")
			delete fields[key];
	Object.assign(run, header, { rootRunId: root });
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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
