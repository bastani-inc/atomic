import { APP_NAME, getEnvValue } from "@bastani/atomic";
import type { Message } from "./types.js";

const ENV_PREFIX = APP_NAME.toUpperCase();
const SUBAGENT_RUN_ID_ENV = `${ENV_PREFIX}_SUBAGENT_RUN_ID`;
const SUBAGENT_CHILD_AGENT_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_AGENT`;
const SUBAGENT_CHILD_INDEX_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_INDEX`;

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

export function readSubagentMessageSource(): Message["source"] | undefined {
  return buildSubagentMessageSource(
    getEnvValue(SUBAGENT_RUN_ID_ENV),
    getEnvValue(SUBAGENT_CHILD_AGENT_ENV),
    getEnvValue(SUBAGENT_CHILD_INDEX_ENV),
  );
}
