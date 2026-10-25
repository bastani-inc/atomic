import type { DurableWorkflowBackend, PendingStageReceiptCursor } from "../durable/backend.js";
import { availableRunDurableBackend, durableBackendForRun } from "../durable/run-owner-backend.js";
import {
	createStagePathPatternIndex,
	stageMatchesPathPattern,
	type WorkflowBoundaryHop,
} from "./pending-stage-status.js";
import { type BoundedStickyDeliveryStates, boundStickyDeliveryStates } from "./sticky-delivery-state-bound.js";
import type { StickyStageDeliveryStatus } from "./sticky-stage-delivery-status.js";
import { isTerminalRunStatus } from "./store-internal.js";
import type { PendingStageMessage, PendingStageMessageDelivery, RunSnapshot, StageSnapshot } from "./store-types.js";
import { authoritativeWorkflowChildRunId, reciprocalWorkflowRootRunId } from "./workflow-run-ownership.js";
import { matchStagePathSegments, splitStagePathSegments } from "./workflow-stage-path-matching.js";
import { formatWorkflowStageTarget, parseWorkflowStageTarget } from "./workflow-stage-target.js";

/** One possible-future route row of a root run's announcement (D7). */
export interface PossibleStageRow {
	readonly target: string;
	readonly queuedCount: number;
	readonly deliveryOnly?: true;
	/**
	 * Bounded delivery states with their counts and the number omitted; see {@link boundStickyDeliveryStates}.
	 * Each state leaves out its target, which is the row's.
	 */
	readonly deliveryStates?: readonly PossibleStageDeliveryState[];
	readonly deliveryStateCounts?: Readonly<Record<string, number>>;
	readonly omittedDeliveryStates?: number;
}

export type PossibleStageDeliveryState = Omit<StickyStageDeliveryStatus, "target">;

/** One row's delivery states bounded, each without the target the row already names. */
export function boundPossibleStageDeliveryStates(
	states: readonly StickyStageDeliveryStatus[],
): BoundedStickyDeliveryStates<PossibleStageDeliveryState> {
	const bounded = boundStickyDeliveryStates(states);
	return {
		...bounded,
		deliveryStates: bounded.deliveryStates.map(({ target: _target, ...state }) => state),
	};
}

/**
 * Reciprocal root and boundary hops of every run, rebuilt only when a run's lineage changes. A run's
 * lineage is its identity, parent link and declared root, plus its boundary stage's name and authoritative
 * child; run order and every other field leave it unchanged.
 */
export class WorkflowTopologyIndex {
	private lineage: LineageValue[] = [];
	private runById = new Map<string, RunSnapshot>();
	private readonly roots = new Map<string, string | undefined>();
	private readonly hops = new Map<string, readonly WorkflowBoundaryHop[] | undefined>();

	refresh(runs: readonly RunSnapshot[]): void {
		const runById = new Map(runs.map((run) => [run.id, run]));
		const lineage: LineageValue[] = [];
		for (const run of runs) {
			lineage.push(run.id, run.rootRunId, run.parentRunId, run.parentStageId);
			if (run.parentRunId === undefined) continue;
			const parent = runById.get(run.parentRunId);
			const boundary = parent?.stages.find((stage) => stage.id === run.parentStageId);
			lineage.push(parent !== undefined, boundary?.name, authoritativeWorkflowChildRunId(boundary));
		}
		if (sameValues(lineage, this.lineage)) return;
		this.lineage = lineage;
		this.runById = runById;
		this.roots.clear();
		this.hops.clear();
	}

	rootOf(runId: string): string | undefined {
		if (this.roots.has(runId)) return this.roots.get(runId);
		const root = reciprocalWorkflowRootRunId(this.runById, runId);
		this.roots.set(runId, root);
		return root;
	}

	hopsOf(runId: string): readonly WorkflowBoundaryHop[] | undefined {
		if (this.hops.has(runId)) return this.hops.get(runId);
		const hops = boundaryHops(this.runById, runId);
		this.hops.set(runId, hops);
		return hops;
	}
}

