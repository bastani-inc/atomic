import type { RunSnapshot, StageSnapshot, StoreSnapshot, ToolNodeSnapshot } from "./store-types.js";

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
  /** Stage-compatible render projections; includes non-attachable tool cards. */
  readonly stages: readonly ExpandedWorkflowStage[];
  readonly tools: readonly ExpandedWorkflowTool[];
  readonly nodes: readonly ExpandedWorkflowNode[];
  /** Contains stage targets only. Tool nodes intentionally have no chat/control target. */
  readonly renderStages: readonly ExpandedWorkflowStage[];
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
    if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
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

function childRunIdFor(stage: StageSnapshot): string | undefined {
  if (isTerminalNonCompletedBoundary(stage)) return undefined;
  if (stage.status === "completed") return stage.workflowChild?.runId ?? stage.workflowChildRun?.runId;
  return stage.workflowChildRun?.runId;
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
  const visiting = new Set<string>();

  const expandRun = (run: RunSnapshot, depth: number, incomingParentIds: readonly string[]): ExpandedRunResult => {
    if (visiting.has(run.id)) return { stages: [], tools: [], nodes: [], terminalIds: [] };
    visiting.add(run.id);
    const isRootRun = run.id === rootRunId;
    const items = localItems(run);
    const stages: ExpandedWorkflowStage[] = [];
    const tools: ExpandedWorkflowTool[] = [];
    const nodes: ExpandedWorkflowNode[] = [];
    const replacementTerminals = new Map<string, readonly string[]>();

    for (const item of items) {
      const sourceId = itemId(item);
      const id = virtualNodeId(run.id, sourceId, isRootRun);
      const parents = itemParents(item);
      const resolvedParentIds = parents.length === 0
        ? [...incomingParentIds]
        : parents.flatMap((parentId) => replacementTerminals.get(parentId) ?? [virtualNodeId(run.id, parentId, isRootRun)]);

      if (item.kind === "tool") {
        const tool: ExpandedWorkflowTool = { ...item.tool, id, parentIds: Object.freeze(resolvedParentIds), runId: run.id, runName: run.name, depth };
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
        tools.push(tool);
        stages.push(projection);
        nodes.push({ kind: "tool", tool });
        continue;
      }

      const childRunId = childRunIdFor(item.stage);
      const childRun = childRunId === undefined ? undefined : runById.get(childRunId);
      if (childRun !== undefined && localItems(childRun).length > 0) {
        const childExpanded = expandRun(childRun, depth + 1, resolvedParentIds);
        stages.push(...childExpanded.stages);
        tools.push(...childExpanded.tools);
        nodes.push(...childExpanded.nodes);
        replacementTerminals.set(item.stage.id, childExpanded.terminalIds.length > 0 ? childExpanded.terminalIds : resolvedParentIds);
        continue;
      }

      const target: ExpandedWorkflowStageTarget = { runId: run.id, stageId: item.stage.id, runName: run.name, depth };
      targets.set(id, target);
      const stage: ExpandedWorkflowStage = { ...item.stage, id, parentIds: Object.freeze(resolvedParentIds), workflowGraphTarget: target };
      stages.push(stage);
      nodes.push({ kind: "stage", stage });
    }

    const terminalIds = localTerminalIds(items).flatMap((sourceId) =>
      replacementTerminals.get(sourceId) ?? [virtualNodeId(run.id, sourceId, isRootRun)]
    );
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

export function expandedStageTarget(graph: ExpandedWorkflowGraph, virtualStageIdValue: string): ExpandedWorkflowStageTarget | undefined {
  return graph.targets.get(virtualStageIdValue);
}

export function stageMatchesExpandedIdentifier(stage: ExpandedWorkflowStage, target: string): boolean {
  const graphTarget = stage.workflowGraphTarget;
  return stage.id === target || stage.name === target || stage.id.startsWith(target)
    || graphTarget.stageId === target || graphTarget.stageId.startsWith(target)
    || graphTarget.runId === target || graphTarget.runId.startsWith(target);
}

export function expandedStageLabel(stage: ExpandedWorkflowStage): string {
  const target = stage.workflowGraphTarget;
  if (stage.nodeKind === "tool") return `${stage.name} (tool)`;
  const runPrefix = target.runId.slice(0, 8);
  const stagePrefix = target.stageId.slice(0, 8);
  const depthPrefix = target.depth > 0 ? `${childAliasFor(stage) ?? target.runName}:` : "";
  return `${depthPrefix}${stage.name} (${runPrefix}/${stagePrefix})`;
}
