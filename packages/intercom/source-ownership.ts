import { type SubagentChildPolicy } from "@bastani/atomic";
import type { Message } from "./types.js";

export function buildSubagentMessageSource(
  runIdValue: string | undefined,
  agentValue: string | undefined,
  indexValue: string | undefined,
): Message["source"] | undefined {
  const subagentRunId = runIdValue?.trim();
  if (!subagentRunId) return undefined;
  const subagentAgent = agentValue?.trim();
  const rawIndex = indexValue?.trim();
  const parsedIndex = rawIndex === undefined ? undefined : Number(rawIndex);
  const subagentIndex = parsedIndex !== undefined && Number.isInteger(parsedIndex) && parsedIndex >= 0
    ? parsedIndex : undefined;
  return {
    subagentRunId,
    ...(subagentAgent ? { subagentAgent } : {}),
    ...(subagentIndex !== undefined ? { subagentIndex } : {}),
  };
}

export function readSubagentMessageSource(policy?: SubagentChildPolicy): Message["source"] | undefined {
	const identity = policy?.intercom;
	if (!identity) return undefined;
	return {
		subagentRunId: identity.runId,
		subagentAgent: identity.agent,
		subagentIndex: identity.index,
	};
}
