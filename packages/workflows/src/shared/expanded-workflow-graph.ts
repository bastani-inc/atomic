import type { RunSnapshot, StageSnapshot, StoreSnapshot, ToolNodeSnapshot } from "./store-types.js";
import { authoritativeWorkflowChildRunId, reciprocalWorkflowRootRunId } from "./workflow-run-ownership.js";

export interface ExpandedWorkflowStageTarget {
	readonly runId: string;
	readonly stageId: string;
	readonly runName: string;
	readonly depth: number;
}

export interface ExpandedWorkflowStage extends StageSnapshot {
	readonly workflowGraphTarget: ExpandedWorkflowStageTarget;
}

export interface ExpandedWorkflowTool extends ToolNodeSnapshot {
	readonly runId: string;
	readonly runName: string;
	readonly depth: number;
}

export type ExpandedWorkflowNode =
	| { readonly kind: "stage"; readonly stage: ExpandedWorkflowStage }
	| { readonly kind: "tool"; readonly tool: ExpandedWorkflowTool };

export interface ExpandedWorkflowGraph {
	/** Stage-only inspection/control nodes; excludes tool projections. */
	readonly stages: readonly ExpandedWorkflowStage[];
	readonly tools: readonly ExpandedWorkflowTool[];
	readonly nodes: readonly ExpandedWorkflowNode[];
	/** All stage-compatible render projections, including non-attachable tool cards. */
	readonly renderStages: readonly ExpandedWorkflowStage[];
	/**
	 * Control targets for stages and tool nodes. Tool entries are abort-only
	 * control targets: they stay `attachable: false` and never become chat
	 * targets (see `graph-view-state._stageChatTarget`).
	 */
	readonly targets: ReadonlyMap<string, ExpandedWorkflowStageTarget>;
}

interface ExpandedRunResult {
	readonly stages: ExpandedWorkflowStage[];
	readonly tools: ExpandedWorkflowTool[];
	readonly nodes: ExpandedWorkflowNode[];
	readonly terminalIds: readonly string[];
}

type LocalItem =
	| { readonly kind: "stage"; readonly stage: StageSnapshot; readonly sourceIndex: number }
	| { readonly kind: "tool"; readonly tool: ToolNodeSnapshot; readonly sourceIndex: number };

function virtualNodeId(runId: string, nodeId: string, isRootRun: boolean): string {
	return isRootRun ? nodeId : `${runId}:${nodeId}`;
}

function localItems(run: RunSnapshot): LocalItem[] {
	const stages = run.stages.map((stage, sourceIndex) => ({ kind: "stage" as const, stage, sourceIndex }));
	const tools = (run.toolNodes ?? []).map((tool, sourceIndex) => ({ kind: "tool" as const, tool, sourceIndex }));
	return [...stages, ...tools].sort((left, right) => {
		const leftOrder = left.kind === "stage" ? left.stage.executionOrder : left.tool.executionOrder;
		const rightOrder = right.kind === "stage" ? right.stage.executionOrder : right.tool.executionOrder;
		if (leftOrder !== undefined || rightOrder !== undefined)
			return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
		if (left.kind !== right.kind) return left.kind === "stage" ? -1 : 1;
		return left.sourceIndex - right.sourceIndex;
	});
}

function itemId(item: LocalItem): string {
	return item.kind === "stage" ? item.stage.id : item.tool.id;
}

function itemParents(item: LocalItem): readonly string[] {
	return item.kind === "stage" ? item.stage.parentIds : item.tool.parentIds;
}

function localTerminalIds(items: readonly LocalItem[]): readonly string[] {
	const parents = new Set(items.flatMap((item) => [...itemParents(item)]));
	const terminals = items.map(itemId).filter((id) => !parents.has(id));
	return terminals.length > 0 ? terminals : items.map(itemId);
}

function isTerminalNonCompletedBoundary(stage: StageSnapshot): boolean {
	return stage.status === "failed" || stage.status === "skipped";
}

function childAliasFor(stage: StageSnapshot): string | undefined {
	if (isTerminalNonCompletedBoundary(stage)) return undefined;
	if (stage.status === "completed") return stage.workflowChild?.alias ?? stage.workflowChildRun?.alias;
	return stage.workflowChildRun?.alias;
}

