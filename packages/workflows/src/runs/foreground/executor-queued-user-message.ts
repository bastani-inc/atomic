import type { StageSessionEvent } from "./stage-runner-types.js";

interface QueueSnapshot {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

function removedMessages(before: readonly string[], after: readonly string[]): string[] {
  const remaining = [...after];
  const removed: string[] = [];
  for (const message of before) {
    const index = remaining.indexOf(message);
    if (index === -1) removed.push(message);
    else remaining.splice(index, 1);
  }
  return removed;
}

function userMessageText(event: StageSessionEvent): string | undefined {
  if (event.type !== "message_start" || event.message.role !== "user") return undefined;
  const { content } = event.message;
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Arms only when a user message is consumed inside an SDK agent run. The
 * prompt that starts a run is its first user message; later user messages are
 * steering/follow-up deliveries. Queue-removal correlation also recognizes a
 * queued message consumed as the first user message of a follow-on
 * `agent.continue()` run.
 *
 * Queue additions and clears never arm by themselves. Candidate removals are
 * retained across intervening events but discarded at run boundaries, which
 * avoids both extension-event ordering races and stale matches in later idle
 * prompts.
 */
export function createQueuedUserMessageConsumptionWatcher(
  armContinuation: () => void,
): (event: StageSessionEvent) => void {
  let snapshot: QueueSnapshot = { steering: [], followUp: [] };
  let consumptionCandidates: string[] = [];
  let userMessageSeenInAgentRun = false;

  return (event): void => {
    if (event.type === "queue_update") {
      consumptionCandidates.push(
        ...removedMessages(snapshot.steering, event.steering),
        ...removedMessages(snapshot.followUp, event.followUp),
      );
      snapshot = { steering: [...event.steering], followUp: [...event.followUp] };
      return;
    }
    if (event.type === "agent_start") {
      consumptionCandidates = [];
      userMessageSeenInAgentRun = false;
      return;
    }
    if (event.type === "agent_end") {
      consumptionCandidates = [];
      userMessageSeenInAgentRun = false;
      return;
    }

    const text = userMessageText(event);
    if (text === undefined) return;
    const candidateIndex = consumptionCandidates.indexOf(text);
    if (userMessageSeenInAgentRun || candidateIndex !== -1) armContinuation();
    if (candidateIndex !== -1) consumptionCandidates.splice(candidateIndex, 1);
    userMessageSeenInAgentRun = true;
  };
}
