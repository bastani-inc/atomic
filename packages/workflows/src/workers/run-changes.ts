import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";

/** A run's own fields: all of it but its stages, its tool nodes and the queue of stage messages the root owns. */
export type RunHeader = Omit<RunSnapshot, "stages" | "toolNodes" | "pendingStageMessages">;

/**
 * What changed in one run since its attempt last published it (#4317): the run's own fields when any of them changed,
 * and the stages and tool nodes that changed or were added since, in run order. A publication that removes, reorders
 * or relinks anything, or changes a stage another published run hangs from, carries its runs in full instead.
 */
export interface RunChanges {
	readonly kind: "changes";
	readonly id: string;
	readonly header?: RunHeader;
	readonly stages: readonly StageSnapshot[];
	readonly toolNodes: readonly ToolNodeSnapshot[];
}

/** One run of an attempt's publication: in full, or what changed since the attempt last published it. */
export type PublishedRun = RunSnapshot | RunChanges;

export function isRunChanges(run: PublishedRun): run is RunChanges {
	return (run as Partial<RunChanges>).kind === "changes";
}

interface SentNodes {
	readonly order: readonly string[];
	/** Each node's serialized form, by id: what the root holds for it. */
	readonly signatures: ReadonlyMap<string, string>;
}

interface SentRun {
	readonly parentRunId: string | undefined;
	readonly parentStageId: string | undefined;
	readonly rootRunId: string | undefined;
	readonly header: string;
	readonly stages: SentNodes;
	readonly toolNodes: SentNodes;
}

interface SentAttempt {
	readonly generation: number;
	readonly runs: ReadonlyMap<string, SentRun>;
}

/**
 * Turns each attempt's latest publication into what the root needs to bring its copy up to date (#4317).
 *
 * A worker publishes every run it holds whenever anything in it changes, so a long-running child sends thousands of
 * stages that the root already holds. The encoder remembers what it last sent for each attempt and sends the runs in
 * full only when the attempt is new to it or a run's shape changed; otherwise it sends only the runs that changed, and
 * only what changed in them. The first run is always named, so a publication of changes is never empty. The root
 * applies publications in the order they were sent and refuses every later publication of an attempt it refused
 * once, so each change applies to the copy it was computed against.
 */
export class RunChangesEncoder {
	private readonly sent = new Map<string, SentAttempt>();

	encode(
		work: { readonly id: string; readonly generation: number },
		runs: readonly RunSnapshot[],
	): readonly PublishedRun[] {
		const previous = this.sent.get(work.id);
		const current = new Map<string, SentRun>();
		for (const run of runs) current.set(run.id, sentRun(run));
		this.sent.set(work.id, { generation: work.generation, runs: current });
		if (previous?.generation !== work.generation || !sameRuns(previous.runs, runs)) return runs;
		const parents = new Set(runs.map((run) => parentKey(run.parentRunId, run.parentStageId)));
		const changes: RunChanges[] = [];
		for (const [index, run] of runs.entries()) {
			const change = changesOf(run, previous.runs.get(run.id)!, current.get(run.id)!, parents);
			if (change === undefined) return runs;
			if (index === 0 || change.header !== undefined || change.stages.length + change.toolNodes.length > 0)
				changes.push(change);
		}
		return changes;
	}

	/** Drops what was sent for an attempt that ended, so its next publication, if any, goes in full. */
	forget(workId: string): void {
		this.sent.delete(workId);
	}
}

function sentRun(run: RunSnapshot): SentRun {
	const { stages, toolNodes, pendingStageMessages: _queue, ...header } = run;
	return {
		parentRunId: run.parentRunId,
		parentStageId: run.parentStageId,
		rootRunId: run.rootRunId,
		header: JSON.stringify(header),
		stages: sentNodes(stages),
		toolNodes: sentNodes(toolNodes),
	};
}

function sentNodes(nodes: readonly { readonly id: string }[]): SentNodes {
	const signatures = new Map<string, string>();
	for (const node of nodes) signatures.set(node.id, JSON.stringify(node));
	return { order: nodes.map((node) => node.id), signatures };
}

function sameRuns(previous: ReadonlyMap<string, SentRun>, runs: readonly RunSnapshot[]): boolean {
	if (previous.size !== runs.length) return false;
	let index = 0;
	for (const id of previous.keys()) if (runs[index++]!.id !== id) return false;
	return true;
}

function parentKey(runId: string | undefined, stageId: string | undefined): string {
	return JSON.stringify([runId, stageId]);
}

/** The changes from `before` to `after`, or undefined when the run must go in full. */
function changesOf(
	run: RunSnapshot,
	before: SentRun,
	after: SentRun,
	parents: ReadonlySet<string>,
): RunChanges | undefined {
	if (
		before.parentRunId !== after.parentRunId ||
		before.parentStageId !== after.parentStageId ||
		before.rootRunId !== after.rootRunId
	)
		return undefined;
	const stages = changedNodes(run.stages, before.stages, after.stages, (stage) =>
		parents.has(parentKey(run.id, stage.id)),
	);
	const toolNodes = changedNodes(run.toolNodes, before.toolNodes, after.toolNodes, () => false);
	if (stages === undefined || toolNodes === undefined) return undefined;
	const { stages: _stages, toolNodes: _tools, pendingStageMessages: _queue, ...header } = run;
	return {
		kind: "changes",
		id: run.id,
		...(before.header === after.header ? {} : { header }),
		stages,
		toolNodes,
	};
}

/**
 * The nodes that changed or were added, or undefined when one was removed, moved or duplicated, or a changed node is
 * one that must not change in place.
 */
function changedNodes<T extends { readonly id: string }>(
	nodes: readonly T[],
	before: SentNodes,
	after: SentNodes,
	pinned: (node: T) => boolean,
): T[] | undefined {
	if (after.signatures.size !== after.order.length || after.order.length < before.order.length) return undefined;
	const changed: T[] = [];
	for (let index = 0; index < after.order.length; index++) {
		const id = after.order[index]!;
		const added = index >= before.order.length;
		if (!added && before.order[index] !== id) return undefined;
		if (!added && before.signatures.get(id) === after.signatures.get(id)) continue;
		const node = nodes[index]!;
		if (pinned(node)) return undefined;
		changed.push(node);
	}
	return changed;
}