function projectedToolStatus(tool: ToolNodeSnapshot): StageSnapshot["status"] {
	if (tool.status === "cached") return "completed";
	if (tool.status === "cancelled") return "skipped";
	return tool.status;
}

export function expandWorkflowGraph(snapshot: StoreSnapshot, rootRunId: string): ExpandedWorkflowGraph {
	const runById = new Map(snapshot.runs.map((run) => [run.id, run]));
	const root = runById.get(rootRunId);
	if (!root) return { stages: [], renderStages: [], tools: [], nodes: [], targets: new Map() };
	const targets = new Map<string, ExpandedWorkflowStageTarget>();
	const rootOwnerByRunId = new Map<string, string | undefined>();
	const rootOwnerFor = (runId: string): string | undefined => {
		if (rootOwnerByRunId.has(runId)) return rootOwnerByRunId.get(runId);
		const owner = reciprocalWorkflowRootRunId(runById, runId);
		rootOwnerByRunId.set(runId, owner);
		return owner;
	};
	const visiting = new Set<string>();
	const expandedChildren = new Set<string>();

	const expandRun = (run: RunSnapshot, depth: number, incomingParentIds: readonly string[]): ExpandedRunResult => {
		if (visiting.has(run.id)) return { stages: [], tools: [], nodes: [], terminalIds: [] };
		visiting.add(run.id);
		const isRootRun = run.id === rootRunId;
		const items = localItems(run);
		const stages: ExpandedWorkflowStage[] = [];
		const tools: ExpandedWorkflowTool[] = [];
		const nodes: ExpandedWorkflowNode[] = [];
		const stageById = new Map(run.stages.map((stage) => [stage.id, stage]));
		const boundaryExpansions = new Map<string, ExpandedRunResult | null>();

		const validChildRunFor = (stage: StageSnapshot): RunSnapshot | undefined => {
			const childRunId = authoritativeWorkflowChildRunId(stage);
			if (childRunId === undefined) return undefined;
			const childRun = runById.get(childRunId);
			const runRoot = rootOwnerFor(run.id);
			if (
				childRun === undefined ||
				expandedChildren.has(childRun.id) ||
				localItems(childRun).length === 0 ||
				childRun.parentRunId !== run.id ||
				childRun.parentStageId !== stage.id ||
				runRoot === undefined ||
				rootOwnerFor(childRun.id) !== runRoot
			) {
				return undefined;
			}
			return childRun;
		};

		const resolvedParentIdsFor = (item: LocalItem): string[] => {
			const parentIds = itemParents(item);
			if (parentIds.length === 0) return [...incomingParentIds];
			return parentIds.flatMap((parentId) => {
				const parentStage = stageById.get(parentId);
				const parentExpansion = parentStage === undefined ? undefined : boundaryExpansionFor(parentStage);
				return parentExpansion?.terminalIds.length
					? [...parentExpansion.terminalIds]
					: [virtualNodeId(run.id, parentId, isRootRun)];
			});
		};

		const boundaryExpansionFor = (stage: StageSnapshot): ExpandedRunResult | undefined => {
			const cached = boundaryExpansions.get(stage.id);
			if (cached !== undefined) return cached ?? undefined;
			const childRun = validChildRunFor(stage);
			if (childRun === undefined) return undefined;
			boundaryExpansions.set(stage.id, null);
			expandedChildren.add(childRun.id);
			const stageItem: LocalItem = { kind: "stage", stage, sourceIndex: 0 };
			const childExpanded = expandRun(childRun, depth + 1, resolvedParentIdsFor(stageItem));
			if (childExpanded.stages.length === 0 || childExpanded.terminalIds.length === 0) return undefined;
			boundaryExpansions.set(stage.id, childExpanded);
			return childExpanded;
		};

		for (const item of items) {
			const sourceId = itemId(item);
			const id = virtualNodeId(run.id, sourceId, isRootRun);
			const resolvedParentIds = resolvedParentIdsFor(item);

			if (item.kind === "tool") {
				const tool: ExpandedWorkflowTool = {
					...item.tool,
					id,
					parentIds: Object.freeze(resolvedParentIds),
					runId: run.id,
					runName: run.name,
					depth,
				};
				const projectionTarget: ExpandedWorkflowStageTarget = {
					runId: run.id,
					stageId: item.tool.id,
					runName: run.name,
					depth,
				};
				const projection: ExpandedWorkflowStage = {
					id,
					name: item.tool.name,
					status: projectedToolStatus(item.tool),
					parentIds: Object.freeze(resolvedParentIds),
					executionOrder: item.tool.executionOrder,
					nodeKind: "tool",
					toolStatus: item.tool.status,
					startedAt: item.tool.startedAt,
					endedAt: item.tool.endedAt,
					result: item.tool.resultSummary,
					error: item.tool.error,
					toolEvents: [],
					attachable: false,
					workflowGraphTarget: projectionTarget,
				};
				targets.set(id, projectionTarget);
				tools.push(tool);
				stages.push(projection);
				nodes.push({ kind: "tool", tool });
				continue;
			}

			const childExpanded = boundaryExpansionFor(item.stage);
			if (childExpanded !== undefined) {
				stages.push(...childExpanded.stages);
				tools.push(...childExpanded.tools);
				nodes.push(...childExpanded.nodes);
				continue;
			}

			const target: ExpandedWorkflowStageTarget = {
				runId: run.id,
				stageId: item.stage.id,
				runName: run.name,
				depth,
			};
			targets.set(id, target);
			const stage: ExpandedWorkflowStage = {
				...item.stage,
				id,
				parentIds: Object.freeze(resolvedParentIds),
				workflowGraphTarget: target,
			};
			stages.push(stage);
			nodes.push({ kind: "stage", stage });
		}

		const terminalIds = localTerminalIds(items).flatMap((sourceId) => {
			const stage = stageById.get(sourceId);
			const replacement = stage === undefined ? undefined : boundaryExpansionFor(stage);
			return replacement?.terminalIds.length
				? [...replacement.terminalIds]
				: [virtualNodeId(run.id, sourceId, isRootRun)];
		});
		visiting.delete(run.id);
		return { stages, tools, nodes, terminalIds };
	};

	const expanded = expandRun(root, 0, []);
	return {
		stages: expanded.stages.filter((stage) => stage.nodeKind !== "tool"),
		renderStages: expanded.stages,
		tools: expanded.tools,
		nodes: expanded.nodes,
		targets,
	};
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

interface RefreshRunSources {
	readonly run: RunSnapshot;
	readonly stages: ReadonlyMap<string, StageSnapshot>;
	readonly tools: ReadonlyMap<string, ToolNodeSnapshot>;
}

function refreshRunSources(snapshot: StoreSnapshot): Map<string, RefreshRunSources> {
	return new Map(
		snapshot.runs.map((run) => [
			run.id,
			{
				run,
				stages: new Map(run.stages.map((stage) => [stage.id, stage])),
				tools: new Map((run.toolNodes ?? []).map((tool) => [tool.id, tool])),
			},
		]),
	);
}

export function sameExpandedWorkflowTopology(left: StoreSnapshot, right: StoreSnapshot): boolean {
	if (left.runs.length !== right.runs.length) return false;
	for (let runIndex = 0; runIndex < left.runs.length; runIndex++) {
		const a = left.runs[runIndex]!;
		const b = right.runs[runIndex]!;
		if (
			a.id !== b.id ||
			a.parentRunId !== b.parentRunId ||
			a.parentStageId !== b.parentStageId ||
			a.rootRunId !== b.rootRunId ||
			a.stages.length !== b.stages.length ||
			(a.toolNodes?.length ?? 0) !== (b.toolNodes?.length ?? 0)
		)
			return false;
		for (let stageIndex = 0; stageIndex < a.stages.length; stageIndex++) {
			const x = a.stages[stageIndex]!;
			const y = b.stages[stageIndex]!;
			const xChildRunId = authoritativeWorkflowChildRunId(x);
			const yChildRunId = authoritativeWorkflowChildRunId(y);
			if (
				x.id !== y.id ||
				x.executionOrder !== y.executionOrder ||
				x.nodeKind !== y.nodeKind ||
				// The authoritative id becomes undefined at failed/skipped boundaries,
				// so this comparison also catches a terminal-boundary flip.
				xChildRunId !== yChildRunId ||
				!sameIds(x.parentIds, y.parentIds)
			)
				return false;
		}
		const aTools = a.toolNodes ?? [];
		const bTools = b.toolNodes ?? [];
		for (let toolIndex = 0; toolIndex < aTools.length; toolIndex++) {
			const x = aTools[toolIndex]!;
			const y = bTools[toolIndex]!;
			if (x.id !== y.id || x.executionOrder !== y.executionOrder || !sameIds(x.parentIds, y.parentIds)) return false;
		}
	}
	return true;
}

export function refreshExpandedWorkflowGraph(
	graph: ExpandedWorkflowGraph,
	snapshot: StoreSnapshot,
): ExpandedWorkflowGraph | undefined {
	const sourcesByRunId = refreshRunSources(snapshot);
	const refreshedStages = new Map<string, ExpandedWorkflowStage>();
	const refreshedTools = new Map<string, ExpandedWorkflowTool>();
	const renderStages: ExpandedWorkflowStage[] = [];

	for (const cached of graph.renderStages) {
		const target = graph.targets.get(cached.id);
		const sources = target ? sourcesByRunId.get(target.runId) : undefined;
		if (!target || !sources) return undefined;
		if (cached.nodeKind === "tool") {
			const source = sources.tools.get(target.stageId);
			if (!source) return undefined;
			const stage: ExpandedWorkflowStage = {
				id: cached.id,
				name: source.name,
				status: projectedToolStatus(source),
				parentIds: cached.parentIds,
				executionOrder: source.executionOrder,
				nodeKind: "tool",
				toolStatus: source.status,
				startedAt: source.startedAt,
				endedAt: source.endedAt,
				result: source.resultSummary,
				error: source.error,
				toolEvents: [],
				attachable: false,
				workflowGraphTarget: target,
			};
			renderStages.push(stage);
			refreshedStages.set(stage.id, stage);
			continue;
		}
		const source = sources.stages.get(target.stageId);
		if (!source) return undefined;
		const stage: ExpandedWorkflowStage = {
			...source,
			id: cached.id,
			parentIds: cached.parentIds,
			workflowGraphTarget: target,
		};
		renderStages.push(stage);
		refreshedStages.set(stage.id, stage);
	}

	const stages = renderStages.filter((stage) => stage.nodeKind !== "tool");
	const tools: ExpandedWorkflowTool[] = [];

	for (const cached of graph.tools) {
		const target = graph.targets.get(cached.id);
		const sources = target ? sourcesByRunId.get(target.runId) : undefined;
		const source = target ? sources?.tools.get(target.stageId) : undefined;
		if (!target || !sources || !source) return undefined;
		const tool: ExpandedWorkflowTool = {
			...source,
			id: cached.id,
			parentIds: cached.parentIds,
			runId: sources.run.id,
			runName: sources.run.name,
			depth: target.depth,
		};
		tools.push(tool);
		refreshedTools.set(tool.id, tool);
	}

	const nodes: ExpandedWorkflowNode[] = [];
	for (const node of graph.nodes) {
		if (node.kind === "stage") {
			const stage = refreshedStages.get(node.stage.id);
			if (!stage) return undefined;
			nodes.push({ kind: "stage", stage });
			continue;
		}
		const tool = refreshedTools.get(node.tool.id);
		if (!tool) return undefined;
		nodes.push({ kind: "tool", tool });
	}
	return { stages, tools, nodes, renderStages, targets: graph.targets };
}

export function expandedStageTarget(
	graph: ExpandedWorkflowGraph,
	virtualStageIdValue: string,
): ExpandedWorkflowStageTarget | undefined {
	return graph.targets.get(virtualStageIdValue);
}

/**
 * Exact-match only. A stage id is never truncated to address a stage: at the
 * root that id is a bare UUID, nested it is the `runId:nodeId` composite built
 * by `virtualNodeId`, and a tool node carries `tool:<argsHash>`. Names match
 * whole, so `build` never selects `build-check`.
 */
export function stageMatchesExpandedIdentifier(stage: ExpandedWorkflowStage, target: string): boolean {
	const graphTarget = stage.workflowGraphTarget;
	return (
		stage.id === target || stage.name === target || graphTarget.stageId === target || graphTarget.runId === target
	);
}

export function expandedStageLabel(stage: ExpandedWorkflowStage): string {
	const target = stage.workflowGraphTarget;
	if (stage.nodeKind === "tool") return `${stage.name} (tool)`;
	const depthPrefix = target.depth > 0 ? `${childAliasFor(stage) ?? target.runName}:` : "";
	return `${depthPrefix}${stage.name} (${target.runId}/${target.stageId})`;
}
