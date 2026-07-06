import type { AgentSessionEvent } from "@bastani/atomic";

interface PendingToolExecution {
  start: AgentSessionEvent;
  update?: AgentSessionEvent;
}

function eventType(event: AgentSessionEvent): string {
  return String((event as { type?: unknown }).type ?? "");
}

function toolCallId(event: AgentSessionEvent): string | undefined {
  const value = (event as { toolCallId?: unknown }).toolCallId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class StageToolExecutionBuffer {
  private readonly pending = new Map<string, PendingToolExecution>();

  record(event: AgentSessionEvent): void {
    const type = eventType(event);
    if (type === "agent_start" || type === "agent_end") {
      this.pending.clear();
      return;
    }
    const id = toolCallId(event);
    if (id === undefined) return;
    if (type === "tool_execution_start") {
      this.pending.set(id, { start: event });
      return;
    }
    if (type === "tool_execution_update") {
      const existing = this.pending.get(id);
      if (existing) existing.update = event;
      return;
    }
    if (type === "tool_execution_end") this.pending.delete(id);
  }

  replayEvents(): readonly AgentSessionEvent[] {
    return [...this.pending.values()].flatMap((entry) => entry.update ? [entry.start, entry.update] : [entry.start]);
  }

  clear(): void {
    this.pending.clear();
  }
}
