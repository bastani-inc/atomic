/**
 * Every kind of input a stage of a shared pool takes through its input queue (#4310, #4391): an answer to a prompt it
 * raised, a read of the question it waits on, a stage chat user message, and an Intercom message.
 */
export const POOLED_STAGE_INPUT_KINDS = ["prompt-answer", "question-read", "user-message", "intercom-message"] as const;
export type PooledStageInputKind = (typeof POOLED_STAGE_INPUT_KINDS)[number];
