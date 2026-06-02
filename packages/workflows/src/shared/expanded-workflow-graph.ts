import type {
  RunSnapshot,
  StageSnapshot,
  StoreSnapshot,
} from "./store-types.js";

export interface ExpandedWorkflowStageTarget {
  readonly runId: string;
  readonly stageId: string;
  readonly runName: string;
  readonly depth: number;
}

export interface ExpandedWorkflowStage extends StageSnapshot {
  readonly workflowGraphTarget: ExpandedWorkflowStageTarget;
}

export interface ExpandedWorkflowGraph {
  readonly stages: readonly ExpandedWorkflowStage[];
  readonly targets: ReadonlyMap<string, ExpandedWorkflowStageTarget>;
}

interface ExpandedRunResult {
  readonly stages: ExpandedWorkflowStage[];
  readonly terminalIds: readonly string[];
}

function virtualStageId(runId: string, stageId: string, isRootRun: boolean): string {
  return isRootRun ? stageId : `${runId}:${stageId}`;
}

function childRunIdFor(stage: StageSnapshot): string | undefined {
  return stage.workflowChildRun?.runId ?? stage.workflowChild?.runId;
}

function childAliasFor(stage: StageSnapshot): string | undefined {
  return stage.workflowChildRun?.alias ?? stage.workflowChild?.alias;
}

function localTerminalStageIds(stages: readonly StageSnapshot[]): readonly string[] {
  const parentIds = new Set<string>();
  for (const stage of stages) {
    for (const parentId of stage.parentIds) parentIds.add(parentId);
  }
  const terminals = stages
    .filter((stage) => !parentIds.has(stage.id))
    .map((stage) => stage.id);
  return terminals.length > 0 ? terminals : stages.map((stage) => stage.id);
}

/**
 * Build a view-only expanded graph for a run and any nested child workflow
 * runs it references. Child stages are cloned with virtual ids so their local
 * parent ids do not collide with parent-run stage ids; each virtual node keeps
 * a target mapping back to the actual `{ runId, stageId }` for attach/control.
 *
 * Imported workflows are flattened: a boundary stage that wraps a child run
 * with its own stages is NOT emitted as its own node. Instead the child's
 * stages stand in for it, so a nested workflow reads as a flat layout with no
 * extra "information" node marking the import boundary. The boundary's incoming
 * parents become the child roots' parents, and stages downstream of the
 * boundary rewire to the child's terminal stages. A boundary whose child run
 * produced no stages of its own is kept as a single node so the import stays
 * visible. Boundary stages are non-attachable, so dropping them loses no
 * interactive capability.
 */
export function expandWorkflowGraph(
  snapshot: StoreSnapshot,
  rootRunId: string,
): ExpandedWorkflowGraph {
  const runById = new Map(snapshot.runs.map((run) => [run.id, run]));
  const root = runById.get(rootRunId);
  if (!root) return { stages: [], targets: new Map() };

  const targets = new Map<string, ExpandedWorkflowStageTarget>();
  // Cycle guard only. This relies on the store invariant that each child run is
  // referenced by exactly one parent stage (runIds are unique and a child run
  // has a single boundary stage), so removing a run from `visiting` on exit
  // cannot double-expand a shared child into duplicate virtual stage ids. If
  // that invariant is ever relaxed, dedupe expanded stages by virtual id here.
  const visiting = new Set<string>();

  const expandRun = (
    run: RunSnapshot,
    depth: number,
    incomingParentIds: readonly string[],
  ): ExpandedRunResult => {
    if (visiting.has(run.id)) return { stages: [], terminalIds: [] };
    visiting.add(run.id);

    const isRootRun = run.id === rootRunId;
    const expandedStages: ExpandedWorkflowStage[] = [];
    const replacementTerminals = new Map<string, readonly string[]>();

    for (const stage of run.stages) {
      const id = virtualStageId(run.id, stage.id, isRootRun);
      const resolvedParentIds = stage.parentIds.length === 0
        ? [...incomingParentIds]
        : stage.parentIds.flatMap((parentId) =>
            replacementTerminals.get(parentId) ?? [virtualStageId(run.id, parentId, isRootRun)],
          );

      const childRunId = childRunIdFor(stage);
      const childRun = childRunId === undefined ? undefined : runById.get(childRunId);

      // Flatten the imported workflow in place: when the boundary wraps a child
      // run that has its own stages, splice those stages in instead of emitting
      // the boundary node. Child roots inherit the boundary's incoming parents,
      // and downstream stages rewire to the child's terminals below.
      if (childRun !== undefined && childRun.stages.length > 0) {
        const childExpanded = expandRun(childRun, depth + 1, resolvedParentIds);
        expandedStages.push(...childExpanded.stages);
        replacementTerminals.set(
          stage.id,
          childExpanded.terminalIds.length > 0 ? childExpanded.terminalIds : resolvedParentIds,
        );
        continue;
      }

      // Regular stage, or a boundary whose child produced no stages of its own:
      // emit it so the import still appears as exactly one node.
      const target: ExpandedWorkflowStageTarget = {
        runId: run.id,
        stageId: stage.id,
        runName: run.name,
        depth,
      };
      targets.set(id, target);
      expandedStages.push({
        ...stage,
        id,
        parentIds: Object.freeze(resolvedParentIds),
        workflowGraphTarget: target,
      });
    }

    const terminalIds = localTerminalStageIds(run.stages).flatMap((stageId) =>
      replacementTerminals.get(stageId) ?? [virtualStageId(run.id, stageId, isRootRun)],
    );

    visiting.delete(run.id);
    return { stages: expandedStages, terminalIds };
  };

  const expanded = expandRun(root, 0, []);
  return { stages: expanded.stages, targets };
}

export function expandedStageTarget(
  graph: ExpandedWorkflowGraph,
  virtualStageIdValue: string,
): ExpandedWorkflowStageTarget | undefined {
  return graph.targets.get(virtualStageIdValue);
}

export function stageMatchesExpandedIdentifier(
  stage: ExpandedWorkflowStage,
  target: string,
): boolean {
  return (
    stage.id === target ||
    stage.name === target ||
    stage.id.startsWith(target) ||
    stage.workflowGraphTarget.stageId === target ||
    stage.workflowGraphTarget.stageId.startsWith(target) ||
    stage.workflowGraphTarget.runId === target ||
    stage.workflowGraphTarget.runId.startsWith(target)
  );
}

export function expandedStageLabel(stage: ExpandedWorkflowStage): string {
  const runPrefix = stage.workflowGraphTarget.runId.slice(0, 8);
  const stagePrefix = stage.workflowGraphTarget.stageId.slice(0, 8);
  const depthPrefix = stage.workflowGraphTarget.depth > 0
    ? `${childAliasFor(stage) ?? stage.workflowGraphTarget.runName}:`
    : "";
  return `${depthPrefix}${stage.name} (${runPrefix}/${stagePrefix})`;
}
