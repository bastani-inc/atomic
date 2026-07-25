export type ToolExecutionStartRoute<T> =
  | { status: "allow" }
  | { status: "reclaim"; tool: T }
  | { status: "ignore" };


/**
 * Tracks tool rows announced by the current assistant message separately from
 * unrelated tool executions. A malformed assistant end makes only those rows
 * temporarily reclaimable by the valid message_end -> tool_start event order.
 */
export class AssistantToolLifecycle<T> {
  private assistantTools = new Map<string, T>();
  private orphanedTools = new Map<string, T>();
  private reclaimedTools = new Map<string, T>();
  private retiredToolCallIds = new Set<string>();
  private assistantOpen = false;

  trackAssistantTool(toolCallId: string, tool: T): void {
    // A validated assistant announcement is the only event allowed to create
    // a new generation for an ID retired at a malformed lifecycle boundary.
    this.retiredToolCallIds.delete(toolCallId);
    this.assistantTools.set(toolCallId, tool);
  }

  beginAssistant(): ReadonlyArray<readonly [string, T]> {
    this.assistantOpen = true;
    const toolsToSettle = new Map([
      ...this.orphanedTools,
      ...this.reclaimedTools,
    ]);
    this.orphanedTools.clear();
    this.reclaimedTools.clear();
    for (const toolCallId of toolsToSettle.keys()) this.retire(toolCallId);
    return [...toolsToSettle];
  }

  isRetired(toolCallId: string): boolean {
    return this.retiredToolCallIds.has(toolCallId);
  }

  hasOpenAssistant(): boolean {
    return this.assistantOpen;
  }

  blocksUnroutedExecution(toolCallId: string): boolean {
    return this.orphanedTools.has(toolCallId) || this.retiredToolCallIds.has(toolCallId);
  }

  closeMalformedAssistant(isPending: (toolCallId: string, tool: T) => boolean): ReadonlyMap<string, T> {
    if (!this.assistantOpen) return this.orphanedTools;
    this.assistantOpen = false;
    this.orphanedTools.clear();
    for (const [toolCallId, tool] of this.assistantTools) {
      if (isPending(toolCallId, tool)) this.orphanedTools.set(toolCallId, tool);
    }
    this.assistantTools.clear();
    return this.orphanedTools;
  }

  routeExecutionStart(toolCallId: string): ToolExecutionStartRoute<T> {
    const tool = this.orphanedTools.get(toolCallId);
    if (tool !== undefined) {
      this.orphanedTools.delete(toolCallId);
      this.reclaimedTools.set(toolCallId, tool);
      return { status: "reclaim", tool };
    }
    return this.retiredToolCallIds.has(toolCallId)
      ? { status: "ignore" }
      : { status: "allow" };
  }

  completeExecution(toolCallId: string): void {
    this.reclaimedTools.delete(toolCallId);
  }

  closeValidAssistant(): void {
    this.assistantOpen = false;
    this.assistantTools.clear();
  }

  retireExecutions(toolCallIds: Iterable<string>): ReadonlyArray<readonly [string, T]> {
    const toolsToSettle = new Map([
      ...this.assistantTools,
      ...this.orphanedTools,
      ...this.reclaimedTools,
    ]);
    const allToolCallIds = new Set([
      ...toolCallIds,
      ...this.assistantTools.keys(),
      ...toolsToSettle.keys(),
    ]);
    for (const toolCallId of allToolCallIds) this.retire(toolCallId);
    this.assistantOpen = false;
    this.assistantTools.clear();
    this.orphanedTools.clear();
    this.reclaimedTools.clear();
    return [...toolsToSettle];
  }


  private retire(toolCallId: string): void {
    this.retiredToolCallIds.add(toolCallId);
  }

  reset(): void {
    this.assistantOpen = false;
    this.assistantTools.clear();
    this.orphanedTools.clear();
    this.reclaimedTools.clear();
    this.retiredToolCallIds.clear();
  }
}