function boundaryHops(
	runById: ReadonlyMap<string, RunSnapshot>,
	runId: string,
): readonly WorkflowBoundaryHop[] | undefined {
	const hops: WorkflowBoundaryHop[] = [];
	let current = runById.get(runId);
	while (current !== undefined && current.parentRunId !== undefined) {
		const parent = runById.get(current.parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === current?.parentStageId);
		if (parent === undefined || boundary === undefined) return undefined;
		hops.unshift({ name: boundary.name, runId: current.id });
		current = parent;
	}
	return current === undefined ? undefined : hops;
}

/** One field of a run's lineage: an id, or whether its parent run exists. */
type LineageValue = string | boolean | undefined;

function sameValues<Value>(left: readonly Value[], right: readonly Value[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
	return true;
}

/** A sticky target and the root's sticky entries that address it, in pending-list order. */
interface TargetState {
	readonly target: string;
	/** Parsed segments when the target addresses this root, else `undefined`. */
	readonly segments: readonly string[] | undefined;
	/** Index into the root-owned patterns, or -1 when the target is not this root's. */
	readonly pattern: number;
	entries: PendingStageMessage[];
	/** Pending-list position of each entry. */
	positions: number[];
	queued: number;
	/** Status stages that match this target, in announcement order. */
	stages: StatusStage[];
	statuses: readonly StickyStageDeliveryStatus[];
	dirty: boolean;
}

/** A computed status and what it was computed from. */
interface CachedStatus {
	readonly fields: StageFields;
	readonly generation: number;
	readonly epoch: number;
	readonly status: StickyStageDeliveryStatus;
}

/** One stage that can carry sticky delivery statuses, as seen by the last announcement. */
interface StatusStage {
	readonly run: RunSnapshot;
	readonly stage: StageSnapshot;
	readonly resolved: boolean;
	readonly hops: readonly WorkflowBoundaryHop[] | undefined;
	ordinal: number;
}

/** The fields of a stage that its delivery statuses read. */
interface StageFields {
	readonly run: RunSnapshot;
	readonly status: string;
	readonly error: string | undefined;
	readonly sessionId: string | undefined;
	readonly pendingStageDeliveryAvailable: boolean | undefined;
	readonly resolved: boolean;
	readonly hops: readonly WorkflowBoundaryHop[] | undefined;
	readonly id: string;
	readonly name: string;
	/** Patterns already tested against this stage, and the targets among them that match it. */
	tested: number;
	matched: TargetState[];
}

/**
 * Possible-future route rows of one root run, kept up to date across announcements.
 *
 * Every announcement used to recompute the delivery state of every sticky entry on every matching stage.
 * The rows now reuse each target's statuses until something they read changes: the target's entries,
 * the stages that match it, a field of one of those stages, or a delivery receipt of one of its
 * messages. Rows and status lists that did not change keep their object identity, so a caller can
 * compare announcements by identity instead of serializing every status. The result equals
 * recomputing every row from scratch and bounding each row's delivery states.
 */
export class PossibleStageRowsIndex {
	private readonly rootRunId: string;
	private readonly topology: WorkflowTopologyIndex;
	private readonly targets = new Map<string, TargetState>();
	/** Root-owned targets in pattern order; patterns are only ever added. */
	private readonly patterns: TargetState[] = [];
	private readonly targetOf = new Map<PendingStageMessage, TargetState>();
	private readonly targetsByMessage = new Map<string, Set<TargetState>>();
	private list: readonly PendingStageMessage[] = [];
	private readonly stageFields = new WeakMap<StageSnapshot, StageFields>();
	private backend: DurableWorkflowBackend | undefined;
	private receiptCursor: PendingStageReceiptCursor | undefined;
	private readonly scanMatches = new Map<string, Map<TargetState, boolean>>();
	/** Each slot's last row and the unbounded statuses it was built from. */
	private readonly rowCache = new Map<
		string,
		{ readonly row: PossibleStageRow; readonly statuses: readonly StickyStageDeliveryStatus[] | undefined }
	>();
	private readonly boundedStates = new WeakMap<
		readonly StickyStageDeliveryStatus[],
		BoundedStickyDeliveryStates<PossibleStageDeliveryState>
	>();
	private readonly deliveriesByEntry = new WeakMap<PendingStageMessage, Map<string, PendingStageMessageDelivery[]>>();
	/** Each entry's last status per stage, valid while the stage's fields and the message's receipts hold. */
	private readonly statusCache = new WeakMap<PendingStageMessage, Map<StageSnapshot, CachedStatus>>();
	/** Bumped when every receipt may have changed; per-message epochs count receipt changes since. */
	private receiptGeneration = 0;
	private readonly receiptEpochs = new Map<string, number>();

	constructor(rootRunId: string, topology: WorkflowTopologyIndex) {
		this.rootRunId = rootRunId;
		this.topology = topology;
	}

	/**
	 * Rows equal to recomputing every row from scratch, with each row's delivery states bounded by
	 * {@link boundStickyDeliveryStates}. Call `topology.refresh(runs)` first.
	 */
	rows(
		runs: readonly RunSnapshot[],
		rootRun: RunSnapshot,
		availableBackend: DurableWorkflowBackend | undefined,
	): readonly PossibleStageRow[] {
		if (isTerminalRunStatus(rootRun.status)) return [];
		this.refreshEntries(rootRun.pendingStageMessages ?? []);
		const resolvedBackend = availableRunDurableBackend(runs, this.rootRunId) ?? availableBackend;
		const backend =
			resolvedBackend === undefined ? undefined : durableBackendForRun(resolvedBackend, runs, this.rootRunId);
		this.refreshReceipts(backend);
		this.refreshStages(runs);
		for (const state of this.patterns) if (state.dirty) this.recompute(state, backend);
		return this.assemble(runs, rootRun);
	}

	private targetFor(entry: PendingStageMessage): TargetState {
		const target = entry.targetPath ?? entry.stageKey;
		let state = this.targets.get(target);
		if (state === undefined) {
			const parsed = parseWorkflowStageTarget(target);
			const owned = parsed?.rootRunId === this.rootRunId;
			state = {
				target,
				segments: owned ? parsed.segments : undefined,
				pattern: owned ? this.patterns.length : -1,
				entries: [],
				positions: [],
				queued: 0,
				stages: [],
				statuses: [],
				dirty: true,
			};
			this.targets.set(target, state);
			if (owned) this.patterns.push(state);
		}
		return state;
	}

	/** Track the root's sticky entries per target, touching only the positions that changed. */
	private refreshEntries(list: readonly PendingStageMessage[]): void {
		const previous = this.list;
		if (list === previous) return;
		this.list = list;
		let incremental = list.length >= previous.length;
		const replaced: number[] = [];
		for (let index = 0; incremental && index < previous.length; index++) {
			if (list[index] === previous[index]) continue;
			const before = previous[index]!;
			const after = list[index]!;
			if (before.sticky !== true && after.sticky !== true) continue;
			if (
				before.sticky !== true ||
				after.sticky !== true ||
				(before.targetPath ?? before.stageKey) !== (after.targetPath ?? after.stageKey)
			) {
				incremental = false;
				break;
			}
			replaced.push(index);
		}
		if (!incremental) {
			this.rebuildEntries(list);
			return;
		}
		for (const index of replaced) {
			const before = previous[index]!;
			const after = list[index]!;
			const state = this.targetOf.get(before)!;
			const slot = state.entries.indexOf(before);
			state.entries[slot] = after;
			this.targetOf.delete(before);
			this.targetOf.set(after, state);
			state.queued += (after.status === "queued" ? 1 : 0) - (before.status === "queued" ? 1 : 0);
			if (before.id !== after.id) this.rebuildMessageIndex();
			state.dirty = true;
		}
		for (let index = previous.length; index < list.length; index++) this.addEntry(list[index]!, index);
	}

	private addEntry(entry: PendingStageMessage, position: number): void {
		if (entry.sticky !== true) return;
		const state = this.targetFor(entry);
		state.entries.push(entry);
		state.positions.push(position);
		if (entry.status === "queued") state.queued++;
		state.dirty = true;
		this.targetOf.set(entry, state);
		let targets = this.targetsByMessage.get(entry.id);
		if (targets === undefined) {
			targets = new Set();
			this.targetsByMessage.set(entry.id, targets);
		}
		targets.add(state);
	}

	private rebuildEntries(list: readonly PendingStageMessage[]): void {
		const before = new Map<TargetState, readonly PendingStageMessage[]>();
		for (const state of this.targets.values()) {
			before.set(state, state.entries);
			state.entries = [];
			state.positions = [];
			state.queued = 0;
		}
		this.targetOf.clear();
		this.targetsByMessage.clear();
		list.forEach((entry, position) => {
			this.addEntry(entry, position);
		});
		for (const state of this.targets.values()) {
			const previous = before.get(state);
			state.dirty ||= previous === undefined || !sameValues(previous, state.entries);
		}
	}

	private rebuildMessageIndex(): void {
		this.targetsByMessage.clear();
		for (const [entry, state] of this.targetOf) {
			let targets = this.targetsByMessage.get(entry.id);
			if (targets === undefined) {
				targets = new Set();
				this.targetsByMessage.set(entry.id, targets);
			}
			targets.add(state);
		}
	}

	/** Mark the targets of every message whose delivery receipts changed since the last announcement. */
	private refreshReceipts(backend: DurableWorkflowBackend | undefined): void {
		if (backend !== this.backend) {
			this.backend = backend;
			this.receiptCursor = undefined;
			this.invalidateReceipts();
		}
		if (backend?.hasCachedPendingStageDeliveryReceipt === undefined) return;
		const changes = backend.pendingStageDeliveryReceiptChanges?.(this.rootRunId, this.receiptCursor);
		if (changes === undefined) {
			// Receipts that are not versioned may change at any time.
			this.invalidateReceipts();
			return;
		}
		const firstRead = this.receiptCursor === undefined;
		this.receiptCursor = changes.cursor;
		if (changes.messageIds === undefined) {
			if (!firstRead) this.invalidateReceipts();
			return;
		}
		for (const messageId of changes.messageIds) {
			this.receiptEpochs.set(messageId, (this.receiptEpochs.get(messageId) ?? 0) + 1);
			for (const state of this.targetsByMessage.get(messageId) ?? []) state.dirty = true;
		}
	}

	private invalidateReceipts(): void {
		this.receiptGeneration++;
		this.receiptEpochs.clear();
		for (const state of this.patterns) state.dirty = true;
	}

	/**
	 * Walk the invocation's stages in announcement order, match new stages and new patterns, and mark the
	 * targets whose matching stages or stage fields changed.
	 */
	private refreshStages(runs: readonly RunSnapshot[]): void {
		const current = new Map<TargetState, StatusStage[]>();
		let ordinal = 0;
		for (const run of runs) {
			const root = this.topology.rootOf(run.id);
			if (run.id !== this.rootRunId && run.rootRunId !== this.rootRunId && root !== this.rootRunId) continue;
			const resolved = root === this.rootRunId;
			const hops = this.topology.hopsOf(run.id);
			for (const stage of run.stages) {
				if (
					stage.nodeKind === "tool" ||
					stage.replayKey?.startsWith("prompt:") === true ||
					stage.replayKey?.startsWith("workflow:") === true ||
					stage.workflowChildRun !== undefined ||
					stage.workflowChild !== undefined
				)
					continue;
				const fields = this.fieldsOf(run, stage, resolved, hops);
				const status: StatusStage = { run, stage, resolved, hops, ordinal: ordinal++ };
				for (const state of fields.matched) {
					const stages = current.get(state);
					if (stages === undefined) current.set(state, [status]);
					else stages.push(status);
				}
			}
		}
		for (const state of this.patterns) {
			const stages = current.get(state) ?? [];
			if (
				stages.length !== state.stages.length ||
				stages.some((status, index) => {
					const previous = state.stages[index]!;
					return previous.stage !== status.stage || previous.run !== status.run;
				})
			)
				state.dirty = true;
			state.stages = stages;
		}
	}

	/** A stage's tracked fields and matched targets, refreshed when they change. */
	private fieldsOf(
		run: RunSnapshot,
		stage: StageSnapshot,
		resolved: boolean,
		hops: readonly WorkflowBoundaryHop[] | undefined,
	): StageFields {
		let fields = this.stageFields.get(stage);
		const matchable = resolved && hops !== undefined;
		let changed = false;
		if (
			fields === undefined ||
			fields.run !== run ||
			fields.resolved !== resolved ||
			fields.hops !== hops ||
			fields.id !== stage.id ||
			fields.name !== stage.name ||
			fields.status !== stage.status ||
			fields.error !== stage.error ||
			fields.sessionId !== stage.sessionId ||
			fields.pendingStageDeliveryAvailable !== stage.pendingStageDeliveryAvailable
		) {
			const previous = fields;
			const sameMatching =
				previous !== undefined &&
				previous.run === run &&
				previous.resolved === resolved &&
				previous.hops === hops &&
				previous.id === stage.id &&
				previous.name === stage.name;
			fields = {
				run,
				status: stage.status,
				error: stage.error,
				sessionId: stage.sessionId,
				pendingStageDeliveryAvailable: stage.pendingStageDeliveryAvailable,
				resolved,
				hops,
				id: stage.id,
				name: stage.name,
				tested: sameMatching ? previous.tested : 0,
				matched: sameMatching ? previous.matched : [],
			};
			this.stageFields.set(stage, fields);
			changed = true;
		}
		if (fields.tested < this.patterns.length) {
			const added = this.patterns.slice(fields.tested);
			if (!matchable) fields.matched.push(...added);
			else {
				const index = createStagePathPatternIndex(added.map((state) => state.segments!));
				for (const position of index.matching(hops, [stage.id, stage.name])) fields.matched.push(added[position]!);
			}
			fields.tested = this.patterns.length;
		}
		// Statuses read these fields: every target the stage matches recomputes. Targets it stopped matching
		// see a different stage list and recompute too.
		if (changed) for (const state of fields.matched) state.dirty = true;
		return fields;
	}

	private recompute(state: TargetState, backend: DurableWorkflowBackend | undefined): void {
		state.dirty = false;
		const statuses: StickyStageDeliveryStatus[] = [];
		for (const { run, stage, resolved, hops } of state.stages) {
			const fields = this.stageFields.get(stage)!;
			for (const entry of state.entries) {
				let byStage = this.statusCache.get(entry);
				if (byStage === undefined) {
					byStage = new Map();
					this.statusCache.set(entry, byStage);
				}
				const epoch = this.receiptEpochs.get(entry.id) ?? 0;
				let cached = byStage.get(stage);
				if (
					cached === undefined ||
					cached.fields !== fields ||
					cached.generation !== this.receiptGeneration ||
					cached.epoch !== epoch
				) {
					cached = {
						fields,
						generation: this.receiptGeneration,
						epoch,
						status: this.status(entry, run, stage, resolved && hops !== undefined, backend),
					};
					byStage.set(stage, cached);
				}
				statuses.push(cached.status);
			}
		}
		if (!sameStatuses(statuses, state.statuses)) state.statuses = statuses;
	}

	private receiptsOf(
		entry: PendingStageMessage,
		runId: string,
		stageId: string,
	): readonly PendingStageMessageDelivery[] {
		let byStage = this.deliveriesByEntry.get(entry);
		if (byStage === undefined) {
			byStage = new Map();
			for (const delivery of entry.deliveries ?? []) {
				const key = `${delivery.runId}\u0000${delivery.stageId}`;
				const list = byStage.get(key);
				if (list === undefined) byStage.set(key, [delivery]);
				else list.push(delivery);
			}
			this.deliveriesByEntry.set(entry, byStage);
		}
		return byStage.get(`${runId}\u0000${stageId}`) ?? [];
	}

	/** One entry's delivery state on one stage, exactly as `stickyStageDeliveryStatuses` computes it. */
	private status(
		entry: PendingStageMessage,
		run: RunSnapshot,
		stage: StageSnapshot,
		matchable: boolean,
		backend: DurableWorkflowBackend | undefined,
	): StickyStageDeliveryStatus {
		const target = entry.targetPath ?? entry.stageKey;
		const receipts = this.receiptsOf(entry, run.id, stage.id);
		const delivered =
			backend?.hasCachedPendingStageDeliveryReceipt?.(
				this.rootRunId,
				entry.id,
				{ runId: run.id, stageId: stage.id, sessionId: stage.sessionId, admission: "context" },
				stage.sessionId === undefined,
			) === true ||
			receipts.some(
				(delivery) =>
					delivery.admission === "context" &&
					delivery.sessionId !== undefined &&
					(stage.sessionId === undefined || delivery.sessionId === stage.sessionId),
			);
		let state: StickyStageDeliveryStatus["state"];
		let reason: string;
		if (!matchable) {
			state = "root-unresolved";
			reason = "Repair reciprocal parent/boundary ownership before startup";
		} else if (delivered) {
			state = "delivered";
			reason = "Startup context admission confirmed; sticky subscription remains for future stages";
		} else if (["completed", "failed", "skipped"].includes(stage.status)) {
			state = "stage-terminal";
			reason = `${stage.error ? `${stage.error}; ` : ""}Stage ended without confirmed context admission; steer a live stage or start a new stage`;
		} else if (
			receipts.some(
				(delivery) =>
					delivery.admission !== "context" &&
					(delivery.sessionId === undefined ||
						stage.sessionId === undefined ||
						delivery.sessionId === stage.sessionId),
			)
		) {
			state = "receipt-unverified";
			reason = "Live delivery receipt only; inspect the session transcript to confirm context admission";
		} else if (stage.pendingStageDeliveryAvailable !== true) {
			state = "delivery-unavailable";
			reason = "Stage has no pre-start Intercom helper; enable Intercom in the invocation group";
		} else if (receipts.length > 0) {
			state = "session-replaced";
			reason = "Only a previous session has a receipt; replacement must drain before its first turn";
		} else {
			state = "queued";
			reason = "No delivery receipt; stage startup must drain before its first turn";
		}
		return {
			messageId: entry.message.id,
			target,
			runId: run.id,
			stageId: stage.id,
			...(stage.sessionId === undefined ? {} : { sessionId: stage.sessionId }),
			state,
			reason,
		};
	}

	/** Assemble the rows in the order `possibleStageRows` produces them, reusing unchanged row objects. */
	private assemble(runs: readonly RunSnapshot[], rootRun: RunSnapshot): readonly PossibleStageRow[] {
		const rows: {
			readonly slot: string;
			readonly target: string;
			readonly queuedCount: number;
			readonly deliveryOnly?: true;
		}[] = [];
		const scanTargets = [...this.targets.values()].filter(
			(state) =>
				state.queued > 0 &&
				state.segments !== undefined &&
				!(state.segments.length === 1 && state.segments[0] === "**"),
		);
		let liveStageMatches: ((segments: readonly string[]) => boolean) | undefined;
		const rowTargets = new Set<string>();
		for (const [position, scanEntry] of (rootRun.possibleStages ?? []).entries()) {
			const rowSegments = splitStagePathSegments(scanEntry);
			if (rowSegments.length === 0 || rowSegments.some((segment) => segment.length === 0)) continue;
			if (!rowSegments.some((segment) => segment.includes("*"))) {
				liveStageMatches ??= this.materializedStageMatcher(runs);
				if (liveStageMatches(rowSegments)) continue;
			}
			let matches = this.scanMatches.get(scanEntry);
			if (matches === undefined) {
				matches = new Map();
				this.scanMatches.set(scanEntry, matches);
			}
			let queuedCount = 0;
			for (const state of scanTargets) {
				let match = matches.get(state);
				if (match === undefined) {
					const segments = state.segments!;
					match = matchStagePathSegments(rowSegments, segments) || matchStagePathSegments(segments, rowSegments);
					matches.set(state, match);
				}
				if (match) queuedCount += state.queued;
			}
			const target = formatWorkflowStageTarget(this.rootRunId, ...rowSegments);
			rows.push({ slot: `s${position}`, target, queuedCount });
			rowTargets.add(target);
		}
		let broadcastCount = 0;
		for (const state of this.targets.values()) {
			if (state.segments?.length === 1 && state.segments[0] === "**") broadcastCount += state.queued;
		}
		const broadcast = formatWorkflowStageTarget(this.rootRunId, "**");
		rows.push({ slot: "b", target: broadcast, queuedCount: broadcastCount });
		rowTargets.add(broadcast);
		// Status targets in the order of their first status: first matching stage, then first entry.
		const statusTargets = this.patterns
			.filter((state) => state.statuses.length > 0)
			.sort(
				(left, right) =>
					left.stages[0]!.ordinal - right.stages[0]!.ordinal || left.positions[0]! - right.positions[0]!,
			);
		const statusesByTarget = new Map(statusTargets.map((state) => [state.target, state.statuses]));
		for (const state of statusTargets) {
			if (rowTargets.has(state.target)) continue;
			rowTargets.add(state.target);
			rows.push({ slot: `d${state.target}`, target: state.target, queuedCount: state.queued, deliveryOnly: true });
		}
		const result = rows.map((row) =>
			this.row(row.slot, row.target, row.queuedCount, statusesByTarget.get(row.target), row.deliveryOnly),
		);
		this.pruneRows(result);
		return result;
	}

	/** The row for one slot of the announcement, reusing the previous object while its content is unchanged. */
	private row(
		slot: string,
		target: string,
		queuedCount: number,
		deliveryStates: readonly StickyStageDeliveryStatus[] | undefined,
		deliveryOnly?: true,
	): PossibleStageRow {
		const cached = this.rowCache.get(slot);
		const same =
			cached !== undefined &&
			cached.row.target === target &&
			cached.row.queuedCount === queuedCount &&
			cached.row.deliveryOnly === deliveryOnly;
		if (same && cached.statuses === deliveryStates) return cached.row;
		const bounded = deliveryStates === undefined ? undefined : this.bounded(deliveryStates);
		// A change the bound hides (an omitted state) leaves the announced row as it was.
		if (same && sameBoundedRow(cached.row, bounded)) {
			this.rowCache.set(slot, { row: cached.row, statuses: deliveryStates });
			return cached.row;
		}
		const row: PossibleStageRow = {
			target,
			queuedCount,
			...(deliveryOnly === true ? { deliveryOnly } : {}),
			...bounded,
		};
		this.rowCache.set(slot, { row, statuses: deliveryStates });
		return row;
	}

	private bounded(
		states: readonly StickyStageDeliveryStatus[],
	): BoundedStickyDeliveryStates<PossibleStageDeliveryState> {
		let bounded = this.boundedStates.get(states);
		if (bounded === undefined) {
			bounded = boundPossibleStageDeliveryStates(states);
			this.boundedStates.set(states, bounded);
		}
		return bounded;
	}

	private pruneRows(rows: readonly PossibleStageRow[]): void {
		if (this.rowCache.size <= rows.length * 4 + 16) return;
		const kept = new Set(rows);
		for (const [key, cached] of this.rowCache) if (!kept.has(cached.row)) this.rowCache.delete(key);
	}

	private materializedStageMatcher(runs: readonly RunSnapshot[]): (segments: readonly string[]) => boolean {
		const invocationRuns = runs.filter((run) => this.topology.rootOf(run.id) === this.rootRunId);
		return (entrySegments) => {
			for (const run of invocationRuns) {
				const hops = this.topology.hopsOf(run.id);
				if (hops === undefined) continue;
				for (const stage of run.stages) {
					if (stage.pendingStageDeliveryAvailable !== true) continue;
					if (
						stage.status !== "pending" &&
						stage.status !== "running" &&
						stage.status !== "awaiting_input" &&
						stage.status !== "paused" &&
						stage.status !== "blocked"
					) {
						continue;
					}
					if (stageMatchesPathPattern(entrySegments, hops, [stage.id, stage.name])) return true;
				}
			}
			return false;
		};
	}
}

function sameBoundedRow(
	row: PossibleStageRow,
	bounded: BoundedStickyDeliveryStates<PossibleStageDeliveryState> | undefined,
): boolean {
	if (bounded === undefined) return row.deliveryStates === undefined;
	if (row.deliveryStates === undefined || row.omittedDeliveryStates !== bounded.omittedDeliveryStates) return false;
	const counts = Object.entries(row.deliveryStateCounts ?? {});
	const boundedCounts = Object.entries(bounded.deliveryStateCounts ?? {});
	if (
		counts.length !== boundedCounts.length ||
		counts.some(([state, count], index) => boundedCounts[index]![0] !== state || boundedCounts[index]![1] !== count)
	)
		return false;
	return sameStatuses(row.deliveryStates, bounded.deliveryStates);
}

/** Field-by-field equality of two status lists; a list without targets compares equal targets as absent. */
function sameStatuses(
	left: readonly PossibleStageDeliveryState[],
	right: readonly PossibleStageDeliveryState[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const a = left[index]! as Partial<StickyStageDeliveryStatus>;
		const b = right[index]! as Partial<StickyStageDeliveryStatus>;
		if (
			a.messageId !== b.messageId ||
			a.target !== b.target ||
			a.runId !== b.runId ||
			a.stageId !== b.stageId ||
			a.sessionId !== b.sessionId ||
			a.state !== b.state ||
			a.reason !== b.reason
		)
			return false;
	}
	return true;
}
